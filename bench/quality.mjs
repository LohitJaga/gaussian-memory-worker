// Phase 2 · Stage A — Gaussian-only retrieval quality on a frozen gold set.
//
// Answers the core question: does the lean context still CONTAIN the right
// memory? (recall) — the metric that proves "fewer tokens" != "lossy".
//
// Matching is by normalized text-containment against gold match_texts, so
// near-duplicate memories are credited automatically (no IDs on the retrieve
// path). Stage B swaps this for ID-level matching + a cosine baseline once the
// /bench/retrieve endpoint is deployed.
//
// Usage: node bench/quality.mjs [--topk 8] [--gold bench/gold/retrieval_gold.v1.json]

import { readFileSync } from 'node:fs';
import { loadEnv, retrieve } from './lib/client.mjs';
import { mean, distribution } from './lib/metrics.mjs';
import { firstHitRank, recallOfSet, precisionAtK } from './lib/textmatch.mjs';

const arg = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const TOP_K = Number(arg('--topk', '8'));
// --gold accepts one or more comma-separated files; their queries are merged
// (keeps v1 frozen while additive files extend coverage).
const GOLD_PATH = arg('--gold', 'bench/gold/retrieval_gold.v1.json');

async function main() {
  const env = loadEnv();
  const paths = GOLD_PATH.split(',').map(s => s.trim()).filter(Boolean);
  const files = paths.map(p => JSON.parse(readFileSync(p, 'utf8')));
  const gold = { version: files.map(f => f.version).join('+'), queries: files.flatMap(f => f.queries) };
  console.log(`Gold set: ${gold.version}  (${gold.queries.length} queries)  top_k=${TOP_K}`);
  console.log(`Target:   ${env.url}\n`);

  const byCat = {};        // category -> { recall:[], precision:[], rr:[], n }
  const answerableTopScores = [];
  const abstainTopScores = [];
  const perQuery = [];

  for (const q of gold.queries) {
    const res = await retrieve(q.query, { top_k: TOP_K }, env);
    if (!res.ok) { console.log(`  ! ${q.id} failed: ${res.error}`); continue; }
    const topScore = res.rows.length ? res.rows[0].score : 0;
    const cat = (byCat[q.category] ??= { recall: [], precision: [], rr: [], n: 0 });
    cat.n++;

    if (q.abstain) {
      abstainTopScores.push(topScore);
      // "correct" abstention proxy: top score stays below the answerable median (computed after).
      perQuery.push({ id: q.id, cat: q.category, abstain: true, topScore, rows: res.rows.length });
      continue;
    }

    const topRows = res.rows.slice(0, TOP_K);
    const recall = recallOfSet(topRows, q.match_texts);
    const precision = precisionAtK(topRows, q.match_texts);
    const rank = firstHitRank(topRows, q.match_texts);
    cat.recall.push(recall);
    cat.precision.push(precision);
    cat.rr.push(rank ? 1 / rank : 0);
    answerableTopScores.push(topScore);
    perQuery.push({ id: q.id, cat: q.category, recall, precision, rank, topScore, rows: res.rows.length });
  }

  // ── Per-category ─────────────────────────────
  console.log('── Recall, Precision & MRR by category ──');
  const order = ['exact', 'paraphrase', 'multihop', 'temporal'];
  let allRecall = [], allPrecision = [], allRr = [];
  for (const c of order) {
    const b = byCat[c];
    if (!b || !b.recall.length) continue;
    allRecall = allRecall.concat(b.recall); allPrecision = allPrecision.concat(b.precision); allRr = allRr.concat(b.rr);
    console.log(`  ${c.padEnd(11)} n=${b.recall.length}  recall@${TOP_K}=${mean(b.recall).toFixed(2)}  precision@${TOP_K}=${mean(b.precision).toFixed(2)}  MRR=${mean(b.rr).toFixed(2)}`);
  }
  console.log(`  ${'OVERALL'.padEnd(11)} n=${allRecall.length}  recall@${TOP_K}=${mean(allRecall).toFixed(2)}  precision@${TOP_K}=${mean(allPrecision).toFixed(2)}  MRR=${mean(allRr).toFixed(2)}`);
  console.log(`\n  Note: precision is expected to be low by design (threshold retrieval + spreading`);
  console.log(`  activation cast a wide net). It's reported, not hidden — see BENCHMARKING.md.`);

  // ── Abstention calibration ───────────────────
  const ansMed = distribution(answerableTopScores).p50;
  const abs = distribution(abstainTopScores);
  console.log('\n── Abstention calibration ───────────────');
  console.log(`  answerable top-score  p50=${ansMed.toFixed(2)}`);
  console.log(`  adversarial top-score p50=${abs.p50.toFixed(2)}  max=${abs.max.toFixed(2)}  (lower = better; system is less confident when nothing matches)`);
  const wellCalibrated = abstainTopScores.filter(s => s < ansMed).length;
  console.log(`  ${wellCalibrated}/${abstainTopScores.length} adversarial queries scored below the answerable median`);

  // ── Misses worth eyeballing ──────────────────
  const misses = perQuery.filter(p => !p.abstain && p.recall < 1);
  if (misses.length) {
    console.log('\n── Partial/complete misses ──────────────');
    for (const m of misses) console.log(`  ${m.id} (${m.cat})  recall=${m.recall.toFixed(2)}  firstHitRank=${m.rank || '—'}`);
  }
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
