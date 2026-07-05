import { dotProduct } from './embed';

// Deterministic embedding clustering — no RNG, no LLM. Shared by the full-rebuild
// pipeline (rebuild.ts, phases 1+2 below) and the live per-memory microcluster
// signal (microcluster.ts, phase 1 only — see addToMicros).
//
// Phase 1 (leader pass): stream memories in fixed rowid order into tight
// micro-clusters. Phase 2 (UPGMA): exact average-linkage agglomerative merging
// over the micro-cluster sums. For L2-normalized member vectors the average
// pairwise cosine between two clusters is exactly dot(sumA, sumB) / (nA * nB),
// so merging on (sum, count) computes exact average linkage over the original
// memory vectors — the micro-cluster stage loses no precision in phase 2.
// Average linkage is monotone (merge similarities never increase), so one merge
// trace down to a floor yields the clustering at ANY threshold above it.

// Leader-pass admission: micro-clusters are near-identical topics (dedup fires
// at 0.90-0.93 in this corpus, so 0.85 sits just below the duplicate band).
// Canonical home for this constant — both the full-rebuild scan phase and the
// live per-memory assignment (microcluster.ts) must use the same number so a
// memory's live cluster assignment matches what a full rebuild would give it.
export const DEFAULT_MICRO_THRESHOLD = 0.85;

export interface MicroCluster {
  sum: number[]; // sum of member unit vectors (not normalized)
  count: number;
  norm: number; // cached |sum| — recompute via newMicroFromRow after deserialize
}

export interface Merge {
  a: number; // surviving cluster (original micro index)
  b: number; // absorbed cluster
  sim: number; // average pairwise cosine between the two clusters at merge time
}

export function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / norm);
}

export function newMicroFromRow(sum: number[], count: number): MicroCluster {
  return { sum, count, norm: Math.sqrt(sum.reduce((s, x) => s + x * x, 0)) || 1 };
}

// Assign one unit vector to its nearest micro-cluster (cosine vs normalized
// mean), or start a new one when nothing clears the threshold. Mutates micros.
export function addToMicros(
  mu: number[],
  micros: MicroCluster[],
  threshold: number,
): { idx: number; sim: number } {
  let bestIdx = -1;
  let bestSim = -1;
  for (let i = 0; i < micros.length; i++) {
    const sim = dotProduct(mu, micros[i].sum) / micros[i].norm;
    if (sim > bestSim) {
      bestSim = sim;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0 && bestSim >= threshold) {
    const m = micros[bestIdx];
    for (let d = 0; d < m.sum.length; d++) m.sum[d] += mu[d];
    m.count++;
    m.norm = Math.sqrt(m.sum.reduce((s, x) => s + x * x, 0)) || 1;
    return { idx: bestIdx, sim: bestSim };
  }
  micros.push(newMicroFromRow(mu.slice(), 1));
  return { idx: micros.length - 1, sim: 1 };
}

// Full UPGMA merge trace down to `floor`. Ties break on lowest (i, j) pair, so
// output is fully deterministic for a given micro-cluster list.
export function buildMergeTrace(micros: MicroCluster[], floor: number): Merge[] {
  const k = micros.length;
  if (k < 2) return [];
  const sums = micros.map(m => m.sum.slice());
  const counts = micros.map(m => m.count);
  const alive = new Array<boolean>(k).fill(true);
  const sims = new Float64Array(k * k);
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      sims[i * k + j] = dotProduct(sums[i], sums[j]) / (counts[i] * counts[j]);
    }
  }

  const trace: Merge[] = [];
  while (true) {
    let bi = -1;
    let bj = -1;
    let best = floor;
    for (let i = 0; i < k; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < k; j++) {
        if (!alive[j]) continue;
        if (sims[i * k + j] > best) {
          best = sims[i * k + j];
          bi = i;
          bj = j;
        }
      }
    }
    if (bi < 0) break;

    trace.push({ a: bi, b: bj, sim: best });
    for (let d = 0; d < sums[bi].length; d++) sums[bi][d] += sums[bj][d];
    counts[bi] += counts[bj];
    alive[bj] = false;
    for (let m = 0; m < k; m++) {
      if (!alive[m] || m === bi) continue;
      const lo = Math.min(bi, m);
      const hi = Math.max(bi, m);
      sims[lo * k + hi] = dotProduct(sums[bi], sums[m]) / (counts[bi] * counts[m]);
    }
  }
  return trace;
}

// Replay the trace prefix with sim >= threshold via union-find. Monotonicity of
// average linkage makes prefix replay exactly equal to stopping at threshold.
// Labels are compacted in first-occurrence (micro index) order.
export function applyMergeTrace(k: number, trace: Merge[], threshold: number): number[] {
  const parent = Array.from({ length: k }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) {
      parent[r] = parent[parent[r]];
      r = parent[r];
    }
    return r;
  };
  for (const m of trace) {
    if (m.sim < threshold) break;
    parent[find(m.b)] = find(m.a);
  }
  const labels = new Array<number>(k);
  const seen = new Map<number, number>();
  for (let i = 0; i < k; i++) {
    const r = find(i);
    let label = seen.get(r);
    if (label === undefined) {
      label = seen.size;
      seen.set(r, label);
    }
    labels[i] = label;
  }
  return labels;
}

export function clusterCountAtThreshold(k: number, trace: Merge[], threshold: number): number {
  let merges = 0;
  for (const m of trace) {
    if (m.sim < threshold) break;
    merges++;
  }
  return k - merges;
}

export interface FinalCluster {
  sum: number[];
  count: number;
  micros: number[]; // micro-cluster indices belonging to this final cluster
}

// Apply size floor + domain cap. Clusters below minSize (or beyond the cap) get
// folded into the nearest kept cluster when average-linkage sim clears
// remapFloor, otherwise their micros map to -1 ("general") — genuine outliers
// stay outliers instead of being force-fitted into a wrong domain.
export function finalizeClusters(
  micros: MicroCluster[],
  labels: number[],
  maxClusters: number,
  minSize: number,
  remapFloor: number,
): { microToFinal: number[]; clusters: FinalCluster[] } {
  const byLabel = new Map<number, FinalCluster & { label: number }>();
  for (let i = 0; i < micros.length; i++) {
    let c = byLabel.get(labels[i]);
    if (!c) {
      c = { sum: new Array(micros[i].sum.length).fill(0), count: 0, micros: [], label: labels[i] };
      byLabel.set(labels[i], c);
    }
    for (let d = 0; d < micros[i].sum.length; d++) c.sum[d] += micros[i].sum[d];
    c.count += micros[i].count;
    c.micros.push(i);
  }

  const ordered = [...byLabel.values()].sort((x, y) => y.count - x.count || x.label - y.label);
  const kept = ordered.filter(c => c.count >= minSize).slice(0, maxClusters);
  const keptSet = new Set(kept);

  for (const c of ordered) {
    if (keptSet.has(c)) continue;
    let bestIdx = -1;
    let bestSim = -1;
    for (let j = 0; j < kept.length; j++) {
      const sim = dotProduct(c.sum, kept[j].sum) / (c.count * kept[j].count);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = j;
      }
    }
    if (bestIdx >= 0 && bestSim >= remapFloor) {
      const t = kept[bestIdx];
      for (let d = 0; d < t.sum.length; d++) t.sum[d] += c.sum[d];
      t.count += c.count;
      t.micros.push(...c.micros);
    }
    // else: micros stay at -1 → general
  }

  const microToFinal = new Array<number>(micros.length).fill(-1);
  kept.forEach((c, j) => {
    for (const m of c.micros) microToFinal[m] = j;
  });
  return { microToFinal, clusters: kept.map(({ sum, count, micros: ms }) => ({ sum, count, micros: ms })) };
}
