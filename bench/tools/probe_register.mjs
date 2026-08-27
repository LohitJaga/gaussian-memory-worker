// Item-3 probe (BENCHMARKING.md 2026-07-08 next-steps): for the queries where BOTH
// baseline and Gaussian scored 0, decide whether each is
//   (a) a pure embedding-register miss — the gold memory is not cosine-reachable from
//       the casual query phrasing even in a WIDE window (rank > probe depth), or
//   (b) a harness artifact / ranking problem — the gold id IS in the cosine window
//       (or a paraphrased near-dup of it is returned) but scoring/top_k buried it.
//
// Method per query:
//   1. baseline (naive cosine) at top_k = 100 (Vectorize max without returnValues):
//      report the exact rank of every gold id and of the first unit hit (id-or-text).
//   2. gaussian frozen at top_k = 24: report unit hits + ranks.
//
// Usage: node bench/tools/probe_register.mjs [--ids q33,q34,q36,q42,q43,q44] [--gold bench/gold/retrieval_gold.vague.json]

import { readFileSync, existsSync } from 'node:fs';
import { loadEnv, retrieveStructured } from '../lib/client.mjs';
import { unitsFor, explainUnits } from '../lib/idmatch.mjs';

const arg = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const IDS = arg('--ids', 'q33,q34,q36,q42,q43,q44').split(',');
const GOLD_PATH = arg('--gold', 'bench/gold/retrieval_gold.vague.json');
const idGroups = existsSync('bench/gold/id_groups.json') ? JSON.parse(readFileSync('bench/gold/id_groups.json', 'utf8')) : null;

async function main() {
  const env = loadEnv();
  const gold = JSON.parse(readFileSync(GOLD_PATH, 'utf8'));
  const queries = gold.queries.filter(q => IDS.includes(q.id));
  console.log(`Register probe — ${queries.length} queries, baseline depth 100, gaussian frozen top_k 24\nTarget: ${env.url}\n`);

  for (const q of queries) {
    const units = unitsFor(q, idGroups);
    const [base, gauss] = [
      await retrieveStructured(q.query, { top_k: 100, baseline: true }, env),
      await retrieveStructured(q.query, { top_k: 24 }, env),
    ];
    console.log(`${q.id}: "${q.query}"`);
    if (!base.ok || !gauss.ok) { console.log(`  ! fetch error: base=${base.error ?? 'ok'} gauss=${gauss.error ?? 'ok'}`); continue; }

    for (const gid of q.gold_ids) {
      const r = base.rows.findIndex(row => row.id === gid);
      const cos = r >= 0 ? base.rows[r].score.toFixed(3) : '—';
      console.log(`  gold ${gid.slice(0, 8)}  baseline-cosine rank: ${r >= 0 ? r + 1 : '>100 (NOT REACHABLE)'}  cosine=${cos}`);
    }
    const top3 = base.rows.slice(0, 3).map((r, i) => `#${i + 1}(${r.score.toFixed(3)}) ${r.text.slice(0, 70)}`);
    console.log(`  baseline top-3: ${top3.join(' | ') || '(none)'}`);
    console.log(`  unit hits — baseline@100: ${explainUnits(base.rows, units)}   gaussian@24: ${explainUnits(gauss.rows, units)}\n`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
