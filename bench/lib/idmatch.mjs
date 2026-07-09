// ID-first matching against gold units — replaces pure substring containment
// (bench/lib/textmatch.mjs) as the primary scorer. Motivated by the 2026-07-08
// audit finding #2: dedupBySimilarity correctly kept a differently-worded
// near-duplicate of a gold memory, and strict substring matching scored it 0.
//
// A "unit" is one gold match_text plus the set of memory IDs whose stored text
// answers it (derived once by bench/tools/derive_id_groups.mjs from the live
// store, committed as bench/gold/id_groups.json). A returned row credits a unit
// if its id is in the unit's id set OR its text contains the unit's match_text
// (normalized). The union keeps each method covering the other's blind spot:
//   - id-match credits correct dedup survivors whose wording drifted;
//   - text-match credits near-duplicate memories whose id was never recorded
//     in gold_ids but whose text literally contains the gold string.
// Denominators are unchanged from the text-based scorer: one unit per
// match_text, so recall numbers remain comparable with earlier runs.

import { norm } from './textmatch.mjs';

// Build units for one gold query. idGroups is the parsed id_groups.json (may be
// null → falls back to text-only units with empty id sets, i.e. old behavior).
export function unitsFor(goldQuery, idGroups) {
  const entry = idGroups?.queries?.[goldQuery.id];
  if (entry?.groups?.length) {
    return entry.groups.map(g => ({ match_text: g.match_text, ids: g.ids ?? [] }));
  }
  return (goldQuery.match_texts ?? []).map(mt => ({ match_text: mt, ids: [] }));
}

// Detailed hit info for one unit: { hit, byId, byText, rank } (rank = 1-based
// rank of the first row that credits this unit; 0 if none).
export function unitHitDetail(rows, unit) {
  const idSet = new Set(unit.ids);
  const n = norm(unit.match_text);
  let byId = false, byText = false, rank = 0;
  for (let i = 0; i < rows.length; i++) {
    const idHit = idSet.has(rows[i].id);
    const textHit = Boolean(n) && norm(rows[i].text).includes(n);
    if (idHit || textHit) {
      if (!rank) rank = i + 1;
      byId ||= idHit;
      byText ||= textHit;
    }
  }
  return { hit: rank > 0, byId, byText, rank };
}

// fraction of units credited by the returned rows.
export function recallOfUnits(rows, units) {
  if (!units.length) return 0;
  let found = 0;
  for (const u of units) if (unitHitDetail(rows, u).hit) found++;
  return found / units.length;
}

// 1-based rank of the first row crediting ANY unit; 0 if none.
export function firstHitRankUnits(rows, units) {
  let best = 0;
  for (const u of units) {
    const { rank } = unitHitDetail(rows, u);
    if (rank && (!best || rank < best)) best = rank;
  }
  return best;
}

// fraction of returned rows relevant to ANY unit.
export function precisionAtKUnits(rows, units) {
  if (!rows.length) return 0;
  const idSet = new Set(units.flatMap(u => u.ids));
  const needles = units.map(u => norm(u.match_text)).filter(Boolean);
  const relevant = rows.filter(r => idSet.has(r.id) || needles.some(n => norm(r.text).includes(n))).length;
  return relevant / rows.length;
}

// Per-query diagnostic: how each unit was credited — surfaces disagreement
// between the old text-only scorer and id-matching so no per-query story hides
// inside an aggregate again. Returns e.g. "1/2 [unit0:id-only@3 unit1:miss]".
export function explainUnits(rows, units) {
  const parts = units.map((u, i) => {
    const d = unitHitDetail(rows, u);
    if (!d.hit) return `u${i}:miss`;
    const how = d.byId && d.byText ? 'id+text' : d.byId ? 'id-only' : 'text-only';
    return `u${i}:${how}@${d.rank}`;
  });
  const found = units.filter(u => unitHitDetail(rows, u).hit).length;
  return `${found}/${units.length} [${parts.join(' ')}]`;
}
