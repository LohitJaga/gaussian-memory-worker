// One-time (re-runnable) derivation of gold_id -> match_text groupings.
//
// Gold files record gold_ids and match_texts as parallel-ish arrays with no
// explicit pairing (q04: 1 id / 2 texts from the same memory; q38: 3 ids / 2
// texts across a near-duplicate cluster). ID-based scoring needs to know which
// ids answer which match_text so denominators stay = |match_texts| and a
// dedup survivor credits the right unit.
//
// Method: fetch each gold_id's live text from D1 (wrangler d1 execute --remote),
// then assign the id to every match_text whose normalized form is CONTAINED in
// the memory text; if none contains, fall back to the match_text with the best
// token overlap (and print it for eyeballing — fallback assignments are the
// ones worth auditing). Ids missing from D1 (deleted by dedup/consolidation
// cron since gold authoring) are reported loudly and kept in their best-guess
// group so the report shows them, but they can never match at runtime.
//
// Usage (from repo root, needs wrangler auth + wrangler.toml):
//   node bench/tools/derive_id_groups.mjs > /dev/null   # writes bench/gold/id_groups.json
//
// The output file is committed. Frozen gold files are NOT modified.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { norm } from '../lib/textmatch.mjs';

const GOLD_FILES = [
  'bench/gold/retrieval_gold.v1.json',
  'bench/gold/retrieval_gold.multihop.json',
  'bench/gold/retrieval_gold.vague.json',
];
const OUT = 'bench/gold/id_groups.json';

const tokens = s => new Set(norm(s).split(' ').filter(w => w.length > 2));
function overlap(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0; for (const w of ta) if (tb.has(w)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

function main() {
  const files = GOLD_FILES.map(p => ({ path: p, gold: JSON.parse(readFileSync(p, 'utf8')) }));
  const queries = files.flatMap(f => f.gold.queries.filter(q => !q.abstain && q.gold_ids?.length));

  const allIds = [...new Set(queries.flatMap(q => q.gold_ids))];
  console.error(`Fetching ${allIds.length} distinct gold ids from remote D1...`);
  const sql = `SELECT id, text FROM memories WHERE id IN (${allIds.map(i => `'${i}'`).join(',')})`;
  const raw = execFileSync('npx', ['wrangler', 'd1', 'execute', 'gaussian-memory', '--remote', '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const parsed = JSON.parse(raw);
  const rows = parsed[0]?.results ?? [];
  const textOf = new Map(rows.map(r => [r.id, r.text]));

  const missing = allIds.filter(id => !textOf.has(id));
  if (missing.length) {
    console.error(`\n!! ${missing.length} gold ids NO LONGER EXIST in D1 (deleted since gold authoring?):`);
    for (const id of missing) {
      const qs = queries.filter(q => q.gold_ids.includes(id)).map(q => q.id).join(',');
      console.error(`   ${id}  (queries: ${qs})`);
    }
  }

  const out = { generated_by: 'bench/tools/derive_id_groups.mjs', generated_at: new Date().toISOString(),
    note: 'Maps each gold query to units: one group per match_text, with the gold_ids whose live D1 text answers it. Containment assignment when possible, token-overlap fallback otherwise (fallbacks + missing ids listed in stderr at generation time). Frozen gold files untouched.',
    missing_ids: missing,
    queries: {} };

  for (const q of queries) {
    const groups = q.match_texts.map(mt => ({ match_text: mt, ids: [] }));
    for (const id of q.gold_ids) {
      const text = textOf.get(id);
      if (text === undefined) {
        // Missing id: best-guess by overlap with the match_text strings themselves is
        // impossible (no text) — park it on group 0 and rely on the missing_ids report.
        groups[0].ids.push(id);
        continue;
      }
      const contained = groups.filter(g => norm(text).includes(norm(g.match_text)));
      if (contained.length) {
        for (const g of contained) g.ids.push(id);
      } else {
        let best = 0, bestScore = -1;
        groups.forEach((g, i) => {
          const s = overlap(text, g.match_text);
          if (s > bestScore) { bestScore = s; best = i; }
        });
        groups[best].ids.push(id);
        console.error(`fallback: ${q.id} id=${id.slice(0, 8)} -> "${q.match_texts[best].slice(0, 50)}" (overlap=${bestScore.toFixed(2)})\n   text: ${text.slice(0, 110)}`);
      }
    }
    const empty = groups.filter(g => !g.ids.length);
    for (const g of empty) console.error(`note: ${q.id} unit "${g.match_text.slice(0, 50)}" has NO assigned id (text-match only at runtime)`);
    out.queries[q.id] = { groups };
  }

  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.error(`\nWrote ${OUT} (${Object.keys(out.queries).length} queries).`);
  console.log(JSON.stringify(out, null, 2));
}

main();
