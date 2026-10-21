import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error node:sqlite has no types under the Workers-only tsconfig; vitest runs this file in Node
import { DatabaseSync } from 'node:sqlite';
import { handleToolCall } from './tools';

// memory_judge against a real SQLite database (node:sqlite) behind a minimal D1 shim, with Vectorize
// and Workers AI stubbed. Regression coverage for 2026-10-21: the judge skipped every queued pair
// (its own pending_judge row counted as a verdict), so 2,253 pairs never drained; and any supersede
// verdict expired the older memory, including 35%/44% and cross-project ones.

type Verdict = { choice: string; confidence: number } | null;

function d1(db: DatabaseSync) {
  const stmt = (sql: string, params: unknown[] = []) => ({
    bind: (...p: unknown[]) => stmt(sql, p),
    first: async () => (db.prepare(sql).get(...(params as any[])) as any) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(params as any[])) as any[] }),
    run: async () => { db.prepare(sql).run(...(params as any[])); return { success: true }; },
  });
  return { prepare: (sql: string) => stmt(sql), batch: async (s: any[]) => Promise.all(s.map(x => x.run())) };
}

let db: DatabaseSync;
let jev: (a: string, b: string) => Verdict;
let neighbours: string[];
// Per-text neighbours: embeddings encode the text as an angle so the Vectorize stub knows which memory is querying.
let neighboursOf: Record<string, string[]>;
const texts: string[] = [];
// Optional fixed angles (radians) per text, to control which memories are close to which.
let angles: Record<string, number>;

function env() {
  return {
    DB: d1(db),
    KV: { get: async () => null, put: async () => {} },
    JEV_RERANK: 'on',
    VECTORIZE: {
      query: async (v: number[]) => {
        const a = Math.atan2(v[1], v[0]);
        const text = Object.keys(angles).find(t => Math.abs(angles[t] - a) < 1e-9) ?? texts[Math.round(a * 100)];
        return { matches: (neighboursOf[text] ?? neighbours).map(id => ({ id, score: 0.9 })) };
      },
    },
    AI: {
      run: async (model: string, input: any) => {
        if (model.includes('bge')) {
          const t = input.text[0];
          if (!texts.includes(t)) texts.push(t);
          const angle = angles[t] ?? texts.indexOf(t) / 100;
          return { data: [[Math.cos(angle), Math.sin(angle)]] };
        }
        if (model === 'typesafe/jev') {
          const [, a, b] = String(input.state).match(/Memory A[^"]*"([^"]*)"[\s\S]*Memory B[^"]*"([^"]*)"/) ?? [];
          const v = jev(a, b);
          if (!v) throw new Error('jev down');
          return { result: { answers: { rel: v } } };
        }
        return { response: 'not json' }; // Llama fallback that never parses
      },
    },
  } as any;
}

const mem = (id: string, text: string, ts: number, project = 'p1', extra = '') =>
  db.exec(`INSERT INTO memories (id, text, timestamp, project, valid_to, contradiction_flag) VALUES ('${id}', '${text}', ${ts}, '${project}', ${extra || 'NULL, 0'})`);
const rel = (from: string, to: string, type: string) =>
  db.exec(`INSERT INTO memory_relations (id, from_id, to_id, relation_type, confidence, reason, created_at) VALUES ('${from}-${to}-${type}', '${from}', '${to}', '${type}', 0.9, '', 1)`);
const row = (id: string) => db.prepare('SELECT valid_to, contradiction_flag FROM memories WHERE id = ?').get(id) as any;
const rels = (type: string) => db.prepare('SELECT from_id, to_id FROM memory_relations WHERE relation_type = ?').all(type) as any[];

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT, timestamp INTEGER, project TEXT, valid_to INTEGER, contradiction_flag INTEGER DEFAULT 0);
           CREATE TABLE memory_relations (id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, relation_type TEXT NOT NULL, confidence REAL, reason TEXT, created_at INTEGER);
           CREATE TABLE memories_fts (id TEXT, text TEXT);`);
  neighbours = [];
  neighboursOf = {};
  angles = {};
  texts.length = 0;
  jev = () => ({ choice: 'compatible', confidence: 0.9 });
});

describe('memory_judge queue', () => {
  it('judges a pair that only has its pending_judge row, then drains the queue', async () => {
    mem('old', 'weights are 0.50', 100);
    mem('new', 'weights are 0.70', 200);
    rel('new', 'old', 'pending_judge');
    jev = () => ({ choice: 'supersedes', confidence: 1 });

    const out = await handleToolCall('memory_judge', {}, env());

    expect(out).toContain('supersedes');
    expect(rels('pending_judge')).toHaveLength(0);
    expect(rels('supersedes')).toEqual([{ from_id: 'new', to_id: 'old' }]);
    expect(row('old').valid_to).not.toBeNull();
    expect(row('new').valid_to).toBeNull();
  });

  it('judges queued partners even when the fresh search does not find them', async () => {
    mem('old', 'auth uses jwt', 100);
    mem('new', 'auth uses sessions', 200);
    rel('new', 'old', 'pending_judge');
    neighbours = []; // vector search returns nothing

    await handleToolCall('memory_judge', {}, env());

    expect(rels('compatible')).toEqual([{ from_id: 'new', to_id: 'old' }]);
    expect(rels('pending_judge')).toHaveLength(0);
  });

  it('keeps the queue row and stores nothing when no verdict parses', async () => {
    mem('old', 'a', 100);
    mem('new', 'b', 200);
    rel('new', 'old', 'pending_judge');
    jev = () => null; // Jev fails, Llama returns unparseable text

    const out = await handleToolCall('memory_judge', {}, env());

    expect(out).toContain('retry later');
    expect(rels('pending_judge')).toHaveLength(1);
    expect(rels('compatible')).toHaveLength(0);
  });

  it('skips an expired queued target and clears its queue', async () => {
    mem('old', 'a', 100, 'p1', '50, 1');
    mem('new', 'b', 200);
    rel('old', 'new', 'pending_judge');

    const out = await handleToolCall('memory_judge', {}, env());

    expect(out).toContain('expired, skipped');
    expect(rels('pending_judge')).toHaveLength(0);
    expect(row('new').valid_to).toBeNull();
  });
});

describe('memory_judge supersede safety', () => {
  it('records a low-confidence supersede as possible_supersede and expires nothing', async () => {
    mem('old', 'hybrid retrieval', 100);
    mem('new', 'weights are 0.70', 200);
    rel('new', 'old', 'pending_judge');
    jev = () => ({ choice: 'supersedes', confidence: 0.44 });

    await handleToolCall('memory_judge', {}, env());

    expect(rels('possible_supersede')).toHaveLength(1);
    expect(rels('supersedes')).toHaveLength(0);
    expect(row('old').valid_to).toBeNull();
  });

  it('does not expire a memory from another project', async () => {
    mem('old', 'early extension not fixed', 100, 'default');
    mem('new', 'early extension fixed', 200, 'golf-coach');
    rel('new', 'old', 'pending_judge');
    jev = () => ({ choice: 'supersedes', confidence: 0.97 });

    await handleToolCall('memory_judge', {}, env());

    expect(rels('possible_supersede')).toHaveLength(1);
    expect(row('old').valid_to).toBeNull();
  });

  it('never lets an expired candidate expire a live memory', async () => {
    mem('live', 'a', 100);
    mem('dead', 'b', 200, 'p1', '50, 1');
    mem('target', 'c', 150);
    rel('target', 'dead', 'pending_judge');
    neighbours = ['dead'];
    jev = () => ({ choice: 'supersedes', confidence: 1 });

    await handleToolCall('memory_judge', {}, env());

    expect(row('target').valid_to).toBeNull();
    expect(rels('supersedes')).toHaveLength(0);
  });
});

describe('memory_judge flags', () => {
  it('clears the flag on a flagged memory judged compatible', async () => {
    mem('flagged', 'a', 100, 'p1', 'NULL, 1');
    mem('other', 'b', 200);
    neighbours = ['other'];

    await handleToolCall('memory_judge', {}, env());

    expect(row('flagged').contradiction_flag).toBe(0);
  });

  it('keeps the flag after a conflict and does not pick the memory again', async () => {
    mem('flagged', 'meeting tuesday', 100, 'p1', 'NULL, 1');
    mem('other', 'meeting thursday', 200);
    neighbours = ['other'];
    jev = () => ({ choice: 'conflicts_with', confidence: 0.9 });

    await handleToolCall('memory_judge', {}, env());
    expect(row('flagged').contradiction_flag).toBe(1);

    const second = await handleToolCall('memory_judge', {}, env());
    expect(second).toBe('No pending judgements or flagged contradictions.');
  });
});

describe('memory_judge stale copies', () => {
  it('retires an older copy of the superseded fact that the newer memory also supersedes', async () => {
    mem('old', 'threshold 0.3 to 0.6', 100);
    mem('copy', 'switched threshold 0.3 to 0.6', 110);
    mem('new', 'reverted threshold to 0.3', 200);
    rel('new', 'old', 'pending_judge');
    neighboursOf = { 'threshold 0.3 to 0.6': ['copy'] };
    jev = (a, b) => (a.includes('reverted') || b.includes('reverted') ? { choice: 'supersedes', confidence: 0.95 } : { choice: 'extends', confidence: 0.9 });

    const out = await handleToolCall('memory_judge', {}, env());

    expect(out).toContain('copy of old');
    expect(row('old').valid_to).not.toBeNull();
    expect(row('copy').valid_to).not.toBeNull();
    expect(row('new').valid_to).toBeNull();
  });

  it('leaves copies in another project, copies newer than the new memory, and copies Jev does not supersede', async () => {
    mem('old', 'threshold 0.3 to 0.6', 100);
    mem('other-project', 'threshold 0.3 to 0.6 too', 110, 'p2');
    mem('later', 'threshold note written later', 300);
    mem('unrelated', 'threshold history', 120);
    mem('new', 'reverted threshold to 0.3', 200);
    rel('new', 'old', 'pending_judge');
    neighboursOf = { 'threshold 0.3 to 0.6': ['other-project', 'later', 'unrelated'] };
    jev = (a, b) => {
      const pair = a + '|' + b;
      if (pair.includes('history')) return { choice: 'extends', confidence: 0.9 };
      return pair.includes('reverted') ? { choice: 'supersedes', confidence: 0.95 } : { choice: 'compatible', confidence: 0.9 };
    };

    await handleToolCall('memory_judge', {}, env());

    expect(row('old').valid_to).not.toBeNull();
    expect(row('other-project').valid_to).toBeNull();
    expect(row('later').valid_to).toBeNull();
    expect(row('unrelated').valid_to).toBeNull();
  });

  it('backfills copies for a supersede stored earlier', async () => {
    mem('old', 'threshold 0.3 to 0.6', 100, 'p1', '150, 1');
    mem('copy', 'switched threshold 0.3 to 0.6', 110);
    mem('new', 'reverted threshold to 0.3', 200);
    rel('new', 'old', 'supersedes');
    angles = { 'threshold 0.3 to 0.6': 0, 'switched threshold 0.3 to 0.6': 0.01, 'reverted threshold to 0.3': 0.5 };
    neighbours = ['copy'];
    jev = () => ({ choice: 'supersedes', confidence: 0.9 });

    const out = await handleToolCall('memory_judge', { backfill_copies: true, budget_ms: 5000 }, env());

    expect(out).toContain('copy of old');
    expect(out).toContain('backfill complete');
    expect(row('copy').valid_to).not.toBeNull();
    // The relation it just inserted is not used as a seed, so the copy's own neighbours are untouched.
    expect(rels('supersedes')).toHaveLength(2);
  });

  it('keeps a copy that is closer to the newer memory (a restatement of the current fact)', async () => {
    mem('old', 'threshold 0.3 to 0.6', 100, 'p1', '150, 1');
    mem('restated', 'threshold is back at 0.3', 110);
    mem('new', 'reverted threshold to 0.3', 200);
    rel('new', 'old', 'supersedes');
    angles = { 'threshold 0.3 to 0.6': 0, 'threshold is back at 0.3': 0.45, 'reverted threshold to 0.3': 0.5 };
    neighbours = ['restated'];
    jev = () => ({ choice: 'supersedes', confidence: 0.99 });

    await handleToolCall('memory_judge', { backfill_copies: true, budget_ms: 5000 }, env());

    expect(row('restated').valid_to).toBeNull();
  });

  it('leaves a copy alone when Jev fails or is not confident', async () => {
    mem('old', 'threshold 0.3 to 0.6', 100, 'p1', '150, 1');
    mem('copyA', 'switched threshold 0.3 to 0.6', 110);
    mem('copyB', 'moved threshold 0.3 to 0.6', 111);
    mem('new', 'reverted threshold to 0.3', 200);
    rel('new', 'old', 'supersedes');
    angles = { 'threshold 0.3 to 0.6': 0, 'switched threshold 0.3 to 0.6': 0.01, 'moved threshold 0.3 to 0.6': 0.02, 'reverted threshold to 0.3': 0.5 };
    neighbours = ['copyA', 'copyB'];
    jev = (_a, b) => (b.startsWith('switched') ? null : { choice: 'supersedes', confidence: 0.6 });

    await handleToolCall('memory_judge', { backfill_copies: true, budget_ms: 5000 }, env());

    expect(row('copyA').valid_to).toBeNull();
    expect(row('copyB').valid_to).toBeNull();
  });

  it('does not seed the backfill from low-confidence or cross-project supersedes', async () => {
    mem('old', 'threshold 0.3 to 0.6', 100, 'p1', '150, 1');
    mem('copy', 'switched threshold 0.3 to 0.6', 110);
    mem('new', 'reverted threshold to 0.3', 200);
    db.exec(`INSERT INTO memory_relations VALUES ('weak', 'new', 'old', 'supersedes', 0.44, 'jev', 1)`);
    angles = { 'threshold 0.3 to 0.6': 0, 'switched threshold 0.3 to 0.6': 0.01, 'reverted threshold to 0.3': 0.5 };
    neighbours = ['copy'];
    jev = () => ({ choice: 'supersedes', confidence: 0.95 });

    await handleToolCall('memory_judge', { backfill_copies: true, budget_ms: 5000 }, env());

    expect(row('copy').valid_to).toBeNull();
  });
});
