# LoCoMo full-dataset results — 2026-07-14

Full run complete. Merge-enabled corpus, chunk-size 2, generation model Llama-4-Scout, judge Kimi K2.6.

## Overall

1963 scored, 23 judge failures (out of 1986 total questions across all 10 conversations).

**Overall accuracy: 37.2%**

| Category | Correct/Total | Accuracy |
|---|---|---|
| 1 — single-hop | 26/277 | 9.4% |
| 2 — temporal | 46/320 | 14.4% |
| 3 — multi-hop | 26/94 | 27.7% |
| 4 — open-domain | 251/835 | 30.1% |
| 5 — adversarial | 382/437 | 87.4% |

## Flagged for follow-up (not yet diagnosed)

**Category 1 (single-hop) is the worst-scoring category, worse than multi-hop (cat 3).** This is backwards from expectation — single-hop direct-fact-lookup should be the easiest category, and the existing root-cause theories from earlier sampling (dedup-collapse from chunking, list-incompleteness, cross-character confusion) explain multi-hop/list-style failures, not single-hop ones. Something specific to how category-1 questions are being scored or retrieved hasn't been identified yet. Worth a fresh, non-generic look — don't assume the existing theory covers this without checking real examples first.

## Where things live

- Full per-question results (answers, verdicts, reasoning): `bench/locomo/results-locomo-eval-c2.json` (gitignored, local only, ~1963 entries)
- No-merge counterfactual (partial, c2, 105 questions): `bench/locomo/results-locomo-eval-nomerge-c2-1783961166022.json`
- Eval harness: `bench/locomo/eval.mjs`, `bench/lib/judge.mjs`
- Dataset: `bench/locomo/data/locomo10.json` (gitignored, fetched via `fetch-dataset.mjs`)

## Reminder before this goes in a writeup

Findings from this benchmark should NOT drive production retrieval changes unless independently validated against the real gold-set benchmark corpus — this was an explicit agreed guardrail against Goodhart's-law-style benchmark-chasing. LoCoMo is a stress test for finding weaknesses, not a target to optimize against directly.

## Also still pending (unrelated to LoCoMo)

Clean up LoCoMo synthetic conversation data from the account (`memory_bulk_delete` by `project: 'locomo-eval'` and `project: 'locomo-eval-nomerge'`) — was blocked on this run finishing, now unblocked.
