// Shared text-containment matching against gold match_texts — used by both
// quality.mjs (Gaussian-only) and ablation.mjs (Stage B, vs baseline) so both
// score hits identically. No memory IDs are exposed on the retrieve() text path,
// so matching is normalized-text-containment; near-duplicate memories are
// credited automatically as a result.

export const norm = s => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

// rank (1-based) of the first row containing ANY gold match_text; 0 if none.
export function firstHitRank(rows, matchTexts) {
  const needles = matchTexts.map(norm).filter(Boolean);
  for (let i = 0; i < rows.length; i++) {
    const hay = norm(rows[i].text);
    if (needles.some(n => hay.includes(n))) return i + 1;
  }
  return 0;
}

// fraction of DISTINCT gold match_texts found somewhere in the returned rows.
export function recallOfSet(rows, matchTexts) {
  const hays = rows.map(r => norm(r.text));
  let found = 0;
  for (const mt of matchTexts) {
    const n = norm(mt);
    if (n && hays.some(h => h.includes(n))) found++;
  }
  return matchTexts.length ? found / matchTexts.length : 0;
}

// fraction of RETURNED rows that are relevant to this query's gold set.
export function precisionAtK(rows, matchTexts) {
  const needles = matchTexts.map(norm).filter(Boolean);
  if (!rows.length) return 0;
  const relevant = rows.filter(r => needles.some(n => norm(r.text).includes(n))).length;
  return relevant / rows.length;
}

export function tokensOf(text) {
  return Math.round((text?.length ?? 0) / 4);
}
