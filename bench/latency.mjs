// Phase 1 — Latency probe (free, runs against the live Worker).
//
// Measures real over-the-wire memory_retrieve latency at the JSON-RPC path the
// agent actually uses. Reports p50/p95/p99 (never the mean alone) and, as a free
// byproduct, tokens-per-query (chars/4 approximation of the injected context) —
// the second of the three standard columns (accuracy · tokens · latency).
//
// Usage:
//   node bench/latency.mjs [--n 40] [--topk 8] [--warmup 3]
//
// Note: the first calls hit a cold Worker isolate / cold KV; --warmup discards
// them so the reported distribution is steady-state. Cold-start is reported
// separately so we can be honest about it.

import { loadEnv, retrieve } from './lib/client.mjs';
import { distribution } from './lib/metrics.mjs';

const arg = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};

const N = arg('--n', 40);
const TOP_K = arg('--topk', 8);
const WARMUP = arg('--warmup', 3);

// A spread of query shapes: precise (low sigma → wider injectCap) vs vague (high
// sigma → tighter), single-domain vs cross-domain, so latency/tokens reflect the
// real mix rather than one easy query. Drawn from the actual store's domains.
const QUERIES = [
  'D1 vs PlanetScale decision',
  'Bhattacharyya retrieval scoring',
  'what did I decide about domain rebuild',
  'L\'Oreal W5 paid media monitor',
  'sigma decay and pruning cron',
  'Kalman merge dedup threshold',
  'spreading activation entity graph',
  'how does retrieval handle contradictions',
  'benchmarking plan for gaussian memory',
  'Cloudflare Workers edge deployment',
  'what am I working on this week',
  'career goals and target companies',
];

function tokensOf(text) {
  // chars/4 is the standard rough token estimate; good enough for a proxy metric.
  return Math.round((text?.length ?? 0) / 4);
}

async function main() {
  const env = loadEnv();
  console.log(`Latency probe → ${env.url}`);
  console.log(`n=${N}  top_k=${TOP_K}  warmup=${WARMUP}\n`);

  // Cold start: very first call, reported on its own.
  const cold = await retrieve(QUERIES[0], { top_k: TOP_K }, env);
  if (!cold.ok) {
    console.error(`Request failed: ${cold.error}`);
    process.exit(1);
  }
  console.log(`cold-start latency: ${cold.latencyMs.toFixed(0)} ms  (${cold.rows.length} rows)`);

  // Warmup (discarded).
  for (let i = 0; i < WARMUP; i++) await retrieve(QUERIES[i % QUERIES.length], { top_k: TOP_K }, env);

  const latencies = [];
  const tokens = [];
  const rowCounts = [];
  let failures = 0;

  for (let i = 0; i < N; i++) {
    const q = QUERIES[i % QUERIES.length];
    const res = await retrieve(q, { top_k: TOP_K }, env);
    if (!res.ok) { failures++; continue; }
    latencies.push(res.latencyMs);
    tokens.push(tokensOf(res.text));
    rowCounts.push(res.rows.length);
  }

  const L = distribution(latencies);
  const T = distribution(tokens);
  const R = distribution(rowCounts);

  console.log('\n── Latency (ms) ─────────────────────────');
  console.log(`  p50 ${L.p50.toFixed(0)}   p95 ${L.p95.toFixed(0)}   p99 ${L.p99.toFixed(0)}   (mean ${L.mean.toFixed(0)}, min ${L.min.toFixed(0)}, max ${L.max.toFixed(0)})`);
  console.log('\n── Tokens / query (chars/4 est.) ────────');
  console.log(`  p50 ${T.p50}   p95 ${T.p95}   p99 ${T.p99}   (mean ${T.mean.toFixed(0)})`);
  console.log(`  ref: Mem0 ~6,900 · Zep ~5,760 tokens/query (on LoCoMo — see BENCHMARKING.md)`);
  console.log('\n── Returned set size ────────────────────');
  console.log(`  p50 ${R.p50}   p95 ${R.p95}   max ${R.max}   (top_k=${TOP_K}; injectCap allows up to ~3·top_k on precise queries)`);
  if (failures) console.log(`\n  ${failures}/${N} requests failed`);
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
