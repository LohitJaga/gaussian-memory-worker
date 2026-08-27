// Gaussian Memory benchmark harness — pure metric functions (Phase 0)
//
// Kept dependency-free and side-effect-free so they can be unit-tested and reused
// across every phase. `retrieved` is an ordered array of ids (rank 1 first);
// `gold` is a Set (or array) of relevant ids. Everything is rank-order aware.

const asSet = g => (g instanceof Set ? g : new Set(g));

// Fraction of the top-k that are gold. Low for our wide-net retrieval by design.
export function precisionAtK(retrieved, gold, k) {
  const g = asSet(gold);
  const top = retrieved.slice(0, k);
  if (top.length === 0) return 0;
  return top.filter(id => g.has(id)).length / top.length;
}

// Fraction of gold items present in the top-k. Expected to be our strong axis.
export function recallAtK(retrieved, gold, k) {
  const g = asSet(gold);
  if (g.size === 0) return 1;
  const top = new Set(retrieved.slice(0, k));
  let hit = 0;
  for (const id of g) if (top.has(id)) hit++;
  return hit / g.size;
}

// Mean Reciprocal Rank of the first gold hit — top-heavy, forgiving of tail junk.
export function reciprocalRank(retrieved, gold) {
  const g = asSet(gold);
  for (let i = 0; i < retrieved.length; i++) if (g.has(retrieved[i])) return 1 / (i + 1);
  return 0;
}

// Binary-relevance nDCG@k. Rank-discounted; the headline ranking metric.
export function ndcgAtK(retrieved, gold, k) {
  const g = asSet(gold);
  let dcg = 0;
  for (let i = 0; i < Math.min(k, retrieved.length); i++) {
    if (g.has(retrieved[i])) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(k, g.size); i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

// Precision/recall at a single score threshold: keep rows with score >= t.
// rows: [{ id, score }] in any order. Used to sweep the P–R curve.
export function prAtThreshold(rows, gold, t) {
  const g = asSet(gold);
  const kept = rows.filter(r => r.score >= t);
  const tp = kept.filter(r => g.has(r.id)).length;
  const precision = kept.length === 0 ? 1 : tp / kept.length;
  const recall = g.size === 0 ? 1 : tp / g.size;
  return { threshold: t, precision, recall, kept: kept.length };
}

// Sweep thresholds across the observed score range → P–R curve points.
export function prCurve(rows, gold, steps = 20) {
  if (rows.length === 0) return [];
  const scores = rows.map(r => r.score);
  const lo = Math.min(...scores), hi = Math.max(...scores);
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = lo + ((hi - lo) * i) / steps;
    pts.push(prAtThreshold(rows, gold, t));
  }
  return pts;
}

// Trapezoidal area under a P–R curve (points need not be pre-sorted).
export function prAuc(points) {
  const pts = [...points].sort((a, b) => a.recall - b.recall);
  let auc = 0;
  for (let i = 1; i < pts.length; i++) {
    const dr = pts[i].recall - pts[i - 1].recall;
    auc += dr * (pts[i].precision + pts[i - 1].precision) / 2;
  }
  return auc;
}

// Latency / token distribution summary. Input: array of numbers.
export function distribution(xs) {
  if (xs.length === 0) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: q(50), p95: q(95), p99: q(99),
    min: s[0], max: s[s.length - 1],
  };
}

// Domain-purity: fraction of a returned set whose domain == the query's target domain.
// Decomposes "weak precision" into wrong-domain contamination.
export function domainPurity(rows, targetDomain) {
  if (rows.length === 0) return 1;
  return rows.filter(r => r.domain === targetDomain).length / rows.length;
}

export function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
