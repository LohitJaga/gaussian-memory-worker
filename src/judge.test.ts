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

function env() {
  return {
    DB: d1(db),
    KV: { get: async () => null, put: async () => {} },
    JEV_RERANK: 'on',
    VECTORIZE: { query: async () => ({ matches: neighbours.map(id => ({ id, score: 0.9 })) }) },
    AI: {
      run: async (model: string, input: any) => {
        if (model.includes('bge')) return { data: [[1, 0, 0]] };
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
