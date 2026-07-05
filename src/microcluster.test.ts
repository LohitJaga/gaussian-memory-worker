import { describe, expect, it } from 'vitest';
import { updatedMicroClusterRow } from './microcluster';
import { addToMicros, newMicroFromRow, normalize } from './cluster';
import { dotProduct } from './embed';

function unit(v: number[]): number[] {
  return normalize(v);
}

describe('updatedMicroClusterRow', () => {
  it('adds the new member to sum and increments count', () => {
    const existingSum = unit([1, 0, 0]);
    const v = unit([1, 0.1, 0]);
    const updated = updatedMicroClusterRow(existingSum, 1, v);
    expect(updated.count).toBe(2);
    expect(updated.sum[0]).toBeCloseTo(existingSum[0] + v[0], 10);
    expect(updated.sum[1]).toBeCloseTo(existingSum[1] + v[1], 10);
  });

  it('recomputes norm to match the updated sum', () => {
    const existingSum = unit([1, 0, 0]);
    const v = unit([0.9, 0.2, 0]);
    const updated = updatedMicroClusterRow(existingSum, 1, v);
    const expectedNorm = Math.sqrt(updated.sum.reduce((s, x) => s + x * x, 0));
    expect(updated.norm).toBeCloseTo(expectedNorm, 10);
  });

  it('matches addToMicros\'s own accept-branch math exactly (same code path, not reimplemented)', () => {
    const existingSum = unit([1, 0.05, 0]);
    const existingCount = 3;
    const v = unit([1, -0.05, 0]);

    const viaHelper = updatedMicroClusterRow(existingSum, existingCount, v);

    const micros = [newMicroFromRow(existingSum.slice(), existingCount)];
    addToMicros(v, micros, -Infinity);
    const viaDirect = micros[0];

    expect(viaHelper.sum).toEqual(viaDirect.sum);
    expect(viaHelper.count).toBe(viaDirect.count);
    expect(viaHelper.norm).toBeCloseTo(viaDirect.norm, 10);
  });

  it('is a pure function — does not mutate the input sum array', () => {
    const existingSum = unit([1, 0, 0]);
    const original = existingSum.slice();
    updatedMicroClusterRow(existingSum, 1, unit([0.9, 0.1, 0]));
    expect(existingSum).toEqual(original);
  });

  it('handles repeated updates consistently with average-linkage expectations', () => {
    // Three near-identical members folded in one at a time should end up with
    // a centroid direction close to all three, not skewed toward the last one.
    const a = unit([1, 0.1, 0]);
    const b = unit([1, -0.1, 0]);
    const c = unit([1, 0, 0.05]);

    let row = { sum: a.slice(), count: 1 };
    row = updatedMicroClusterRow(row.sum, row.count, b);
    row = updatedMicroClusterRow(row.sum, row.count, c);

    expect(row.count).toBe(3);
    const centroid = normalize(row.sum);
    // Centroid should be closer to each member than an unrelated orthogonal vector
    const unrelated = unit([0, 0, 1]);
    for (const member of [a, b, c]) {
      expect(dotProduct(centroid, member)).toBeGreaterThan(dotProduct(centroid, unrelated));
    }
  });
});
