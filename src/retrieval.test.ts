import { describe, it, expect } from 'vitest';
import {
  RRF_K, rrfMerge, minMaxNormalize, tokenize, jaccardSimilarity,
  dedupBySimilarity, sigmaGate, applyDiversityCap, DEDUP_COS,
} from './retrieval';

// Map.get() is typed as T | undefined; these tests assert the key was just inserted,
// so a thrown error here means the test setup itself is wrong, not a null-safety gap.
function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('expected map entry to be present');
  return v;
}

// ── rrfMerge ─────────────────────────────────────────────────────────────

describe('rrfMerge', () => {
  const atRank = (id: string, rank: number) => Array(rank).fill('filler').concat([id]);

  it('scores rank 0 in a single list as 1/(k+1)', () => {
    const scores = rrfMerge([['a', 'b']]);
    expect(scores.get('a')).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(scores.get('b')).toBeCloseTo(1 / (RRF_K + 2), 10);
  });

  it('sums contributions when an id appears in multiple lists', () => {
    const scores = rrfMerge([['a', 'b'], ['b', 'a']]);
    // a: rank0 in list1 + rank1 in list2; b: rank1 in list1 + rank0 in list2 — symmetric, equal totals
    expect(scores.get('a')).toBeCloseTo(must(scores.get('b')), 10);
    expect(scores.get('a')).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2), 10);
  });

  it('gives an id appearing only once a lower score than one appearing in every list', () => {
    const scores = rrfMerge([['a', 'x'], ['a', 'y'], ['a', 'z']]);
    expect(must(scores.get('a'))).toBeGreaterThan(must(scores.get('x')));
  });

  it('rewards better rank when list-participation count is equal', () => {
    const scores = rrfMerge([
      atRank('top', 0), atRank('top', 0), atRank('top', 0),
      atRank('deep', 49), atRank('deep', 49), atRank('deep', 49),
    ]);
    expect(must(scores.get('top'))).toBeGreaterThan(must(scores.get('deep')));
  });

  it('lets enough list-participation outweigh a single top rank (a known RRF property)', () => {
    // 'deep' appears near the bottom of 3 lists; 'top' appears at rank 0 of just 1 list.
    // Cumulative participation can beat a single best rank — this is expected RRF behavior,
    // not a bug, and worth pinning so it doesn't get "fixed" by accident later.
    const scores = rrfMerge([atRank('top', 0), atRank('deep', 49), atRank('deep', 49), atRank('deep', 49)]);
    expect(must(scores.get('deep'))).toBeGreaterThan(must(scores.get('top')));
  });

  it('returns an empty map for empty input', () => {
    expect(rrfMerge([]).size).toBe(0);
    expect(rrfMerge([[], []]).size).toBe(0);
  });

  it('respects a custom k', () => {
    const scores = rrfMerge([['a']], 10);
    expect(scores.get('a')).toBeCloseTo(1 / 11, 10);
  });
});

// ── minMaxNormalize ──────────────────────────────────────────────────────

describe('minMaxNormalize', () => {
  it('maps the min to 0 and the max to 1', () => {
    expect(minMaxNormalize([1, 5, 10])).toEqual([0, 4 / 9, 1]);
  });

  it('maps a constant array to all 1s (not 0s or NaN)', () => {
    expect(minMaxNormalize([3, 3, 3])).toEqual([1, 1, 1]);
  });

  it('handles a single-element array', () => {
    expect(minMaxNormalize([7])).toEqual([1]);
  });

  it('preserves relative order', () => {
    const result = minMaxNormalize([10, 2, 6]);
    expect(result[1]).toBeLessThan(result[2]);
    expect(result[2]).toBeLessThan(result[0]);
  });
});

// ── tokenize / jaccardSimilarity ─────────────────────────────────────────

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumeric characters', () => {
    expect(tokenize('Hello, World!')).toEqual(new Set(['hello', 'world']));
  });

  it('strips bracketed tags like [SUPERSEDED] before tokenizing', () => {
    expect(tokenize('[SUPERSEDED] some memory text here')).toEqual(
      new Set(['some', 'memory', 'text', 'here'])
    );
  });

  it('drops words of length <= 3', () => {
    expect(tokenize('a to the big idea')).toEqual(new Set(['idea']));
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1 for identical sets', () => {
    const a = new Set(['alpha', 'beta']);
    expect(jaccardSimilarity(a, new Set(a))).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    expect(jaccardSimilarity(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('returns 0 when either set is empty', () => {
    expect(jaccardSimilarity(new Set(), new Set(['a']))).toBe(0);
    expect(jaccardSimilarity(new Set(['a']), new Set())).toBe(0);
  });

  it('computes intersection-over-union for partial overlap', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    // intersection={b,c}=2, union={a,b,c,d}=4 -> 0.5
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5, 10);
  });
});

// ── dedupBySimilarity ────────────────────────────────────────────────────

describe('dedupBySimilarity', () => {
  it('keeps the first (highest-scored) of near-identical vectors, drops the rest', () => {
    const list = [
      { text: 'first copy', vector: [1, 0, 0] },
      { text: 'near duplicate', vector: [0.99, 0.01, 0] }, // cosine > 0.85 vs [1,0,0]
      { text: 'unrelated', vector: [0, 1, 0] },
    ];
    const result = dedupBySimilarity(list);
    expect(result.map(r => r.text)).toEqual(['first copy', 'unrelated']);
  });

  it('falls back to token-Jaccard when either item has no vector', () => {
    const list = [
      { text: 'quick brown fox jumps over lazy sleepy hound', vector: [] },
      { text: 'quick brown fox jumps over lazy sleepy mound', vector: [] }, // 6/8 tokens shared = 0.75 > 0.72
      { text: 'something totally unrelated content entirely', vector: [] },
    ];
    const result = dedupBySimilarity(list);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('quick brown fox jumps over lazy sleepy hound');
  });

  it('keeps all items when nothing is similar', () => {
    const list = [
      { text: 'apple orange banana grapefruit', vector: [1, 0] },
      { text: 'car truck bicycle motorcycle', vector: [0, 1] },
    ];
    expect(dedupBySimilarity(list)).toHaveLength(2);
  });

  it('handles an empty list', () => {
    expect(dedupBySimilarity([])).toEqual([]);
  });

  it('respects a custom cosine threshold', () => {
    // dotProduct([1,0,0], [0.9,0.436,0]) ≈ 0.9 — above the default 0.85 bar (dedups),
    // but below a stricter custom 0.95 bar (should NOT dedup).
    const list = [
      { text: 'first copy', vector: [1, 0, 0] },
      { text: 'somewhat similar', vector: [0.9, 0.436, 0] },
    ];
    expect(dedupBySimilarity(list, 0.95)).toHaveLength(2);
    expect(dedupBySimilarity(list, 0.85)).toHaveLength(1);
  });

  it('respects a custom text-Jaccard threshold', () => {
    const list = [
      { text: 'quick brown fox jumps over lazy sleepy hound', vector: [] },
      { text: 'quick brown fox jumps over lazy sleepy mound', vector: [] }, // jaccard = 0.75
    ];
    const strict = dedupBySimilarity(list, DEDUP_COS, 0.9); // 0.75 < 0.9 -> not a dup
    expect(strict).toHaveLength(2);
    const loose = dedupBySimilarity(list, DEDUP_COS, 0.7); // 0.75 > 0.7 -> dup
    expect(loose).toHaveLength(1);
  });
});

// ── sigmaGate ────────────────────────────────────────────────────────────

describe('sigmaGate', () => {
  const item = (sigma: number) => ({ sigma: new Float32Array([sigma, sigma, sigma]) });

  it('keeps items at or below the ceiling for a precise (low sigma) query', () => {
    const items = [item(0.2), item(0.9)];
    // querySigmaVal=0.1 -> ceiling = max(0.65, 0.18) = 0.65
    const result = sigmaGate(items, 0.1, 2);
    expect(result).toHaveLength(2); // falls back to slice since only 1 passes the gate (< minResults)
  });

  it('filters out high-sigma items once the gated set meets minResults', () => {
    const items = [item(0.2), item(0.3), item(0.9)];
    const result = sigmaGate(items, 0.1, 2);
    expect(result).toEqual([item(0.2), item(0.3)]);
  });

  it('never returns fewer than minResults even if nothing passes the gate', () => {
    const items = [item(0.9), item(0.95), item(0.99)];
    const result = sigmaGate(items, 0.1, 2);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('scales the ceiling up for vague (high sigma) queries', () => {
    const items = [item(0.2), item(1.0)]; // 1.0 only passes when querySigmaVal is high
    const result = sigmaGate(items, 0.9, 2); // ceiling = max(0.65, 1.62) = 1.62
    expect(result).toHaveLength(2);
  });

  it('returns exactly minResults when the gate filters everything and minResults is customized', () => {
    // Fallback is max(minResults, ceil(items.length/2)); with 4 items ceil(4/2)=2, so
    // minResults below 2 doesn't shrink the result — minResults above 2 does grow it.
    const items = [item(0.9), item(0.95), item(0.99), item(0.99)];
    expect(sigmaGate(items, 0.1, 1)).toHaveLength(2);
    expect(sigmaGate(items, 0.1, 3)).toHaveLength(3);
  });

  it('respects a custom floor/multiplier for the sigma ceiling', () => {
    // 3 items so the gated set already meets minResults=2 either way — isolates the
    // floor's effect from the "fall back to a slice" branch tested elsewhere.
    const items = [item(0.3), item(0.5), item(0.9)];
    expect(sigmaGate(items, 0.1, 2, 0.65)).toEqual([item(0.3), item(0.5)]); // default floor gates out 0.9
    expect(sigmaGate(items, 0.1, 2, 1.0)).toEqual(items); // custom floor=1.0 keeps everything
  });
});

// ── applyDiversityCap ────────────────────────────────────────────────────

describe('applyDiversityCap', () => {
  const mem = (type: string, cluster_id: string | null) => ({ type, cluster_id });

  it('caps session-type items at the session limit (default 2)', () => {
    const items = [mem('session', null), mem('session', null), mem('session', null)];
    const result = applyDiversityCap(items);
    expect(result).toHaveLength(2);
  });

  it('caps non-session items at the higher default limit (4)', () => {
    const items = Array(5).fill(null).map(() => mem('episodic', null));
    const result = applyDiversityCap(items);
    expect(result).toHaveLength(4);
  });

  it('caps items sharing a cluster_id at the cluster limit (default 3)', () => {
    const items = [
      mem('episodic', 'c1'), mem('episodic', 'c1'), mem('episodic', 'c1'), mem('episodic', 'c1'),
    ];
    const result = applyDiversityCap(items);
    expect(result).toHaveLength(3);
  });

  it('exempts items with no cluster_id from the cluster cap', () => {
    const items = Array(4).fill(null).map(() => mem('episodic', null));
    const result = applyDiversityCap(items);
    expect(result).toHaveLength(4); // only the type cap (4) applies, not the cluster cap
  });

  it('preserves input order for items that pass', () => {
    const items = [mem('episodic', 'a'), mem('episodic', 'b'), mem('episodic', 'a')];
    const result = applyDiversityCap(items);
    expect(result).toEqual(items);
  });

  it('respects custom limit overrides', () => {
    const items = [mem('session', null), mem('session', null)];
    const result = applyDiversityCap(items, 1, 4, 3);
    expect(result).toHaveLength(1);
  });
});
