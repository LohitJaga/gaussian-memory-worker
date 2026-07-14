// Ingests LoCoMo conversations into Gaussian Memory, isolated to project 'locomo-eval'
// (one domain per conversation: locomo-{sample_id}), so this never touches real corpus
// data and is fully wipeable via cleanup.mjs afterward.
//
// Verbatim, not distilled: turns are stored as literal speaker-prefixed text, no LLM
// rewriting — distilling at ingest time would put the system at a disadvantage on
// questions that hinge on exact stated details.
//
// Chunked, not per-turn: 5,882 raw turns across the dataset would mean 5,882 individual
// memory_store calls, most of them a single line ("Hey Mel!") with no retrievable
// content on their own. Groups 4 consecutive same-session turns into one memory instead
// (~1,470 calls) — still verbatim (literal concatenation), just a saner storage unit.
//
// Each chunk is prefixed with its session's real date/time. This isn't cosmetic: it's
// the only place the calendar date lives. LoCoMo's temporal-category questions ("When
// did X happen") are answerable only if that date is actually present in what gets
// stored — memory_store has no separate timestamp-override field, so it has to be in
// the text itself.
//
// --no-merge switches to the /bench/store-nomerge endpoint (forced-spawn, bypasses the
// Kalman-merge candidate search) and a separate project ('locomo-eval-nomerge'), so both
// corpora can coexist without contaminating each other. This is the merge-ablation
// counterfactual: same chunks, same chunking, only difference is whether merge ran —
// used to measure what merge costs in literal recall (eval.mjs --project) and what it
// saves in storage (spawn vs merge counts below).
//
// --chunk-size overrides turns-per-memory (default 4). Baked into the domain name
// (locomo-{sample_id}-c{N}) so different chunk sizes for the same conversation can
// coexist without colliding — needed for comparing chunk sizes directly (2026-07-13:
// found DEDUP_COS=0.85, tuned against single-topic project memories, collapses 32
// candidates down to 3 on 4-turn LoCoMo chunks — greeting/small-talk boilerplate shared
// across sessions dilutes each chunk's embedding, making distinct sessions look like
// near-duplicates. Smaller chunks are the fix; --chunk-size lets that be tested directly
// instead of guessed at).
//
// Checkpointed: writes bench/locomo/.progress-ingest-{project}-c{N}.json after each
// conversation completes. Safe to stop (Ctrl-C, laptop closed) and re-run the exact same
// command later — already-completed conversations are skipped, nothing is redone or
// double-stored.
//
// Usage: node bench/locomo/ingest.mjs [--conversations conv-26,conv-30] [--limit N] [--no-merge] [--chunk-size N]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, callTool } from '../lib/client.mjs';

const arg = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const CHUNK_SIZE = Number(arg('--chunk-size', 4));
const NO_MERGE = process.argv.includes('--no-merge');
const PROJECT = NO_MERGE ? 'locomo-eval-nomerge' : 'locomo-eval';
const ONLY_CONVS = arg('--conversations', null)?.split(',').map(s => s.trim());
const LIMIT = Number(arg('--limit', Infinity));
const PROGRESS_PATH = join(import.meta.dirname, `.progress-ingest-${PROJECT}-c${CHUNK_SIZE}.json`);

function loadProgress() {
  if (!existsSync(PROGRESS_PATH)) return new Set();
  try { return new Set(JSON.parse(readFileSync(PROGRESS_PATH, 'utf8'))); } catch { return new Set(); }
}
function saveProgress(done) {
  writeFileSync(PROGRESS_PATH, JSON.stringify([...done], null, 2));
}

function chunkTurns(turns, size) {
  const out = [];
  for (let i = 0; i < turns.length; i += size) out.push(turns.slice(i, i + size));
  return out;
}

async function storeChunk(text, domain, env) {
  if (NO_MERGE) {
    const resp = await fetch(new URL('/bench/store-nomerge', env.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.token}` },
      body: JSON.stringify({ text, domain, memory_type: 'episodic', project: PROJECT }),
    });
    const json = await resp.json();
    return json.error ? { ok: false, error: json.error, action: null } : { ok: true, action: json.action };
  }
  const res = await callTool('memory_store', { text, domain, memory_type: 'episodic', project: PROJECT }, env);
  if (!res.ok) return { ok: false, error: res.error, action: null };
  const action = /SPAWNED/i.test(res.text) ? 'spawned' : /MERGED/i.test(res.text) ? 'merged' : 'unknown';
  return { ok: true, action };
}

async function ingestConversation(conv, env) {
  const { sample_id, conversation } = conv;
  const domain = CHUNK_SIZE === 4 ? `locomo-${sample_id}` : `locomo-${sample_id}-c${CHUNK_SIZE}`;
  const sessionKeys = Object.keys(conversation)
    .filter(k => /^session_\d+$/.test(k))
    .sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]));

  let spawned = 0, merged = 0, unknown = 0, failed = 0;
  for (const sessionKey of sessionKeys) {
    const turns = conversation[sessionKey];
    const dateTime = conversation[`${sessionKey}_date_time`] ?? 'unknown date';
    const chunks = chunkTurns(turns, CHUNK_SIZE);
    for (const chunk of chunks) {
      const body = chunk.map(t => `${t.speaker}: ${t.text}`).join('\n');
      const text = `[Session on ${dateTime}]\n${body}`;
      const res = await storeChunk(text, domain, env);
      if (!res.ok) { failed++; console.error(`  ! store failed (${sample_id}/${sessionKey}): ${res.error}`); continue; }
      if (res.action === 'spawned') spawned++;
      else if (res.action === 'merged') merged++;
      else unknown++;
    }
  }
  return { sample_id, spawned, merged, unknown, failed };
}

async function main() {
  const env = loadEnv();
  const datasetPath = join(import.meta.dirname, 'data', 'locomo10.json');
  const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));

  let convs = ONLY_CONVS ? dataset.filter(c => ONLY_CONVS.includes(c.sample_id)) : dataset;
  convs = convs.slice(0, LIMIT);

  const done = loadProgress();
  const remaining = convs.filter(c => !done.has(c.sample_id));
  const skipped = convs.length - remaining.length;

  console.log(`Ingesting into project='${PROJECT}' (merge ${NO_MERGE ? 'DISABLED' : 'enabled'})`);
  if (skipped > 0) console.log(`Resuming: ${skipped} already done (${PROGRESS_PATH}), ${remaining.length} remaining\n`);
  else console.log(`${remaining.length} conversation(s)\n`);

  const t0 = performance.now();
  let totalSpawned = 0, totalMerged = 0, totalCalls = 0;
  for (const conv of remaining) {
    const t1 = performance.now();
    const { sample_id, spawned, merged, unknown, failed } = await ingestConversation(conv, env);
    const calls = spawned + merged + unknown + failed;
    totalSpawned += spawned; totalMerged += merged; totalCalls += calls;
    console.log(`  ${sample_id}: ${calls} calls -> ${spawned} spawned, ${merged} merged, ${unknown} unknown, ${failed} failed (${Math.round(performance.now() - t1)}ms)`);
    done.add(sample_id);
    saveProgress(done);
  }
  console.log(`\nDone in ${((performance.now() - t0) / 1000).toFixed(1)}s (${done.size}/${convs.length} conversations complete overall)`);
  if (!NO_MERGE && totalCalls > 0) {
    console.log(`Storage compaction: ${totalMerged}/${totalCalls} calls merged (${(totalMerged / totalCalls * 100).toFixed(1)}%) -> ${totalSpawned} distinct rows`);
  }
}

main();
