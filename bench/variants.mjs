// A/B retrieval scoring variants against the live store in one deploy.
//
// Every query runs through /bench/retrieve (frozen, so trials don't mutate access counts)
// once per variant, and is scored with the same ID-first unit matching as ablation.mjs.
// Variants are the bench-only switches in retrieve() (RetrievalVariant in src/retrieval.ts);
// "prod" sends none, so it is exactly what agent calls get. Runs each variant --reps times
// and reports the mean, so run-to-run drift is visible next to any claimed difference.
//
// Usage: node bench/variants.mjs [--topk 8] [--reps 2] [--variants prod,ftsOr,...]
//        [--gold bench/gold/retrieval_gold.v1.json,...]
import { readFileSync, existsSync } from 'node:fs';
import { loadEnv, retrieveStructured } from './lib/client.mjs';
import { mean } from './lib/metrics.mjs';
import { unitsFor, recallOfUnits, firstHitRankUnits } from './lib/idmatch.mjs';

const arg = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const TOP_K = Number(arg('--topk', '8'));
const REPS = Number(arg('--reps', '2'));
const GOLD_PATH = arg('--gold', 'bench/gold/retrieval_gold.v1.json,bench/gold/retrieval_gold.vague.json,bench/gold/retrieval_gold.multihop.json');

const VARIANTS = {
  prod: undefined,
  old: { ftsOr: false, ftsStopwords: false },
  ftsOr: { ftsOr: true },
  ftsOrStop: { ftsOr: true, ftsStopwords: true },
  ftsOrStop_noHot: { ftsOr: true, ftsStopwords: true, hotTier: false },
  noHot: { hotTier: false },
  created: { recencyCreated: true },
  ftsOr_noHot: { ftsOr: true, hotTier: false },
  all: { ftsOr: true, hotTier: false, recencyCreated: true },
};
const names = arg('--variants', Object.keys(VARIANTS).join(',')).split(',');

async function main() {
  const env = loadEnv();
  // Query ids repeat across gold files, so key each one by file tag + id.
  const queries = GOLD_PATH.split(',').flatMap(p => {
    const tag = p.trim().replace(/^.*retrieval_gold\.|\.json$/g, '');
    return JSON.parse(readFileSync(p.trim(), 'utf8')).queries.map(q => ({ ...q, key: `${tag}:${q.id}` }));
  }).filter(q => !q.abstain);
  const idGroups = existsSync('bench/gold/id_groups.json') ? JSON.parse(readFileSync('bench/gold/id_groups.json', 'utf8')) : null;
  console.log(`${queries.length} queries, top_k=${TOP_K}, reps=${REPS}, target ${env.url}\n`);

  const perQuery = {}; // name -> qid -> recall (last rep)
  const summary = [];
  for (const name of names) {
    const recallsByRep = [], mrrByRep = [];
    perQuery[name] = {};
    for (let rep = 0; rep < REPS; rep++) {
      const recalls = [], rr = [];
      for (const q of queries) {
        const units = unitsFor(q, idGroups);
        const res = await retrieveStructured(q.query, { top_k: TOP_K, variant: VARIANTS[name] }, env);
        if (!res.ok) console.error(`  ! ${name} ${q.id}: ${res.error}`);
        const r = recallOfUnits(res.rows, units);
        const rank = firstHitRankUnits(res.rows, units);
        recalls.push(r);
        rr.push(rank ? 1 / rank : 0);
        perQuery[name][q.key] = r;
      }
      recallsByRep.push(mean(recalls));
      mrrByRep.push(mean(rr));
    }
    summary.push({ name, recall: mean(recallsByRep), mrr: mean(mrrByRep), spread: Math.max(...recallsByRep) - Math.min(...recallsByRep) });
  }

  console.log(`${'variant'.padEnd(14)}${'recall'.padEnd(9)}${'MRR'.padEnd(8)}rep spread`);
  for (const s of summary) console.log(`${s.name.padEnd(14)}${s.recall.toFixed(3).padEnd(9)}${s.mrr.toFixed(3).padEnd(8)}${s.spread.toFixed(3)}`);

  console.log('\nPer-query changes vs prod (recall):');
  for (const name of names.filter(n => n !== 'prod')) {
    const diffs = queries
      .map(q => ({ id: q.key, d: (perQuery[name][q.key] ?? 0) - (perQuery.prod?.[q.key] ?? 0) }))
      .filter(x => Math.abs(x.d) > 1e-9);
    console.log(`  ${name}: ${diffs.length ? diffs.map(x => `${x.id}${x.d > 0 ? '+' : ''}${x.d.toFixed(2)}`).join(' ') : 'no change'}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
