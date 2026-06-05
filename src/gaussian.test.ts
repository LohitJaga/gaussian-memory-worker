import { describe, it, expect } from 'vitest';
import {
  bhattacharyyaDistance,
  kalmanMerge,
  shouldMerge,
  sharpenSigma,
  decaySigma,
  initialSigma,
  cosine,
  meanSigma,
  serializeSigma,
  deserializeSigma,
  distributionalScore,
} from './gaussian';

// ── bhattacharyyaDistance ──────────────────────────────────────────────────

describe('bhattacharyyaDistance', () => {
  it('returns 0 for identical distributions (distinct objects)', () => {
    const mu = new Float32Array([0.1, 0.5, 0.9]);
    const sigma = new Float32Array([0.3, 0.3, 0.3]);
    // Use copies — not same reference — to defeat reference-equality shortcuts
    expect(bhattacharyyaDistance(mu, sigma, new Float32Array(mu), new Float32Array(sigma))).toBeCloseTo(0, 4);
  });

  it('pins exact formula value for 1-D equal-sigma case', () => {
    // mu1=0, mu2=1, sigma=0.5 both: term1 = 0.125 * (1/0.5) * 1 = 0.25, term2 = 0
    const mu1 = new Float32Array([0.0]);
    const mu2 = new Float32Array([1.0]);
    const sigma = new Float32Array([0.5]);
    expect(bhattacharyyaDistance(mu1, sigma, mu2, new Float32Array(sigma))).toBeCloseTo(0.25, 4);
  });

  it('pins exact formula value with UNEQUAL sigmas — tests term2 (log term)', () => {
    // mu1=mu2=0, sigmaA=0.2, sigmaB=0.8 → term1=0, sigmaAvg=0.5
    // term2 = 0.5 * ln(0.5 / sqrt(0.2*0.8)) = 0.5 * ln(0.5/0.4) = 0.5 * ln(1.25) ≈ 0.5 * 0.22314 ≈ 0.11157
    const mu = new Float32Array([0.0]);
    const sigmaA = new Float32Array([0.2]);
    const sigmaB = new Float32Array([0.8]);
    expect(bhattacharyyaDistance(mu, sigmaA, new Float32Array(mu), sigmaB)).toBeCloseTo(0.11157, 3);
  });

  it('is symmetric — D(A,B) === D(B,A)', () => {
    const muA = new Float32Array([0.2, 0.8]);
    const sigmaA = new Float32Array([0.3, 0.4]);
    const muB = new Float32Array([0.7, 0.3]);
    const sigmaB = new Float32Array([0.5, 0.2]);
    const dAB = bhattacharyyaDistance(muA, sigmaA, muB, sigmaB);
    const dBA = bhattacharyyaDistance(muB, sigmaB, muA, sigmaA);
    expect(dAB).toBeCloseTo(dBA, 5);
    expect(dAB).toBeGreaterThan(0); // also verify non-trivial
  });

  it('does not mutate inputs', () => {
    const muA = new Float32Array([0.3]);
    const sigmaA = new Float32Array([0.4]);
    const muB = new Float32Array([0.7]);
    const sigmaB = new Float32Array([0.5]);
    const origMuA = muA[0], origSigmaA = sigmaA[0];
    bhattacharyyaDistance(muA, sigmaA, muB, sigmaB);
    expect(muA[0]).toBe(origMuA);
    expect(sigmaA[0]).toBe(origSigmaA);
  });
});

// ── kalmanMerge ────────────────────────────────────────────────────────────

describe('kalmanMerge', () => {
  it('pins exact Kalman sigma formula: 1/(1/sigmaA + 1/sigmaB)', () => {
    const muA = new Float32Array([0.5]);
    const sigmaA = new Float32Array([0.4]);
    const muB = new Float32Array([0.6]);
    const sigmaB = new Float32Array([0.3]);
    const [, sigmaNew] = kalmanMerge(muA, sigmaA, muB, sigmaB);
    // 1 / (1/0.4 + 1/0.3) = 1 / (2.5 + 3.333) = 1/5.833 ≈ 0.1714
    expect(sigmaNew[0]).toBeCloseTo(0.1714, 3);
  });

  it('merged sigma is lower than both inputs', () => {
    const muA = new Float32Array([0.5]);
    const sigmaA = new Float32Array([0.4]);
    const muB = new Float32Array([0.6]);
    const sigmaB = new Float32Array([0.3]);
    const [, sigmaNew] = kalmanMerge(muA, sigmaA, muB, sigmaB);
    expect(sigmaNew[0]).toBeLessThan(0.3);
    expect(sigmaNew[0]).toBeLessThan(0.4);
  });

  it('merged mean is midpoint when sigmas are equal', () => {
    const muA = new Float32Array([0.0]);
    const muB = new Float32Array([1.0]);
    const sigma = new Float32Array([0.5]);
    const [muNew] = kalmanMerge(muA, sigma, muB, new Float32Array(sigma));
    expect(muNew[0]).toBeCloseTo(0.5, 4);
  });

  it('pins exact Kalman mu when sigmas differ', () => {
    const muA = new Float32Array([0.0]);
    const sigmaA = new Float32Array([0.1]);
    const muB = new Float32Array([1.0]);
    const sigmaB = new Float32Array([0.9]);
    const [muNew, sigmaNew] = kalmanMerge(muA, sigmaA, muB, sigmaB);
    // sigmaNew = 1/(10+1.111) = 0.09, muNew = 0.09*(0/0.1 + 1/0.9) ≈ 0.09*1.111 ≈ 0.1
    expect(sigmaNew[0]).toBeCloseTo(1 / (10 + 1 / 0.9), 3);
    expect(muNew[0]).toBeCloseTo(sigmaNew[0] * (0 / 0.1 + 1.0 / 0.9), 3);
    expect(muNew[0]).toBeLessThan(0.5); // pulled toward the sharper muA
  });

  it('merging identical distributions halves sigma exactly', () => {
    const mu = new Float32Array([0.5]);
    const sigma = new Float32Array([0.4]);
    const [muNew, sigmaNew] = kalmanMerge(mu, sigma, new Float32Array(mu), new Float32Array(sigma));
    expect(muNew[0]).toBeCloseTo(0.5, 4);
    expect(sigmaNew[0]).toBeCloseTo(0.2, 4);
  });

  it('verifies correctness at multiple dimensions independently', () => {
    const muA = new Float32Array([0.0, 0.5]);
    const sigmaA = new Float32Array([0.2, 0.4]);
    const muB = new Float32Array([1.0, 0.5]);
    const sigmaB = new Float32Array([0.2, 0.4]);
    const [muNew, sigmaNew] = kalmanMerge(muA, sigmaA, muB, sigmaB);
    expect(muNew[0]).toBeCloseTo(0.5, 4);  // midpoint
    expect(muNew[1]).toBeCloseTo(0.5, 4);  // same
    expect(sigmaNew[0]).toBeCloseTo(0.1, 4); // halved
    expect(sigmaNew[1]).toBeCloseTo(0.2, 4); // halved
  });

  it('does not mutate inputs', () => {
    const muA = new Float32Array([0.3]);
    const sigmaA = new Float32Array([0.4]);
    const origMuA = muA[0];
    kalmanMerge(muA, sigmaA, new Float32Array([0.7]), new Float32Array([0.3]));
    expect(muA[0]).toBe(origMuA);
  });
});

// ── sharpenSigma ───────────────────────────────────────────────────────────

describe('sharpenSigma', () => {
  it('applies factor 0.85 exactly when above floor', () => {
    const sigma = new Float32Array([0.5]);
    const result = sharpenSigma(sigma, 0.85, 0.15, false, 50);
    expect(result[0]).toBeCloseTo(0.5 * 0.85, 4); // 0.425
  });

  it('clamps to floor when factor would go below it', () => {
    const sigma = new Float32Array([0.16]); // 0.16 * 0.85 = 0.136 < 0.15 floor
    const result = sharpenSigma(sigma, 0.85, 0.15, false, 50);
    expect(result[0]).toBeCloseTo(0.15, 3);
  });

  it('does NOT apply floor when value*factor stays above floor', () => {
    const sigma = new Float32Array([0.5]);
    const result = sharpenSigma(sigma, 0.85, 0.15, false, 50);
    expect(result[0]).toBeCloseTo(0.425, 4); // not 0.15
  });

  it('WIDENS sigma by exactly 1.2x when contradicted', () => {
    const sigma = new Float32Array([0.3]);
    const widened = sharpenSigma(sigma, 0.85, 0.15, true);
    expect(widened[0]).toBeCloseTo(0.3 * 1.2, 4); // 0.36
  });

  it('contradiction widen caps at exactly 1.5', () => {
    const sigma = new Float32Array([1.4]); // 1.4 * 1.2 = 1.68 > 1.5
    const widened = sharpenSigma(sigma, 0.85, 0.15, true);
    expect(widened[0]).toBeCloseTo(1.5, 3);
  });

  it('sparse domain (< 5): applies factor correctly above floor', () => {
    const sigma = new Float32Array([0.5]); // above 0.35 floor
    const result = sharpenSigma(sigma, 0.85, 0.15, false, 3);
    expect(result[0]).toBeCloseTo(0.5 * 0.85, 4); // factor applies, not floor
  });

  it('sparse domain (< 5): clamps to 0.35 floor', () => {
    const sigma = new Float32Array([0.1]); // below 0.35 floor
    const result = sharpenSigma(sigma, 0.85, 0.15, false, 3);
    expect(result[0]).toBeGreaterThanOrEqual(0.349); // Float32 precision
  });

  it('medium domain (5-14): applies factor correctly above 0.25 floor', () => {
    const sigma = new Float32Array([0.5]);
    const result = sharpenSigma(sigma, 0.85, 0.15, false, 10);
    expect(result[0]).toBeCloseTo(0.5 * 0.85, 4);
  });

  it('does not mutate input', () => {
    const sigma = new Float32Array([0.5]);
    sharpenSigma(sigma);
    expect(sigma[0]).toBe(0.5);
  });
});

// ── decaySigma ─────────────────────────────────────────────────────────────

describe('decaySigma', () => {
  it('increases by exactly delta', () => {
    const sigma = new Float32Array([0.4]);
    const decayed = decaySigma(sigma, 0.05);
    expect(decayed[0]).toBeCloseTo(0.45, 5);
  });

  it('uses default delta of 0.02', () => {
    const sigma = new Float32Array([0.3]);
    const decayed = decaySigma(sigma);
    expect(decayed[0]).toBeCloseTo(0.32, 5);
  });

  it('increment is bounded — not arbitrarily large', () => {
    const sigma = new Float32Array([0.3, 0.5]);
    const decayed = decaySigma(sigma);
    for (let i = 0; i < sigma.length; i++) {
      expect(decayed[i]).toBeLessThan(sigma[i] + 0.05); // default delta is 0.02
    }
  });

  it('does not mutate input', () => {
    const sigma = new Float32Array([0.4]);
    decaySigma(sigma);
    expect(sigma[0]).toBeCloseTo(0.4, 5); // Float32 precision: toBe fails for 0.4
  });
});

// ── shouldMerge ────────────────────────────────────────────────────────────

describe('shouldMerge', () => {
  it('returns true for identical distributions (distinct objects)', () => {
    const mu = new Float32Array([0.5, 0.5]);
    const sigma = new Float32Array([0.3, 0.3]);
    expect(shouldMerge(mu, sigma, new Float32Array(mu), new Float32Array(sigma))).toBe(true);
  });

  it('returns false for very different distributions', () => {
    const muA = new Float32Array([0.0, 0.0]);
    const muB = new Float32Array([1.0, 1.0]);
    const sigma = new Float32Array([0.2, 0.2]);
    expect(shouldMerge(muA, sigma, muB, new Float32Array(sigma))).toBe(false);
  });

  it('threshold controls the exact boundary (strict <)', () => {
    const muA = new Float32Array([0.3]);
    const muB = new Float32Array([0.4]);
    const sigma = new Float32Array([0.5]);
    const dist = bhattacharyyaDistance(muA, sigma, muB, new Float32Array(sigma));
    expect(shouldMerge(muA, sigma, muB, new Float32Array(sigma), dist + 0.001)).toBe(true);
    expect(shouldMerge(muA, sigma, muB, new Float32Array(sigma), dist - 0.001)).toBe(false);
    // exact equality should return false (strict <)
    expect(shouldMerge(muA, sigma, muB, new Float32Array(sigma), dist)).toBe(false);
  });
});

// ── meanSigma ──────────────────────────────────────────────────────────────

describe('meanSigma', () => {
  it('returns correct mean', () => {
    const sigma = new Float32Array([0.2, 0.4, 0.6]);
    expect(meanSigma(sigma)).toBeCloseTo(0.4, 5);
  });

  it('returns the value itself for single element', () => {
    const sigma = new Float32Array([0.7]);
    expect(meanSigma(sigma)).toBeCloseTo(0.7, 5);
  });
});

// ── initialSigma ───────────────────────────────────────────────────────────

describe('initialSigma', () => {
  it('returns base 0.5 for zero emotional intensity', () => {
    const sigma = initialSigma('test', 0.0, 3);
    expect(sigma[0]).toBeCloseTo(0.5, 5);
  });

  it('halves sigma for high intensity > 0.7', () => {
    expect(initialSigma('test', 0.9, 1)[0]).toBeCloseTo(0.25, 5);
  });

  it('boundary at exactly 0.7 is medium tier (not high)', () => {
    expect(initialSigma('test', 0.7, 1)[0]).toBeCloseTo(0.375, 5); // 0.5 * 0.75
  });

  it('medium intensity 0.4-0.7 gives 0.75x base', () => {
    expect(initialSigma('test', 0.5, 1)[0]).toBeCloseTo(0.375, 5);
  });

  it('boundary at exactly 0.4 is base tier — implementation uses strict > 0.4', () => {
    expect(initialSigma('test', 0.4, 1)[0]).toBeCloseTo(0.5, 5);
  });

  it('intensity just below 0.4 gives base 0.5', () => {
    expect(initialSigma('test', 0.39, 1)[0]).toBeCloseTo(0.5, 5);
  });

  it('returns array of correct dimension', () => {
    expect(initialSigma('test', 0.0, 5).length).toBe(5);
  });
});

// ── cosine ─────────────────────────────────────────────────────────────────

describe('cosine', () => {
  it('returns correct dot product for non-trivial vectors', () => {
    const a = new Float32Array([0.5, 0.3]);
    const b = new Float32Array([0.4, 0.6]);
    // 0.5*0.4 + 0.3*0.6 = 0.2 + 0.18 = 0.38
    expect(cosine(a, b)).toBeCloseTo(0.38, 4);
  });

  it('returns 1 for identical unit vectors (distinct objects)', () => {
    const a = new Float32Array([1, 0, 0]);
    expect(cosine(a, new Float32Array(a))).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0, 5);
  });

  it('accumulation loop runs all dimensions', () => {
    // [1,1,1] · [1,1,1] = 3 — broken single-element loop returns 1
    const a = new Float32Array([1, 1, 1]);
    expect(cosine(a, new Float32Array(a))).toBeCloseTo(3, 5);
  });
});

// ── distributionalScore ────────────────────────────────────────────────────

describe('distributionalScore', () => {
  it('returns 1.0 for perfect cosine match with equal sigma', () => {
    // cosineSim=1 → muDistSq=0, equal sigmas → term2=0 → exp(0)=1
    expect(distributionalScore(1.0, 0.4, 0.4)).toBeCloseTo(1.0, 5);
  });

  it('returns < 1 when cosine is less than perfect', () => {
    expect(distributionalScore(0.8, 0.4, 0.4)).toBeLessThan(1.0);
    expect(distributionalScore(0.8, 0.4, 0.4)).toBeGreaterThan(0);
  });

  it('penalizes sigma mismatch — high-sigma memory scores lower than matched', () => {
    const matched = distributionalScore(0.9, 0.3, 0.3);
    const mismatched = distributionalScore(0.9, 0.3, 0.9); // vague memory, specific query
    expect(mismatched).toBeLessThan(matched);
  });

  it('vague query + vague memory scores higher than sharp query + sharp memory at same cosine', () => {
    const vagueBoth = distributionalScore(0.85, 0.8, 0.8);
    const sharpBoth = distributionalScore(0.85, 0.3, 0.3);
    // large sigmaAvg attenuates term1 (cosine distance penalty), so vague pairs score higher
    // at the same cosine similarity — vague queries correctly surface uncertain memories
    expect(vagueBoth).toBeGreaterThan(sharpBoth);
  });

  it('output is always in (0, 1] range', () => {
    const cases = [
      [1.0, 0.5, 0.5], [0.5, 0.3, 0.8], [0.0, 0.4, 0.4], [0.99, 0.2, 0.6],
    ];
    for (const [c, qs, ms] of cases) {
      const s = distributionalScore(c, qs, ms);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(1.0);
    }
  });

  it('returns 0.5 neutral score when memorySigma is 0 (corrupted DB row guard)', () => {
    expect(distributionalScore(0.9, 0.4, 0)).toBe(0.5);
  });

  it('returns 0.5 neutral score when memorySigma is NaN (empty sigma_diagonal guard)', () => {
    expect(distributionalScore(0.9, 0.4, NaN)).toBe(0.5);
  });

  it('clips negative cosine to 0 (no negative muDistSq)', () => {
    const neg = distributionalScore(-0.5, 0.4, 0.4);
    const zero = distributionalScore(0.0, 0.4, 0.4);
    // both produce muDistSq=2 since Math.max(0, cosineSim) clamps both to 0
    expect(neg).toBeCloseTo(zero, 5);
  });
});

// ── serialization round-trip ───────────────────────────────────────────────

describe('serializeSigma / deserializeSigma', () => {
  it('round-trips without loss', () => {
    const original = new Float32Array([0.1, 0.3, 0.5, 0.7, 0.9]);
    const restored = deserializeSigma(serializeSigma(original));
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  it('pins exact base64 length: 4 bytes per float32, ceil(4n/3)*4 chars', () => {
    // 1 element = 4 bytes → base64 length = 8 chars (with padding)
    expect(serializeSigma(new Float32Array([0.5])).length).toBe(8);
    // 3 elements = 12 bytes → 16 chars
    expect(serializeSigma(new Float32Array([0.1, 0.2, 0.3])).length).toBe(16);
  });

  it('different values produce different serializations', () => {
    expect(serializeSigma(new Float32Array([0.1]))).not.toBe(serializeSigma(new Float32Array([0.9])));
  });

  it('round-trip preserves identity: deserialize(serialize(x)) == x', () => {
    const x = new Float32Array([0.42, 0.13, 0.77]);
    const rt = deserializeSigma(serializeSigma(x));
    for (let i = 0; i < x.length; i++) expect(rt[i]).toBeCloseTo(x[i], 5);
  });
});
