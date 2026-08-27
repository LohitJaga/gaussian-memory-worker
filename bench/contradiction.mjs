// Contradiction surface rate — "when the retrieval pipeline still has access to a
// memory that's been marked stale/superseded, does it leak through as if it were
// current truth, or does the system correctly signal that it's stale?"
//
// Two distinct, separately-testable failure modes, driven by valid_to:
//   HARD-EXCLUSION pairs (old.valid_to already in the past): the WHERE clause in
//   retrieval.ts should keep the old memory out of results entirely. FAIL = it still
//   appears at all (the exclusion isn't working).
//   SOFT-TAG pairs (old.valid_to still null -- pre-expiry or never scheduled): the old
//   memory may still be a live candidate. PASS if absent OR present-but-[SUPERSEDED]-
//   tagged; FAIL only if it appears with no tag (silent leak -- stale info presented
//   as current fact, indistinguishable from a live memory).
//
// Gold set: every real memory_relations row with relation_type='supersedes' in the live
// production D1 database as of 2026-08-12 (13 rows, the whole table, not a sample) --
// see bench/gold/contradiction_gold.json for the full methodology note and per-pair
// category (genuine_contradiction / borderline / near_duplicate / false_positive). Only
// 1-2 of the 13 are actual semantic contradictions; report both the full-set rate and
// the genuine-contradiction-only rate, and say so plainly -- this is the same n=1-2
// honesty standard this repo already applies to its own multihop gold set.
//
// Runs against the live memory_retrieve tool (not the frozen /bench/retrieve endpoint):
// the [SUPERSEDED] tag and valid_to exclusion are the same production code path a real
// hook call hits, and this benchmark is specifically about that real-world behavior, not
// an isolated scoring metric. top_k is set high (25) to give the old memory every
// reasonable chance to surface if it's still a live candidate at all -- a low top_k
// producing an "absent" result would be a retrieval-depth artifact, not evidence the
// exclusion/tagging logic works.
//
// IMPORTANT — read before trusting a "FAIL-leaked-past-exclusion" result at face value.
// First run (2026-08-12) found 3 of these; root-caused all 3 via direct D1 queries before
// reporting them (see BENCHMARKING.md's contradiction-surface-rate section for the full
// trace). None were a bug in the valid_to WHERE clause itself -- retrieval.ts's id-based
// fetch (the query with `AND (valid_to IS NULL OR valid_to > ?)`) correctly excluded every
// row it was asked to exclude. What actually happened: a single real event got captured
// into 3-4 near-duplicate memory rows across different domains at write time (a known,
// separately-documented duplicate-accumulation gap -- see BENCHMARKING.md's landscape
// research and TODO.md's manual near-dup cleanup history), memory_judge/isContradiction
// only found and linked SOME of those duplicates via a `supersedes` relation, and the
// untracked twin rows -- which were never flagged, never got valid_to set, never entered
// memory_relations at all -- still surface normally, carrying the same underlying fact.
// So a FAIL here does not by itself mean "the exclusion mechanism is broken" -- verify
// with a direct query for near-duplicate untracked rows (`SELECT id, valid_to, text FROM
// memories WHERE text LIKE '%<shared phrase>%'`) before concluding it's a retrieval bug
// rather than a duplicate-detection gap. This distinction matters enough to check every
// time, not just this once -- don't skip it on a future run's failures.
//
// NOT IDEMPOTENT -- re-running this script changes what the next run sees. Because it
// calls the live memory_retrieve tool (deliberately, per the reasoning above) rather than
// the frozen /bench/retrieve endpoint, every run sharpens sigma / bumps access_count on
// whatever it retrieves -- the exact "confirmed contamination" class of issue already
// documented for the OTHER bench scripts (see retrieval.ts's own comment on why
// quality.mjs/ablation.mjs added a `frozen` mode in the first place). Confirmed directly:
// the first run of this benchmark (2026-08-12) scored 10/13 with 3 leaks; a later re-run
// against the SAME unchanged gold pairs (verified via direct D1 query -- the untracked
// duplicate rows behind the 3 leaks were still present, unlinked, un-excluded) scored
// 13/13, because the several live memory_retrieve calls in between had shifted which rows
// ranked into the top 25. Report a range across multiple runs, not a single count, and
// don't quietly re-run this to "improve" a number before writing it up -- the act of
// running it changes the corpus.
//
// Usage: node bench/contradiction.mjs [--gold bench/gold/contradiction_gold.json]

import { readFileSync } from 'node:fs';
import { loadEnv, callTool } from './lib/client.mjs';

const arg = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const GOLD_PATH = arg('--gold', 'bench/gold/contradiction_gold.json');
const TOP_K = Number(arg('--topk', '25'));

async function main() {
  const env = loadEnv();
  const gold = JSON.parse(readFileSync(GOLD_PATH, 'utf8'));

  console.log(`Gold set: ${gold.version} (${gold.pairs.length} pairs) top_k=${TOP_K}`);
  console.log(`Target:   ${env.url}\n`);

  const results = [];

  for (const pair of gold.pairs) {
    const { text } = await callTool('memory_retrieve', { query: pair.query, top_k: TOP_K }, env);

    // Presence + tag check against the raw text block (same format the hooks parse):
    // a line is "this pair's old memory" if it contains a long-enough verbatim slice of
    // old_text -- substring match on the first ~60 chars is enough to identify it without
    // needing IDs on this text-only path, and avoids false-matching short shared phrases.
    const needle = pair.old_text.slice(0, 60).toLowerCase();
    const lines = text.split('\n');
    const hitLine = lines.find(l => l.toLowerCase().includes(needle));
    const present = Boolean(hitLine);
    const tagged = present && hitLine.includes('[SUPERSEDED]');

    // hardExclusionExpected: the old memory's valid_to already elapsed per the gold
    // snapshot -- retrieval.ts's WHERE clause should keep it out of the candidate pool
    // entirely, independent of the [SUPERSEDED] tag (which only applies to memories
    // still inside the candidate pool).
    const hardExclusionExpected = pair.old_valid_to_past !== false; // default true unless explicitly marked

    let outcome;
    if (hardExclusionExpected) {
      outcome = present ? 'FAIL-leaked-past-exclusion' : 'PASS-excluded';
    } else {
      outcome = !present ? 'PASS-absent' : (tagged ? 'PASS-tagged' : 'FAIL-silent-leak');
    }

    results.push({ ...pair, present, tagged, hardExclusionExpected, outcome });
    console.log(`${pair.id} [${pair.category}] ${outcome}${present ? (tagged ? ' (tagged)' : ' (untagged)') : ''}`);
  }

  console.log('\n=== Results ===\n');

  const fails = results.filter(r => r.outcome.startsWith('FAIL'));
  console.log(`Overall (all ${results.length} pairs, regardless of category): ${results.length - fails.length}/${results.length} pass`);
  if (fails.length) {
    console.log('  Failures:');
    for (const f of fails) console.log(`    ${f.id} [${f.category}]: ${f.outcome} -- "${f.old_text.slice(0, 80)}"`);
  }

  const genuine = results.filter(r => r.category === 'genuine_contradiction' || r.category === 'borderline');
  const genuineFails = genuine.filter(r => r.outcome.startsWith('FAIL'));
  console.log(`\nGenuine-contradiction-only (n=${genuine.length}, category=genuine_contradiction|borderline): ${genuine.length - genuineFails.length}/${genuine.length} pass`);
  console.log('  ** n is very small -- do not generalize a rate from this alone. **');
  for (const g of genuine) console.log(`    ${g.id} [${g.category}]: ${g.outcome}`);

  const byCat = {};
  for (const r of results) {
    byCat[r.category] ??= { pass: 0, total: 0 };
    byCat[r.category].total++;
    if (!r.outcome.startsWith('FAIL')) byCat[r.category].pass++;
  }
  console.log('\nBy category:');
  for (const [cat, { pass, total }] of Object.entries(byCat)) {
    console.log(`  ${cat}: ${pass}/${total}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
