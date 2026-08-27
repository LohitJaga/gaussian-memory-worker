// Stage B — the ablation that actually earns the "fewer tokens, not lossy" claim.
//
// Runs the SAME gold set through two retrieval paths at the SAME nominal top_k:
//   - Gaussian: full hybrid scoring (retrieve())
//   - Baseline: naive top-k cosine only (baselineRetrieve())
// and reports recall/precision/tokens for both, swept across several top_k budgets —
// the accuracy-vs-tokens frontier. If Gaussian's curve matches-or-beats baseline's
// recall at a fraction of the tokens, that's the thesis proven on this store; if not,
// that's the honest finding too.
//
// 2026-07-09: switched from the text JSON-RPC path + substring matching to the
// structured /bench/retrieve endpoint + ID-first unit matching (bench/lib/idmatch.mjs,
// bench/gold/id_groups.json) — substring matching mis-scored correct dedup survivors
// (audit finding #2), and the old path live-mutated sigma/access_count on every
// Gaussian call (finding #5; /bench/retrieve is frozen by default). Token counts are
// now derived from returned row texts, which excludes the [DOMAIN:]/Summary framing
// lines of the agent-facing format — a small constant undercount on the Gaussian side.
//
// Per-query breakdown is printed with --perquery (and by default when the merged set
// has <= 20 queries): audit lesson — never trust the aggregate alone.
//
// Abstention queries are excluded — this ablation is about fact-retrieval quality/cost,
// not confidence calibration (that's a separate, already-diagnosed weak spot).
//
// Usage: node bench/ablation.mjs [--topks 4,8,16,24] [--gold bench/gold/retrieval_gold.v1.json,...] [--perquery]

import { readFileSync, existsSync } from 'node:fs';
import { loadEnv, retrieveStructured } from './lib/client.mjs';
import { mean, distribution } from './lib/metrics.mjs';
import { tokensOf } from './lib/textmatch.mjs';
import { unitsFor, recallOfUnits, precisionAtKUnits, explainUnits } from './lib/idmatch.mjs';

const arg = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const TOP_KS = arg('--topks', '4,8,16,24').split(',').map(Number);
const GOLD_PATH = arg('--gold', 'bench/gold/retrieval_gold.v1.json,bench/gold/retrieval_gold.multihop.json');
const ID_GROUPS_PATH = 'bench/gold/id_groups.json';

async function runMode(query, topK, mode, env) {
  const res = await retrieveStructured(query, { top_k: topK, baseline: mode === 'baseline' }, env);
  if (!res.ok) console.error(`  ! retrieve failed (${mode}, k=${topK}): ${res.error}`);
  // Approximate injected tokens from the row texts (see header note).
  const tokens = res.rows.reduce((s, r) => s + tokensOf(r.text) + 6, 0); // +6 ≈ score/domain/type framing per line
  return { rows: res.rows, tokens, ok: res.ok };
}

async function main() {
  const env = loadEnv();
  const paths = GOLD_PATH.split(',').map(s => s.trim()).filter(Boolean);
  const files = paths.map(p => JSON.parse(readFileSync(p, 'utf8')));
  const queries = files.flatMap(f => f.queries).filter(q => !q.abstain);
  const idGroups = existsSync(ID_GROUPS_PATH) ? JSON.parse(readFileSync(ID_GROUPS_PATH, 'utf8')) : null;
  if (!idGroups) console.error(`WARNING: ${ID_GROUPS_PATH} not found — falling back to text-only matching (run bench/tools/derive_id_groups.mjs).`);
  const PER_QUERY = process.argv.includes('--perquery') || queries.length <= 20;

  console.log(`Stage B ablation — ${queries.length} answerable queries, top_k in [${TOP_KS.join(', ')}]`);
  console.log(`Scoring: ID-first unit matching (${idGroups ? 'id_groups.json loaded' : 'TEXT-ONLY FALLBACK'}), frozen trials`);
  console.log(`Target: ${env.url}\n`);

  const table = [];        // { topK, mode, recall, precision, tokens }
  const perQueryRows = []; // { topK, qid, mode, recall, explain }

  for (const topK of TOP_KS) {
    for (const mode of ['gaussian', 'baseline']) {
      const recalls = [], precisions = [], tokenCounts = [];
      for (const q of queries) {
        const units = unitsFor(q, idGroups);
        const { rows, tokens } = await runMode(q.query, topK, mode, env);
        recalls.push(recallOfUnits(rows, units));
        precisions.push(precisionAtKUnits(rows, units));
        tokenCounts.push(tokens);
        perQueryRows.push({ topK, qid: q.id, mode, recall: recalls[recalls.length - 1], explain: explainUnits(rows, units) });
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

  if (PER_QUERY) {
    console.log('\n── Per-query breakdown (audit lesson: never trust the aggregate alone) ──');
    for (const topK of TOP_KS) {
      console.log(`  top_k=${topK}`);
      for (const q of queries) {
        const g = perQueryRows.find(r => r.topK === topK && r.qid === q.id && r.mode === 'gaussian');
        const b = perQueryRows.find(r => r.topK === topK && r.qid === q.id && r.mode === 'baseline');
        const flag = g.recall > b.recall ? ' G+' : g.recall < b.recall ? ' B+' : '';
        console.log(`    ${q.id.padEnd(5)} gaussian ${g.explain.padEnd(36)} baseline ${b.explain}${flag}`);
      }
    }
  }

  console.log('\nThesis check: gaussian recall >= baseline recall AND gaussian tokens < baseline tokens = thesis holds.');
  console.log('Any other combination is an honest finding, not a failure to report.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
