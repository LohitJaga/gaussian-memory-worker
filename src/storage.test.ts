import { describe, it, expect } from 'vitest';
import { isContradiction, normalizeForExactMatch, NEGATION, UNRESOLVED, RESOLVED, resolveSupersedeDirection, buildKeywordQuery } from './storage';

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

  it('is true when similar text disagrees on resolution status (the real domain-rebuild case)', () => {
    expect(isContradiction(
      'domain split resolved 2026-07-05',
      'domain rebuild still has major issues, dont trust this',
      0.9,
    )).toBe(true);
  });

  it('is true for a fixed/still-broken pair regardless of which side is newText', () => {
    expect(isContradiction('the cron job is fixed now', 'the cron job still has issues', 0.9)).toBe(true);
    expect(isContradiction('the cron job still has issues', 'the cron job is fixed now', 0.9)).toBe(true);
  });

  it('is false when both sides agree on resolution status', () => {
    expect(isContradiction('the cron job is fixed', 'the cron job is now working', 0.9)).toBe(false);
    expect(isContradiction('the cron job still has issues', 'the cron job is not working', 0.9)).toBe(false);
  });

  it('status-flip class fires below the 0.88 NEGATION floor, down to its own 0.75 floor', () => {
    // Same pair as the boundary test above, but well under 0.88 — reworded pairs often land here.
    expect(isContradiction('the cron job is fixed now', 'the cron job still has issues', 0.80)).toBe(true);
    expect(isContradiction('the cron job is fixed now', 'the cron job still has issues', 0.75)).toBe(true);
  });

  it('status-flip class is false below its own 0.75 floor', () => {
    expect(isContradiction('the cron job is fixed now', 'the cron job still has issues', 0.74)).toBe(false);
  });

  it('negation class still requires 0.88 even though status floor is lower (no status words present)', () => {
    expect(isContradiction('switched from Postgres to D1', 'using Postgres', 0.80)).toBe(false);
  });

  // Regression for a real bug found 2026-07-07 (code review): RESOLVED's bare `fixed`/`resolved`
  // used to match inside UNRESOLVED's own "not fixed" phrase, so two memories that both say
  // "not fixed" (i.e. AGREE the issue is unresolved) would satisfy RESOLVED on one side and
  // UNRESOLVED on the other and get falsely flagged as contradicting each other.
  it('is false when both sides say "not fixed" (agreeing, not contradicting)', () => {
    expect(isContradiction('the login bug is not fixed yet', 'the login bug is still not fixed', 0.9)).toBe(false);
  });

  it('is false when both sides say "not resolved" (agreeing, not contradicting)', () => {
    expect(isContradiction('the issue is not resolved', 'the issue is still not resolved', 0.9)).toBe(false);
  });

  it('RESOLVED does not match negated forms (not fixed, isn\'t fixed, never fixed, not resolved)', () => {
    expect(RESOLVED.test('the bug is not fixed')).toBe(false);
    expect(RESOLVED.test("the bug isn't fixed")).toBe(false);
    expect(RESOLVED.test('the bug was never fixed')).toBe(false);
    expect(RESOLVED.test('the bug is not resolved')).toBe(false);
  });

  it('RESOLVED still matches unnegated fixed/resolved', () => {
    expect(RESOLVED.test('the bug is fixed')).toBe(true);
    expect(RESOLVED.test('the bug is resolved')).toBe(true);
  });

  // Regression for a real bug found 2026-07-07 (fresh code review, round 2): the negative
  // lookbehinds above only excluded a negator directly adjacent to fixed/resolved — an
  // intervening word ("not YET fixed", "never REALLY resolved") defeated them, since those are
  // natural, common phrasings, not edge cases.
  it('RESOLVED does not match negation with an intervening word', () => {
    expect(RESOLVED.test('the bug is not yet fixed')).toBe(false);
    expect(RESOLVED.test('this was never really resolved')).toBe(false);
    expect(RESOLVED.test('the bug has not been fixed')).toBe(false);
    expect(RESOLVED.test("isn't really fixed")).toBe(false);
    expect(RESOLVED.test('not fully resolved')).toBe(false);
  });

  it('is false when both sides disagree only by an intervening negation word (agreeing, not contradicting)', () => {
    expect(isContradiction('the cron job is not yet fixed', 'the cron job still has issues', 0.9)).toBe(false);
  });

  // Regression for a real bug found 2026-07-07 (fresh code review, round 2): UNRESOLVED's
  // optional article only matched "an ", not "a ", so the common singular phrasing "still has a
  // major issue" silently failed to match.
  it('UNRESOLVED matches "a" as well as "an" before a singular noun', () => {
    expect(UNRESOLVED.test('login flow still has a major issue')).toBe(true);
    expect(UNRESOLVED.test('login flow still has an issue')).toBe(true);
  });

  it('is true for a fixed/still-has-a-major-issue pair (singular, correct article)', () => {
    expect(isContradiction('the login flow is fixed now', 'the login flow still has a major issue', 0.9)).toBe(true);
  });
});

// ── resolveSupersedeDirection ────────────────────────────────────────────
// Regression coverage for a real bug found 2026-07-07: memory_judge always inserted
// memory_relations as (target -> cand), but target is always the OLDER side when pulled from
// the contradiction_flag=1 auto-queue — so the surviving/current memory (to_id) got mislabeled
// [SUPERSEDED] instead of the stale one. This must always resolve to (newer -> older) regardless
// of which one was labeled target/cand.

describe('resolveSupersedeDirection', () => {
  it('orients (newer -> older) when target is the older side', () => {
    const target = { id: 'old', timestamp: 100 };
    const cand = { id: 'new', timestamp: 200 };
    expect(resolveSupersedeDirection(target, cand)).toEqual({
      fromId: 'new', toId: 'old', olderId: 'old', newerId: 'new',
    });
  });

  it('orients (newer -> older) when target is the newer side (opposite input order)', () => {
    const target = { id: 'new', timestamp: 200 };
    const cand = { id: 'old', timestamp: 100 };
    expect(resolveSupersedeDirection(target, cand)).toEqual({
      fromId: 'new', toId: 'old', olderId: 'old', newerId: 'new',
    });
  });

  it('treats equal timestamps as target being the older side (stable tie-break)', () => {
    const target = { id: 'a', timestamp: 500 };
    const cand = { id: 'b', timestamp: 500 };
    expect(resolveSupersedeDirection(target, cand)).toEqual({
      fromId: 'b', toId: 'a', olderId: 'a', newerId: 'b',
    });
  });
});

// ── buildKeywordQuery ────────────────────────────────────────────────────
// Regression coverage for a real bug found 2026-07-07: the first version passed raw memory text
// (with its natural punctuation) directly as an FTS5 MATCH query, which threw syntax errors on
// real text (confirmed live against D1 — colons and commas both tripped the parser) and, even
// when it didn't error, FTS5's implicit AND between barewords meant a 70-word query essentially
// never matched anything. Every query this function builds must be syntactically safe and must
// use OR (partial keyword overlap), not AND (near-impossible full-text overlap).

describe('buildKeywordQuery', () => {
  it('produces a quoted, OR-joined query safe for real memory text with FTS5-special characters', () => {
    const text = 'Decided to delay the ship — doesn\'t feel comfortable: known bugs, especially "domain rebuild" instability (regrounding+merge, 15/31/49).';
    const q = buildKeywordQuery(text);
    expect(q).not.toContain(':');
    expect(q).not.toContain('(');
    expect(q).not.toContain(')');
    // every term must be quoted and OR-joined, never bare/AND-joined
    expect(q.split(' OR ').every(term => /^"[a-z0-9]+"$/.test(term))).toBe(true);
  });

  it('prioritizes longer/more specific words over short common ones when truncating', () => {
    // Real 76-word memory where "domain"/"rebuild"/"instability" appear only in the second
    // half — first-N-in-sentence-order (the reverted approach) cut them off entirely at the
    // default maxTerms, since the first dozen-plus unique 4+ char words are all short filler
    // ("decided", "delay", "july", "gaussian", "memory", "ship", "feel", "comfortable", ...).
    const text = 'Decided to delay the July 1 Gaussian Memory ship — doesn\'t feel comfortable shipping with '
      + 'known bugs, especially the domain rebuild instability (classifier lands on wildly different '
      + 'domain counts run to run) regrounding merge fix implemented but verdict was domains still have '
      + 'major issues with both false positive merges and false negative misses at the same threshold.';
    const q = buildKeywordQuery(text);
    expect(q).toContain('"instability"');
    expect(q).toContain('"domain"');
    expect(q).toContain('"rebuild"');
  });

  it('excludes stopwords and short words', () => {
    const q = buildKeywordQuery('the cron job is now fixed and it was not working before');
    expect(q).not.toContain('"the"');
    expect(q).not.toContain('"now"');
    expect(q).not.toContain('"not"');
    expect(q).not.toContain('"was"');
  });

  it('returns empty string for text with no qualifying terms', () => {
    expect(buildKeywordQuery('a to it is')).toBe('');
  });

  it('dedupes repeated terms', () => {
    const q = buildKeywordQuery('rebuild rebuild rebuild domain');
    expect(q.split(' OR ').length).toBe(2);
  });
});

describe('UNRESOLVED / RESOLVED patterns', () => {
  it('UNRESOLVED matches each documented phrase', () => {
    const phrases = [
      'still has major issues', 'still has an issue', 'still issues', 'still broken',
      "doesn't work", 'does not work', 'not working', 'unresolved', 'known issue',
      "don't trust this", 'not fixed',
    ];
    for (const p of phrases) expect(UNRESOLVED.test(`some text with ${p} here`)).toBe(true);
  });

  it('RESOLVED matches each documented phrase', () => {
    const phrases = [
      'fixed', 'resolved', 'now works', 'works now',
      'verified working', 'verified fixed', 'confirmed working', 'confirmed fixed',
    ];
    for (const p of phrases) expect(RESOLVED.test(`some text with ${p} here`)).toBe(true);
  });

  it('do not false-positive on unrelated text', () => {
    expect(UNRESOLVED.test('added a new feature for caching')).toBe(false);
    expect(RESOLVED.test('added a new feature for caching')).toBe(false);
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

// ── selectMergeCandidate (project-scoped merge eligibility, 2026-07-17) ────

import { selectMergeCandidate } from './storage';
import { serializeSigma, initialSigma } from './gaussian';

describe('selectMergeCandidate', () => {
  const sig = serializeSigma(initialSigma('default', 0, 4));
  const row = (project: string, cluster_id: string | null = null) =>
    ({ sigma_diagonal: sig, text: 'x', cluster_id, project });

  it('selects the closest same-project candidate', () => {
    const rowMap = new Map([
      ['m1', row('default')],
      ['m2', row('default')],
    ]);
    const r = selectMergeCandidate(
      [{ id: 'm1', score: 0.92 }, { id: 'm2', score: 0.98 }],
      rowMap, 'default', null, 'episodic'
    );
    expect(r.bestId).toBe('m2');
    expect(r.bestSigma).not.toBeNull();
  });

  it('FIXED: a cross-project candidate is never a merge winner, even when it is the closest', () => {
    // Pre-fix the LoCoMo-shaped hazard: project='locomo-eval' chunk at cosine 0.99
    // beat a same-project candidate and the merge UPDATE then overwrote the winner's
    // text/domain/vector while its D1 project column stayed untouched.
    const rowMap = new Map([
      ['theirs', row('locomo-eval')],
      ['ours', row('default')],
    ]);
    const r = selectMergeCandidate(
      [{ id: 'theirs', score: 0.99 }, { id: 'ours', score: 0.90 }],
      rowMap, 'default', null, 'episodic'
    );
    expect(r.bestId).toBe('ours');
  });

  it('returns no candidate when every match belongs to another project', () => {
    const rowMap = new Map([['theirs', row('locomo-eval')]]);
    const r = selectMergeCandidate([{ id: 'theirs', score: 0.99 }], rowMap, 'default', null, 'episodic');
    expect(r).toEqual({ bestId: null, bestSigma: null });
  });

  it('project scoping is exact — "default" stores do not merge into named-project rows either', () => {
    const rowMap = new Map([['proj', row('gaussian-memory-worker')]]);
    const r = selectMergeCandidate([{ id: 'proj', score: 0.99 }], rowMap, 'default', null, 'episodic');
    expect(r.bestId).toBeNull();
  });

  it('DECISION (2026-07-17): a named-project store does not absorb a default row — the asymmetric ' +
     'named-into-default rule was evaluated and rejected', () => {
    // This is the direction an asymmetric rule would have allowed, and it is the exact
    // incident vector: 'locomo-eval' is a named project, so named→default permission
    // hands synthetic corpora destructive write access to the default bucket (46% of
    // the corpus). Restatement duplication is accepted here and collapsed
    // non-destructively at retrieval (dedupBySimilarity).
    const rowMap = new Map([['globalfact', row('default')]]);
    const r = selectMergeCandidate([{ id: 'globalfact', score: 0.99 }], rowMap, 'locomo-eval', null, 'episodic');
    expect(r.bestId).toBeNull();
  });

  it('DECISION (2026-07-17): no named↔named merging — the measured duplication pattern is ' +
     'cwd-noise across arbitrary named projects, which no default-special rule would fix', () => {
    // Live data: the same fact stored under loreal-internship AND leetcode-practice
    // (project tags follow the session's working directory, not content). Merging
    // across named projects would move content between buckets other projects cannot
    // see into (named-context reads are own+default only).
    const rowMap = new Map([['theirs', row('leetcode-practice')]]);
    const r = selectMergeCandidate([{ id: 'theirs', score: 0.99 }], rowMap, 'loreal-internship', null, 'episodic');
    expect(r.bestId).toBeNull();
  });

  it('keeps the strict cross-cluster ceiling (0.97) for non-session types', () => {
    const rowMap = new Map([['m1', row('default', 'cluster-a')]]);
    const r = selectMergeCandidate([{ id: 'm1', score: 0.95 }], rowMap, 'default', 'cluster-b', 'episodic');
    expect(r.bestId).toBeNull(); // 0.95 < 0.97, different cluster → not a candidate
  });

  it('keeps the looser cross-cluster ceiling (0.90) for session summaries', () => {
    const rowMap = new Map([['m1', row('default', 'cluster-a')]]);
    const r = selectMergeCandidate([{ id: 'm1', score: 0.95 }], rowMap, 'default', 'cluster-b', 'session');
    expect(r.bestId).toBe('m1'); // 0.95 >= 0.90 → session summaries still collapse across clusters
  });

  it('ignores matches with no fetched row', () => {
    const r = selectMergeCandidate([{ id: 'ghost', score: 0.99 }], new Map(), 'default', null, 'episodic');
    expect(r.bestId).toBeNull();
  });
});
