import { describe, expect, it } from 'vitest';
import {
  type MicroCluster,
  addToMicros,
  applyMergeTrace,
  buildMergeTrace,
  clusterCountAtThreshold,
  finalizeClusters,
  newMicroFromRow,
  normalize,
} from './cluster';
import { dotProduct } from './embed';

function unit(v: number[]): number[] {
  return normalize(v);
}

// Seeded LCG so synthetic corpora are reproducible across runs
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Three well-separated topic groups in 8 dims: base direction + small noise
function syntheticCorpus(perGroup: number, seed = 42): { vectors: number[][]; group: number[] } {
  const rand = lcg(seed);
  const bases = [
    unit([1, 1, 0, 0, 0, 0, 0, 0]),
    unit([0, 0, 1, 1, 0, 0, 0, 0]),
    unit([0, 0, 0, 0, 1, 1, 0, 0]),
  ];
  const vectors: number[][] = [];
  const group: number[] = [];
  for (let g = 0; g < bases.length; g++) {
    for (let i = 0; i < perGroup; i++) {
      const v = bases[g].map(x => x + (rand() - 0.5) * 0.15);
      vectors.push(unit(v));
      group.push(g);
    }
  }
  return { vectors, group };
}

// ── normalize ──────────────────────────────────────────────────────────────

describe('normalize', () => {
  it('produces a unit vector', () => {
    const v = normalize([3, 4]);
    expect(Math.sqrt(v[0] ** 2 + v[1] ** 2)).toBeCloseTo(1, 10);
  });

  it('is safe on the zero vector', () => {
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

// ── addToMicros ────────────────────────────────────────────────────────────

describe('addToMicros', () => {
  it('creates the first micro-cluster from an empty list', () => {
    const micros: MicroCluster[] = [];
    const { idx, sim } = addToMicros(unit([1, 0, 0]), micros, 0.85);
    expect(idx).toBe(0);
    expect(sim).toBe(1);
    expect(micros).toHaveLength(1);
    expect(micros[0].count).toBe(1);
  });

  it('joins an existing micro-cluster above the threshold and updates sum/count/norm', () => {
    const micros: MicroCluster[] = [];
    const v = unit([1, 0.1, 0]);
    addToMicros(v, micros, 0.85);
    const { idx, sim } = addToMicros(v, micros, 0.85);
    expect(idx).toBe(0);
    expect(sim).toBeCloseTo(1, 10);
    expect(micros).toHaveLength(1);
    expect(micros[0].count).toBe(2);
    expect(micros[0].sum[0]).toBeCloseTo(2 * v[0], 10);
    expect(micros[0].norm).toBeCloseTo(2, 10);
  });

  it('starts a new micro-cluster below the threshold', () => {
    const micros: MicroCluster[] = [];
    addToMicros(unit([1, 0, 0]), micros, 0.85);
    const { idx } = addToMicros(unit([0, 1, 0]), micros, 0.85); // orthogonal
    expect(idx).toBe(1);
    expect(micros).toHaveLength(2);
  });
});

// ── buildMergeTrace ────────────────────────────────────────────────────────

describe('buildMergeTrace', () => {
  it('merge similarity equals the exact average pairwise cosine between clusters', () => {
    // Two singletons close together, one far away
    const a = unit([1, 0.05, 0]);
    const b = unit([1, -0.05, 0]);
    const c = unit([0, 0, 1]);
    const micros = [a, b, c].map(v => newMicroFromRow(v.slice(), 1));
    const trace = buildMergeTrace(micros, 0.5);
    expect(trace).toHaveLength(1); // c never clears the 0.5 floor
    expect(trace[0].a).toBe(0);
    expect(trace[0].b).toBe(1);
    expect(trace[0].sim).toBeCloseTo(dotProduct(a, b), 10);
  });

  it('computes average linkage exactly for multi-member clusters via sums', () => {
    // Cluster A = {a1, a2} as one micro (sum of members), B = {b} singleton
    const a1 = unit([1, 0.2, 0]);
    const a2 = unit([1, -0.2, 0]);
    const b = unit([0.8, 0.6, 0]);
    const microA = newMicroFromRow([a1[0] + a2[0], a1[1] + a2[1], a1[2] + a2[2]], 2);
    const microB = newMicroFromRow(b.slice(), 1);
    const trace = buildMergeTrace([microA, microB], 0.0);
    const expected = (dotProduct(a1, b) + dotProduct(a2, b)) / 2;
    expect(trace).toHaveLength(1);
    expect(trace[0].sim).toBeCloseTo(expected, 10);
  });

  it('produces non-increasing merge similarities (UPGMA monotonicity)', () => {
    const { vectors } = syntheticCorpus(6);
    const micros = vectors.map(v => newMicroFromRow(v.slice(), 1));
    const trace = buildMergeTrace(micros, 0.0);
    for (let i = 1; i < trace.length; i++) {
      expect(trace[i].sim).toBeLessThanOrEqual(trace[i - 1].sim + 1e-12);
    }
  });

  it('records no merges below the floor', () => {
    const micros = [unit([1, 0, 0]), unit([0, 1, 0])].map(v => newMicroFromRow(v.slice(), 1));
    expect(buildMergeTrace(micros, 0.5)).toHaveLength(0);
  });

  it('is deterministic across repeated runs', () => {
    const { vectors } = syntheticCorpus(5, 7);
    const t1 = buildMergeTrace(vectors.map(v => newMicroFromRow(v.slice(), 1)), 0.3);
    const t2 = buildMergeTrace(vectors.map(v => newMicroFromRow(v.slice(), 1)), 0.3);
    expect(t1).toEqual(t2);
  });
});

// ── applyMergeTrace / clusterCountAtThreshold ──────────────────────────────

describe('applyMergeTrace', () => {
  it('returns identity labels when threshold is above every merge', () => {
    const labels = applyMergeTrace(3, [{ a: 0, b: 1, sim: 0.9 }], 0.95);
    expect(labels).toEqual([0, 1, 2]);
  });

  it('applies only the trace prefix at or above the threshold', () => {
    const trace = [
      { a: 0, b: 1, sim: 0.9 },
      { a: 2, b: 3, sim: 0.7 },
    ];
    expect(applyMergeTrace(4, trace, 0.8)).toEqual([0, 0, 1, 2]);
    expect(applyMergeTrace(4, trace, 0.6)).toEqual([0, 0, 1, 1]);
  });

  it('label count matches clusterCountAtThreshold at every threshold', () => {
    const { vectors } = syntheticCorpus(4);
    const micros = vectors.map(v => newMicroFromRow(v.slice(), 1));
    const trace = buildMergeTrace(micros, 0.3);
    for (const t of [0.4, 0.6, 0.75, 0.9, 0.99]) {
      const labels = applyMergeTrace(micros.length, trace, t);
      expect(new Set(labels).size).toBe(clusterCountAtThreshold(micros.length, trace, t));
    }
  });
});

// ── finalizeClusters ───────────────────────────────────────────────────────

describe('finalizeClusters', () => {
  it('keeps clusters at or above minSize and folds small nearby clusters into them', () => {
    // Big cluster around [1,0,0]; a singleton close by; a far outlier singleton
    const big = newMicroFromRow([3, 0.1, 0], 3); // 3 members near x-axis
    const near = newMicroFromRow(unit([1, 0.3, 0]).slice(), 1);
    const far = newMicroFromRow(unit([0, 0, 1]).slice(), 1);
    const { microToFinal, clusters } = finalizeClusters([big, near, far], [0, 1, 2], 50, 3, 0.3);
    expect(clusters).toHaveLength(1);
    expect(microToFinal[0]).toBe(0);
    expect(microToFinal[1]).toBe(0); // folded into big
    expect(microToFinal[2]).toBe(-1); // genuine outlier → general
    expect(clusters[0].count).toBe(4); // fold updates the kept cluster's count
  });

  it('enforces the cluster cap, largest first', () => {
    const a = newMicroFromRow([5, 0, 0], 5);
    const b = newMicroFromRow([0, 0, 4], 4);
    const { clusters, microToFinal } = finalizeClusters([a, b], [0, 1], 1, 3, 0.99);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(5);
    expect(microToFinal[1]).toBe(-1); // b orthogonal to a, can't fold at 0.99
  });

  it('sends everything to general when no cluster reaches minSize', () => {
    const a = newMicroFromRow(unit([1, 0, 0]).slice(), 1);
    const b = newMicroFromRow(unit([0, 1, 0]).slice(), 1);
    const { clusters, microToFinal } = finalizeClusters([a, b], [0, 1], 50, 3, 0.3);
    expect(clusters).toHaveLength(0);
    expect(microToFinal).toEqual([-1, -1]);
  });
});

// ── end-to-end pipeline ────────────────────────────────────────────────────

describe('clustering pipeline', () => {
  function runPipeline(vectors: number[][], microThreshold: number, mergeThreshold: number): number[] {
    const micros: MicroCluster[] = [];
    const assign = vectors.map(v => addToMicros(v, micros, microThreshold).idx);
    const trace = buildMergeTrace(micros, 0.5);
    const labels = applyMergeTrace(micros.length, trace, mergeThreshold);
    const { microToFinal } = finalizeClusters(micros, labels, 50, 3, 0.3);
    return assign.map(mc => microToFinal[mc]);
  }

  it('recovers well-separated topic groups and is identical across reruns', () => {
    const { vectors, group } = syntheticCorpus(10, 99);
    const finals1 = runPipeline(vectors, 0.9, 0.75);
    const finals2 = runPipeline(vectors, 0.9, 0.75);
    expect(finals1).toEqual(finals2); // deterministic

    // Same group → same final cluster; different group → different final cluster
    for (let i = 0; i < vectors.length; i++) {
      for (let j = i + 1; j < vectors.length; j++) {
        if (group[i] === group[j]) expect(finals1[i]).toBe(finals1[j]);
        else expect(finals1[i]).not.toBe(finals1[j]);
      }
    }
    expect(finals1.every(f => f >= 0)).toBe(true); // no outliers in clean data
  });

  it('merge phase is invariant to micro-cluster order (partition equality)', () => {
    const { vectors } = syntheticCorpus(6, 13);
    const micros = vectors.map(v => newMicroFromRow(v.slice(), 1));
    const reversed = [...micros].reverse().map(m => newMicroFromRow(m.sum.slice(), m.count));

    const labels = applyMergeTrace(micros.length, buildMergeTrace(micros, 0.5), 0.75);
    const labelsRev = applyMergeTrace(reversed.length, buildMergeTrace(reversed, 0.5), 0.75);

    // Compare partitions: micro i in original = micro (n-1-i) reversed
    const n = micros.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const together = labels[i] === labels[j];
        const togetherRev = labelsRev[n - 1 - i] === labelsRev[n - 1 - j];
        expect(togetherRev).toBe(together);
      }
    }
  });
});
