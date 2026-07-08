// Stage B — the ablation that actually earns the "fewer tokens, not lossy" claim.
//
// Runs the SAME gold set through two retrieval paths at the SAME nominal top_k:
//   - Gaussian: full hybrid scoring (retrieve())
//   - Baseline: naive top-k cosine only (memory_retrieve baseline:true / baselineRetrieve())
// and reports recall/precision/tokens for both, swept across several top_k budgets —
// the accuracy-vs-tokens frontier. If Gaussian's curve matches-or-beats baseline's
// recall at a fraction of the tokens, that's the thesis proven on this store; if not,
// that's the honest finding too.
//
// Abstention queries are excluded — this ablation is about fact-retrieval quality/cost,
// not confidence calibration (that's a separate, already-diagnosed weak spot).
//
// Usage: node bench/ablation.mjs [--topks 4,8,16,24] [--gold bench/gold/retrieval_gold.v1.json,...]

import { readFileSync } from 'node:fs';
import { loadEnv, retrieve } from './lib/client.mjs';
import { mean, distribution } from './lib/metrics.mjs';
import { recallOfSet, precisionAtK, tokensOf } from './lib/textmatch.mjs';

const arg = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const TOP_KS = arg('--topks', '4,8,16,24').split(',').map(Number);
const GOLD_PATH = arg('--gold', 'bench/gold/retrieval_gold.v1.json,bench/gold/retrieval_gold.multihop.json');

async function runMode(query, topK, mode, env) {
  const res = await retrieve(query, { top_k: topK, baseline: mode === 'baseline' }, env);
  return res.ok ? { rows: res.rows, tokens: tokensOf(res.text) } : { rows: [], tokens: 0 };
}

async function main() {
  const env = loadEnv();
  const paths = GOLD_PATH.split(',').map(s => s.trim()).filter(Boolean);
  const files = paths.map(p => JSON.parse(readFileSync(p, 'utf8')));
  const queries = files.flatMap(f => f.queries).filter(q => !q.abstain);

  console.log(`Stage B ablation — ${queries.length} answerable queries, top_k in [${TOP_KS.join(', ')}]`);
  console.log(`Target: ${env.url}\n`);

  const table = []; // { topK, mode, recall[], precision[], tokens[] }

  for (const topK of TOP_KS) {
    for (const mode of ['gaussian', 'baseline']) {
      const recalls = [], precisions = [], tokenCounts = [];
      for (const q of queries) {
        const { rows, tokens } = await runMode(q.query, topK, mode, env);
        recalls.push(recallOfSet(rows, q.match_texts));
        precisions.push(precisionAtK(rows, q.match_texts));
        tokenCounts.push(tokens);
      }
      table.push({ topK, mode, recall: mean(recalls), precision: mean(precisions), tokens: distribution(tokenCounts) });
    }
  }

  console.log('── Accuracy-vs-tokens frontier ──────────────────────────────');
  console.log(`${'top_k'.padEnd(6)}${'mode'.padEnd(10)}${'recall'.padEnd(9)}${'precision'.padEnd(11)}${'tokens(p50)'.padEnd(13)}tokens(p95)`);
  for (const row of table) {
    console.log(
      `${String(row.topK).padEnd(6)}${row.mode.padEnd(10)}${row.recall.toFixed(2).padEnd(9)}${row.precision.toFixed(2).padEnd(11)}${String(row.tokens.p50).padEnd(13)}${row.tokens.p95}`
    );
  }

  console.log('\n── Head-to-head at matched top_k ────────────────────────────');
  for (const topK of TOP_KS) {
    const g = table.find(r => r.topK === topK && r.mode === 'gaussian');
    const b = table.find(r => r.topK === topK && r.mode === 'baseline');
    const recallDelta = (g.recall - b.recall).toFixed(2);
    const tokenRatio = b.tokens.p50 > 0 ? (g.tokens.p50 / b.tokens.p50).toFixed(2) : 'n/a';
    console.log(`  top_k=${topK}: recall Δ=${recallDelta >= 0 ? '+' : ''}${recallDelta} (gaussian-baseline)  |  tokens gaussian/baseline = ${tokenRatio}x`);
  }
  console.log('\nThesis check: gaussian recall >= baseline recall AND gaussian tokens < baseline tokens = thesis holds.');
  console.log('Any other combination is an honest finding, not a failure to report.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
