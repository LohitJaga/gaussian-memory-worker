import { describe, it, expect } from 'vitest';
import { deriveAnchorName, bestAnchor, ANCHOR_FLOOR_SIM, ANCHOR_ACCEPT_SIM, DOMAIN_CAP } from './domain';

// ── deriveAnchorName ─────────────────────────────────────────────────────

describe('deriveAnchorName', () => {
  it('picks the first capitalized content word after the sentence starter', () => {
    expect(deriveAnchorName('Working on Cloudflare Workers today')).toBe('cloudflare');
  });

  it('skips the first token even when it is a valid capitalized word', () => {
    // "Purdue" is skipped as the sentence-starter; "Applied" is stop-worthy? no - falls to Statistics
    expect(deriveAnchorName('Purdue Applied Statistics coursework')).not.toBe('purdue');
  });

  it('skips a capitalized stop word and keeps scanning for the next candidate', () => {
    expect(deriveAnchorName('The Session Cloudflare update')).toBe('cloudflare');
  });

  it('falls back to a lowercase content word ≥5 chars when no capitalized match exists', () => {
    expect(deriveAnchorName('started crafting something wonderful today')).toBe('crafting');
  });

  it('FIXED: fallback pass case-folds before stripping, so a capitalized stop word ' +
     'is correctly recognized and skipped instead of corrupted (was "ession")', () => {
    // 'Session' and 'today' are both in ANCHOR_STOP; previously the 2nd-pass regex stripped
    // the leading 'S' via a lowercase-only character class (without lowercasing first),
    // producing the nonsense candidate 'ession' instead of correctly matching 'session' and
    // skipping it. Now it lowercases before stripping, so the stop word is recognized and
    // the scan correctly falls through to the last-resort pass, landing on 'long'.
    expect(deriveAnchorName('The Session today was long')).toBe('long');
  });

  it('falls back to any content word ≥4 chars as a last resort', () => {
    // all tokens are short/stop words except one 4-char non-stop word
    expect(deriveAnchorName('the a it lynx')).toBe('lynx');
  });

  it('returns a cluster_ timestamp fallback when nothing qualifies', () => {
    expect(deriveAnchorName('the a it is of')).toMatch(/^cluster_[a-z0-9]+$/);
  });

  it('strips punctuation before evaluating a token', () => {
    expect(deriveAnchorName('Working, Cloudflare! Workers.')).toBe('cloudflare');
  });

  it('is deterministic for the same input', () => {
    const text = 'Debugging the Vectorize index today';
    expect(deriveAnchorName(text)).toBe(deriveAnchorName(text));
  });
});

// ── bestAnchor ───────────────────────────────────────────────────────────

describe('bestAnchor', () => {
  it('returns null when there are no anchors', () => {
    expect(bestAnchor([1, 0, 0], [])).toBeNull();
  });

  it('picks the anchor with the highest dot-product similarity', () => {
    const anchors = [
      { name: 'low', emb: [0, 1, 0] },
      { name: 'high', emb: [1, 0, 0] },
      { name: 'mid', emb: [0.5, 0.5, 0] },
    ];
    const result = bestAnchor([1, 0, 0], anchors);
    expect(result).toEqual({ name: 'high', sim: 1 });
  });

  it('breaks ties by keeping the first anchor seen (strict > comparison)', () => {
    const anchors = [
      { name: 'first', emb: [1, 0, 0] },
      { name: 'second', emb: [1, 0, 0] },
    ];
    const result = bestAnchor([1, 0, 0], anchors);
    expect(result?.name).toBe('first');
  });

  it('returns the correct similarity score alongside the name', () => {
    const anchors = [{ name: 'only', emb: [0, 1] }];
    const result = bestAnchor([0, 2], anchors);
    expect(result).toEqual({ name: 'only', sim: 2 });
  });

  it('FIXED: a lone anchor at exactly sim=-1 is now selected instead of returning null', () => {
    // Previously bestSim started at -1 with a strict ">" compare, so dotProduct === -1
    // exactly (-1 > -1 is false) meant bestName never got set. Sentinel is now -Infinity,
    // so any real similarity — including exactly -1 — always wins on the first anchor seen.
    const anchors = [{ name: 'opposite', emb: [-1, 0, 0] }];
    const result = bestAnchor([1, 0, 0], anchors);
    expect(result).toEqual({ name: 'opposite', sim: -1 });
  });
});

// ── module constants (guard against accidental drift) ─────────────────────

describe('domain constants', () => {
  it('keeps the floor strictly below the accept threshold', () => {
    expect(ANCHOR_FLOOR_SIM).toBeLessThan(ANCHOR_ACCEPT_SIM);
  });

  it('keeps DOMAIN_CAP a sane positive number', () => {
    expect(DOMAIN_CAP).toBeGreaterThan(0);
  });
});
