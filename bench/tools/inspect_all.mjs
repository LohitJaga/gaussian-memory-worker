// One-shot inspection dump: for every query in the given gold file(s), print the
// query, the gold match_text(s), and what the live system actually returned as its
// top result — so failures can be eyeballed in bulk instead of traced one at a time.
// Read-only: hits /bench/retrieve with frozen (default), no store mutation.
import { readFileSync } from 'node:fs';
import { loadEnv, retrieveStructured } from '../lib/client.mjs';
import { unitsFor, unitHitDetail } from '../lib/idmatch.mjs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node bench/tools/inspect_all.mjs <gold-file.json> [more...]');
  process.exit(1);
}

const env = loadEnv();
let idGroups = null;
try { idGroups = JSON.parse(readFileSync('bench/gold/id_groups.json', 'utf8')); } catch {}

for (const file of files) {
  const gold = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`\n=== ${file} (${gold.queries.length} queries) ===\n`);
  for (const q of gold.queries) {
    const { rows } = await retrieveStructured(q.query, { top_k: 8, baseline: process.env.BASELINE === '1' }, env);
    const units = unitsFor(q, idGroups);
    const perUnit = units.map((u, i) => {
      const d = unitHitDetail(rows, u);
      return d.hit ? `u${i}:${d.byId && d.byText ? 'id+text' : d.byId ? 'id-only' : 'text-only'}@${d.rank}` : `u${i}:MISS`;
    });
    const anyMiss = perUnit.some(p => p.includes('MISS'));
    if (process.env.MISSES_ONLY && !anyMiss) continue;
    console.log(`\n${anyMiss ? '✗' : '✓'} [${q.id}] "${q.query}"`);
    console.log(`   gold_ids: ${JSON.stringify(q.gold_ids)}`);
    console.log(`   gold match_texts: ${JSON.stringify(q.match_texts)}`);
    console.log(`   units: ${perUnit.join(' ')}`);
    console.log(`   top 3 actual results:`);
    for (const r of rows.slice(0, 3)) {
      console.log(`     [${r.rank}] score=${r.score.toFixed(2)} domain=${r.domain} id=${r.id}`);
      console.log(`         "${r.text}"`);
    }
  }
}
