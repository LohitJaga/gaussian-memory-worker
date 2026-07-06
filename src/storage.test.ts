import { describe, it, expect } from 'vitest';
import { isContradiction, normalizeForExactMatch, NEGATION } from './storage';

// ── isContradiction ──────────────────────────────────────────────────────

describe('isContradiction', () => {
  it('is false below the 0.88 cosine similarity floor, regardless of negation', () => {
    expect(isContradiction('switched from Postgres to D1', 'using Postgres', 0.87)).toBe(false);
  });

  it('is true when similar text disagrees on negation (switched away vs still using)', () => {
    expect(isContradiction('switched from GLM to Llama for classification', 'using GLM for classification', 0.9)).toBe(true);
  });

  it('is false when both sides agree on negation (both switched, or neither did)', () => {
    expect(isContradiction('using Llama for classification', 'using Llama for inference', 0.9)).toBe(false);
    expect(isContradiction('stopped using GLM entirely', 'no longer using GLM at all', 0.95)).toBe(false);
  });

  it('is true right at the 0.88 boundary (inclusive)', () => {
    expect(isContradiction('removed the old cron job', 'the cron job runs nightly', 0.88)).toBe(true);
  });

  it('is case-insensitive on the negation pattern', () => {
    expect(isContradiction('SWITCHED FROM Postgres', 'using Postgres for storage', 0.9)).toBe(true);
  });
});

describe('NEGATION pattern', () => {
  it('matches each documented negation phrase', () => {
    const phrases = [
      'no longer', 'stop using', 'stopped using', "don't use", 'switched from',
      'instead of', 'avoid using', "shouldn't use", 'never use', 'removed',
      'disabled', 'deprecated',
    ];
    for (const p of phrases) expect(NEGATION.test(`some text with ${p} something`)).toBe(true);
  });

  it('does not false-positive on unrelated text', () => {
    expect(NEGATION.test('added a new feature for caching')).toBe(false);
  });
});

// ── normalizeForExactMatch ───────────────────────────────────────────────

describe('normalizeForExactMatch', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeForExactMatch('Fixed bug!')).toBe('fixed bug');
  });

  it('collapses repeated whitespace to single spaces', () => {
    expect(normalizeForExactMatch('too   many    spaces')).toBe('too many spaces');
  });

  it('trims leading/trailing whitespace', () => {
    expect(normalizeForExactMatch('  padded text  ')).toBe('padded text');
  });

  it('treats trivially-different surface forms as identical', () => {
    expect(normalizeForExactMatch('Fixed the bug!')).toBe(normalizeForExactMatch('fixed the bug'));
  });

  it('keeps digits', () => {
    expect(normalizeForExactMatch('Commit f542266 pushed')).toBe('commit f542266 pushed');
  });
});
