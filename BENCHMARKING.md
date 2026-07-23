# Gaussian Memory — Benchmarking Plan

**Plan revised:** July 8, 2026 · **Landscape research (Part 2):** compiled June 15, 2026

> Part 1 below is the **plan of record**. It supersedes the June 15 §8 ordering
> ("run LoCoMo first"), which was backwards for our constraints: LoCoMo is the one
> benchmark that (a) costs paid API and (b) measures generic fact-recall — the axis
> where we can only score "parity" and which showcases *none* of what we built.
> Part 2 (the original research) is retained unchanged as reference/citations.

---

# Part 1 — The Plan (of record)

## Guiding principles

1. **Free-first.** Lead with metrics that cost $0 and show our differentiators. The
   one paid benchmark (LoCoMo, needs an LLM judge) is last and optional.
2. **Standard benchmarks measure the wrong axis for us.** LoCoMo/LongMemEval test
   "did it recall the right fact." Our edge — σ confidence, contradiction handling,
   temporal validity, decay — needs metrics we build ourselves. No public benchmark
   covers staleness or contradiction, which is precisely the community's top pain.
3. **Publish the harness, report where we're weak.** Include adversarial/contradiction
   cases; report precision honestly (see below). The Mem0/Zep credibility dispute
   (Part 2 §7) means any hidden weakness gets found and discredits the whole post.

## Known bias: recall-favoring by design → how we handle weak precision

Retrieval is **threshold-based** (all memories above a score floor, not fixed top-k —
`retrieval.ts` threshold path), plus **spreading activation** pulls in entity-graph
neighbors (`retrieval.ts:319`) and the **Bhattacharyya multiplier** admits fuzzy/high-σ
memories on vague queries (`retrieval.ts:391-392`). Over a 4,715-memory store with many
near-duplicate session summaries, this is a deliberately wide net: **high recall,
diluted set-precision.** This is a chosen tradeoff, so we measure it as a tunable curve,
not a single number:

1. **No single precision number.** Precision is a function of the score floor → report a
   **Precision–Recall curve swept over the threshold**, plus PR-AUC.
2. **Headline top-heavy ranking metrics: nDCG@k and MRR.** For LLM-context memory, what
   matters is *the right memory ranked near the top* and *present at all*; the model
   tolerates a few extra items. These stay high even when tail junk drags set-precision
   down — separating "bad retrieval" from "correct-but-verbose retrieval."
3. **Set-precision reported but de-emphasized.** We still publish it (hiding it is what
   Mem0/Zep got caught doing) — just not as the headline.
4. **Token-per-query** as the honest precision proxy — weak precision = more junk tokens.
   Collected for free during the retrieval run; every competitor reports it.
5. **Decompose precision misses** into **domain-contamination** (wrong-domain memory in
   the set → scoring/threshold fix) vs **near-duplicate flooding** (dup session summaries
   → dedup fix). Report *domain-purity* and *dup-rate* of the returned set separately so
   the number is actionable, not just a verdict.

## Metric set (precise definitions)

| Metric | Definition | Cost |
|---|---|---|
| Recall@k | fraction of gold memories present in top-k | $0 |
| Precision@k | fraction of top-k that are gold | $0 |
| MRR | mean of 1/rank of first gold memory | $0 |
| nDCG@k | rank-discounted gain, gold-graded | $0 |
| PR-AUC | area under P–R curve swept over score floor | $0 |
| tokens/query | total chars/tokens of returned set (precision proxy) | $0 |
| domain-purity | fraction of returned set in the query's target domain | $0 |
| dup-rate | fraction of returned set that are near-duplicates of another hit | $0 |
| p50/p95/p99 latency | wall-clock of live `memory_retrieve` calls | $0 |

## Ground-truth construction (no paid API)

Build a ~50-query labeled set from the existing 4,715-memory store, each query tagged with
its gold memory ID(s):
- **Decisions / topic_key upserts** — memories with a `topic_key` or `memory_type=decision`
  give an unambiguous target ("what did I decide about D1 vs PlanetScale" → known row).
- **Entity-graph neighborhoods** — for a seed memory, its 1-hop entity neighbors are the
  expected co-retrievals; validates spreading activation directly.
- **Domain spot-checks** — a query clearly scoped to one of the 47 domains; anything
  returned from another domain counts against domain-purity.
Embeddings run on our own Worker AI (effectively $0); no external judge needed for Tier 1–2.

## Tier 1 — free, do first (highest ROI)

| # | Benchmark | Output | Cost |
|---|---|---|---|
| 1 | **Latency p50/p95/p99** vs live Worker (vary top-k, cold/warm KV) | edge-latency table — our hard differentiator vs Mem0/Zep cloud APIs | $0 |
| 2 | **Self-labeled retrieval quality** (full metric set above) | P–R curve, nDCG@k, MRR, Recall@k, tokens/query, domain-purity, dup-rate | $0 |

## Tier 2 — free, our moat (nobody else publishes these)

| # | Benchmark | Output | Cost |
|---|---|---|---|
| 3 | **σ calibration** | reliability diagram: does lower σ predict more-reliable retrieval? | $0 |
| 4 | **Contradiction / temporal correctness** | precision/recall that superseded (`valid_to`) facts are excluded and the newer wins; uses the 28 flagged contradictions | $0 |
| 5 | **Capacity curve** (MemBench-style) | accuracy vs store size (500 → 4,715) — the curve no competitor shows | $0 |

## Tier 3 — paid, last, optional (external parity only)

| # | Benchmark | Output | Cost |
|---|---|---|---|
| 6 | **LoCoMo-10 QA** | accuracy by category, for a number next to Mem0/Zep | $0 local Ollama judge, or ~$20 Claude Haiku |

Only run Tier 3 when the blog needs a head-to-head figure. Frame as "parity," then pivot
to Tier 2 as the story. Do **not** build it first.

## Corrections to the June 15 research (Part 2)

- **Scoring weights** are now `0.50·cosine + 0.15·bm25 + 0.27·recency + 0.08·access`
  (`retrieval.ts:391`), not the `0.50/0.15/0.22/0.13` quoted in Part 2 §? / README history.
- **Bhattacharyya is applied as a clamped multiplier** `[0.70, 1.40]` on the base score
  (`retrieval.ts:392`), not the raw distributional score.
- **Store size** as of 2026-07-08: **4,715 memories, 47 domains** (via `memory_stats`) —
  use this as the capacity-curve ceiling and the ground-truth source.

## Session log — 2026-07-08 evening: Stage B + vague-query investigation

Git history for this session: `d09308b` (harness + 2 confirmed bug fixes + Stage B
baseline path) → `0e0706a` → `04917cc` → `2c265b9` → `ae54677` (4 experiments, in
order, each commit message carries its own tested result). All 5 commits were created
back-to-back during a git-history reconstruction late in the session (the original
work was spread across real hours with live testing between each step, but there was
no `git commit` checkpoint between them at the time — so the commit *timestamps*
don't independently corroborate "tested live between each change"; only the commit
*message bodies* (written from real measurements taken at the time) and this doc do.

**Stage B ablation result** (`bench/ablation.mjs`, full hybrid `retrieve()` vs a naive
top-k-cosine-only `baselineRetrieve()`, same gold set): the thesis only holds at low
`top_k` (4/8) — Gaussian wins recall by +0.05 to +0.08 there, but at real token cost
(3-4x baseline). At `top_k` 16/24, Gaussian is strictly worse (lower recall, still
more tokens). Recall vs Gaussian's own `top_k` is **non-monotonic** — a real,
unexplained anomaly, likely an interaction between the adaptive score floor
(`retrieval.ts` — floor is anchored to a lower-ranked item as `top_k` grows, admitting
more distractors) and the diversity cap. Not yet root-caused.

**Four experiments run against the 12-query vague/casual gold set**
(`bench/gold/retrieval_gold.vague.json`), all four producing an apparent tied 0.38
recall vs baseline: (1) blend entity-token specificity into `querySigmaVal` — sigma
was previously pure query length, scoring short casual queries as *precise*, the
opposite of intended; (2) scale the initial Vectorize candidate pool width with
sigma; (3) route vague queries through `MICRO_VECTORIZE` neighborhood centroids as an
additional candidate source; (4) inject globally most-accessed memories as a
candidate source, zero embeddings involved. Working theory going into the Fable audit:
vague/casual query phrasing embeds too far from formally-worded stored facts
(register mismatch), and this is invariant to retrieval-strategy changes because
they all operate within or downstream of the same embedding space.

### Fable 5 audit — what it found (full independent review, real git/file access)

Asked for a skeptical outside check specifically because 4 straight experiments
producing an *identical* tied number was itself suspicious. Findings:

1. **The tie was a coincidence, not evidence of invariance.** Per-query, Gaussian and
   baseline actually disagree on individual queries (Gaussian wins some, loses
   others) — the +1/−1s canceled to the same mean by chance across all 4 tests. With
   only 12 queries, recall moves in coarse steps; a "frozen" aggregate carries very
   little statistical information. **Do not trust the aggregate number alone again —
   always inspect the per-query breakdown before concluding "nothing changed."**

2. **Harness bug, confirmed live:** `bench/lib/textmatch.mjs`'s `recallOfSet` does
   strict normalized-substring containment with no fuzzy/paraphrase tolerance. On
   query q38 ("the oauth thing for color wow, what was that"), Gaussian's actual
   top-1 result was a *correct*, differently-worded near-duplicate of the gold text
   ("Updated the OAuth consent screen with **the** app name..." vs the gold string's
   "...with app name...") — `dedupBySimilarity` (`retrieval.ts`) correctly kept the
   higher-scored variant, but the harness scored it 0 anyway because the exact
   substring wasn't present. Baseline (no dedup) happened to return literal-phrasing
   duplicates that matched the strict harness by luck. **Correcting for this alone,
   Gaussian is ahead of baseline (~0.46 vs 0.375), not tied.**

3. **Real implementation bug in experiments 3 and 4, not evidence for the embedding
   theory:** synthetic placeholder cosine scores for cluster-routed (0.45) and
   access-frequency (0.35) candidates get run through the same `minMaxNormalize` as
   real cosine hits (0.55–0.70) — always crushing them toward 0, then the score floor
   cuts them before they can ever surface. Both experiments were **structurally
   incapable of ever moving the number**, independent of whether the underlying
   hypothesis (neighborhood routing, access-frequency fallback) has any merit.
   Experiment 2 (pool widening) was also weaker than framed — for these specific
   queries it only widened the pool 32→40, not toward the 50-cap.

4. **Gold set verified clean:** all 12 `match_texts` confirmed to exist verbatim in
   the live store at rank 1 under baseline mode. Not a labeling problem.

5. **Contamination confirmed live and visible**, not just theorized: q38's full-mode
   output was visibly stuffed with unrelated, recently-benchmark-touched session
   memories scoring 1.3–1.5 — session/recency/access make up a real chunk of
   `baseScore`, so repeated benchmark runs are measurably training the ranker toward
   whatever the benchmark itself touched. Baseline mode writes nothing, so this
   asymmetry only penalizes the Gaussian side.

**Verdict: the register-mismatch theory is real but was materially overstated.** It
holds for a genuine subset — queries q33/q34/q36/q42/q43/q44, where both modes score
zero and Fable's own top-50 probe on q33 confirms the target simply isn't cosine-close
enough to surface under casual phrasing. But "invariant across 4 experiments" was
wrong: 2 of the 4 experiments were floor-stripped no-ops (bug, not signal), not real
tests of the hypothesis.

### What Fable flagged to pick back up on (not yet done when the audit wrapped)

Fable's own words, ~85% through: *"Need to check whether the q33/q34/q36/q42/q43/q44
cases (where **both** modes score 0) are genuine embedding-register misses... or show
the same dedup-driven near-miss pattern. That determines whether the dedup/harness bug
explains the whole tie or just part of it."* Its preliminary read: **not a single clean
phenomenon** — likely both the embedding-register effect *and* the harness/dedup
mismatch are real and landing at the same number by coincidence, worth confirming
rather than picking one story.

### Concrete next steps (before any more retrieval experiments)

1. **Switch scoring to ID-based matching.** `gold_ids` already exist in every gold
   file but no harness code reads them — only `match_texts` (string containment) is
   used. Either add the `/bench/retrieve` structured endpoint referenced but never
   built in `bench/lib/client.mjs`'s comments, or thread memory IDs through the
   existing text-response parser. This eliminates the entire class of bug in finding
   #2 above.
2. **Fix the normalization bug** from finding #3: exempt injected/synthetic-cosine
   candidates from `minMaxNormalize`'s pre-floor comparison, or give them a
   post-normalization score directly, so experiments 3 and 4 get a fair test before
   drawing any conclusion about them.
3. **Finish Fable's unfinished check**: determine whether the both-zero queries are
   pure embedding-register misses or partially a harness artifact.
4. **Snapshot/restore DB state around benchmark runs** to kill the contamination
   confound (finding #5) — every `retrieve()` call sharpens σ and increments
   `access_count` live; repeated runs against the same store aren't clean trials.
5. Only after 1–3: re-run the 4 experiments (or a redesigned version of 3/4) to see
   if the real signal changes once the harness and normalization bugs are fixed.

---

## Session log — 2026-07-09: harness fixes landed, experiments 3/4 finally tested for real

Worked through all 5 items of the 2026-07-08 next-steps list, in order. Git history:
`b867089` (items 1+4: ID scoring + frozen trials) → `c234444` (derived id_groups) →
`b2eaf99` (item 2: normalization fix) → `5481a72` (item 5 redesign: guarantee slot +
diversity-cap exemption + pipeline tracing). Each commit was deployed and measured
live before the next change — the numbers below come from those checkpoints, in order.

### Item 1 — ID-based scoring (done)

Built the `/bench/retrieve` structured endpoint (`src/index.ts`) rather than threading
ids into the text parser: the agent-facing text format is a product surface and stays
untouched; ids were already internal to `retrieve()`/`baselineRetrieve()` and are now
returned on their rows (never printed by `tools.ts`). Scoring is **unit-based**
(`bench/lib/idmatch.mjs`): one unit per gold `match_text`, carrying the `gold_ids`
whose live D1 text answers it (derived once by `bench/tools/derive_id_groups.mjs`,
committed as `bench/gold/id_groups.json` — frozen gold files untouched). A row credits
a unit by id OR normalized containment; denominators unchanged, so recall stays
comparable with the 2026-07-08 numbers. Derivation was clean: 41 queries, **0 missing
ids**, exactly one non-containment assignment — q38's `790e9134`, which is precisely
the dedup survivor the audit caught being mis-scored. `bench/ablation.mjs` now uses
this and prints a per-query breakdown (aggregate-only reporting is what hid last
session's bugs).

### Item 4 — contamination (done, verified with a positive control)

`retrieve()` takes `opts.frozen` which skips the σ-sharpen / `access_count` /
hot-tier write-backs; `/bench/retrieve` defaults to frozen. Verified live: 3 frozen
calls left a returned memory's `access_count`/`last_accessed`/σ byte-identical, one
`frozen:false` control call incremented it. Repeated frozen runs reproduce identical
per-query results. Caveat: the store still *carries* the contamination from earlier
unfrozen runs (inflated access counts / sharpened σ on bench-touched memories); that
bias is baked into absolute numbers but no longer grows.

### The 0.38 tie, resolved

Re-scored by id (pre-normalization-fix deployment): **gaussian 0.42 vs baseline 0.38**
on the vague set at top_k 8 and 16. The audit's "correcting for this alone, ~0.46 vs
0.375" was directionally right — the exact tie was pure harness artifact. q38's
survivor now credits as `id-only@1`.

### Item 3 — the both-zero queries (done)

`bench/tools/probe_register.mjs`: baseline cosine at depth 100 + gaussian@24, per gold id:

- **q33, q34, q42, q43, q44: true embedding-register misses** — gold id not in the
  top-100 cosine window at all under casual phrasing.
- **q36: NOT a register miss** — gold at baseline-cosine rank 24 (0.653), inside
  gaussian's own candidate pool, but buried by hybrid ranking. Confirmed behaviorally
  later: after this session's fixes it surfaces at rank 11 with top_k=16.

So the register-mismatch theory survives for 5 of 6, with one reclassified as a
ranking loss. Gold-staleness caveat worth recording: for q44 the baseline top-1 was
"Ship status remains delayed, no new ship date as of 2026-07-05" — arguably a more
current answer than the gold "finish before august" (belief drift inside the corpus);
q42's "that scoring fix" is genuinely ambiguous (multiple scoring fixes exist). Frozen
gold stays frozen, but a v2 vague set should re-author these.

### Items 2+5 — normalization fix, and what it took to make experiments 3/4 real

The fix itself (`normalizeCosineBatch`, unit-tested): real cosine hits min-max against
each other only; injected candidates (temporal 0.5 / cluster 0.45 / access 0.35) get
their synthetic value directly as the post-normalization score. Deployed it — and the
vague set **did not move at all** (identical per-query). Skepticism applied as
instructed; instrumented the pipeline (`opts.trace` on `retrieve()`, `trace:true` on
`/bench/retrieve`) instead of theorizing. Found experiments 3/4 were behind **three**
stacked blockers, of which the audit had found only the first:

1. **Normalization crush** (audit finding #3) — fixed above.
2. **Adaptive floor**: injected candidates now score fairly (~0.55–0.6) but the floor
   is anchored to the median of cosine-native activation scores (~1.2+ on this
   corpus). Structurally unreachable, same failure shape the temporal guarantee
   already patches. Fix: an injected-source guarantee — vague queries (no named
   entity) append the best 2 floor-missed injected candidates, ranked by query-token
   overlap first (fair non-embedding topical signal; the injected pool has none by
   construction — pure score ranking just hands the slots to whatever is globally
   hottest), then score. FTS5 couldn't provide this signal: its implicit-AND requires
   every casual token ("yk") to match.
3. **Diversity cap eats guarantees**: the appended candidate was then silently
   re-dropped by `applyDiversityCap` because its memory_type budget (4 episodic) was
   already spent. Found via trace, not deduction. Guarantee-slot ids are now
   cap-exempt (still counted toward budgets). This bug also applies in principle to
   the *temporal* guarantee (sessions cap at 2) — not changed this session, flagged
   below.

Concrete validation of experiment 4's hypothesis: q34's gold ("Chose Bayesian
Gaussian model over key-value store", access_count 2016, rank 8 of the global access
pool) is **not cosine-reachable in a top-100 window** but was being injected, fairly
scored, floor-cut, and then cap-cut on every earlier run. It now surfaces.

### Results (ID-matched, frozen, per-query verified, reproduced across runs)

Vague set (12 queries):

| state | recall@8 | recall@16 | note |
|---|---|---|---|
| baseline (naive cosine) | 0.38 | 0.38 | |
| gaussian, session start (re-scored by id) | 0.42 | 0.42 | the "0.38 tie" was harness artifact |
| gaussian + normalization fix only | 0.42 | 0.42 | blockers 2+3 still masking |
| gaussian + guarantee slot + cap exemption | **0.50** | **0.58** | q34 via access pool; q36 at k=16 |

v1+multihop (29 queries), gaussian recall: 0.68→**0.76**@4, 0.75→**0.79**@8,
0.75→**0.77**@16/24 — no per-query recall regressions (q02/q18 gained via the slot;
q30 gained via cluster routing on an entity query, i.e. the normalization fix alone;
q17's first unit slipped rank 4→8 but still hits). Gaussian recall vs top_k is now
**monotonic** under ID matching + frozen trials — the 2026-07-08 non-monotonic anomaly
did not reproduce once the harness artifacts were removed; it was at least partly
text-matching + contamination noise, though k=16/24 recall still trails baseline
(-0.02) with worse precision, so the "gaussian strictly worse at high top_k" finding
directionally stands.

Costs, honestly: gaussian tokens rose ~40% on vague queries (2 extra injected rows) —
at k=8 gaussian spends ~6x baseline tokens on this set. Precision is unchanged-to-worse
(0.07 vs 0.12 at k=8). The vague-set win is recall-only, driven by 1–2 queries in a
12-query set; the overlap-first slot ranking was designed while staring at q34 and then
validated on q02/q18/q30 (main set) — a held-out vague v2 set is needed before claiming
generality. Token counts are now derived from structured row texts (excludes
[DOMAIN:]/Summary framing), so ratios are not directly comparable to 2026-07-08's.

### Remaining misses, fully explained

- q33/q42/q43/q44: pure register misses (above) — not fixable by candidate-source or
  ranking work; needs either query/memory register normalization at embed time or
  keyword-OR recall (FTS with OR semantics) as a candidate source.
- q38 unit0 (baseline wins 2/2 vs gaussian 1/2): traced — the distinct client-id
  memory survives scoring, dedup, and σ-gate, then the **diversity cap** cuts it as
  the 4th member of the same micro-cluster. Dedup itself is fine (u1a collapses into
  the survivor, credited by id). Real design tension: the cap trades multi-fact recall
  within one on-topic cluster for diversity.
- q39 unit1: second rebuild memory never in candidate pool at k≤16 (not probed deeper).

### Still open

1. Diversity cap vs on-topic clusters (q38 u0) — consider relaxing `clusterLimit` when
   candidates are topically on-query, or exempting temporal-guarantee appendees the
   same way the injected guarantee now is (the temporal guarantee has the same
   silent-re-drop bug, unfixed).
2. Register misses (q33/q42/q43/q44) — the actual embedding-space problem, untouched
   by everything above. Candidate ideas: OR-semantics keyword recall, casual-register
   query expansion (no-LLM constraint makes this hard), or storing a casual-register
   text variant alongside the formal one at write time.
3. q30's k=8 vs k=4/16 asymmetry (gained at 4 and 16, not at 8) — unexplained
   pool-width/floor interaction, low priority.
4. Vague gold v2: re-author q42 (genuinely ambiguous — multiple valid "scoring fix"
   answers exist) so a single query stops being worth 0.08 recall. q44 is NOT stale —
   corrected below, see 2026-07-09 evening session.
5. High-top_k precision: gaussian still trails baseline recall at k=16/24 with ~2x
   tokens on the main set — the floor-widens-with-k interaction from 2026-07-08
   remains the suspect, now cleanly measurable with the trace tooling. Untouched by
   the 2026-07-09 evening session below.

---

## Session log — 2026-07-09 evening: close-read audit of both gold sets, cluster-routing removed

Prompted by a simple question worth repeating: does a failing recall NUMBER actually
mean the retrieved answer was wrong, or does it just mean it didn't literal-match
gold's exact string? Nobody had actually read the raw response text end-to-end before
today — every prior session trusted the mechanical scorer's aggregate output. Doing
that for real changed several conclusions from the 2026-07-08/09 morning sessions.

### Vague set (12 queries) — re-diagnosed with hard evidence, not inference

- **q33** ("why'd we go with that db thing again" → PlanetScale comparison): the
  underlying memory is real (created 2026-06-04, technically accurate — PlanetScale
  genuinely isn't edge-native), but almost certainly captures Claude's own reasoning
  during an early architecture discussion, not a decision the user ever consciously
  weighed. The query itself is unnatural — no real version of the user would ask to
  recall a decision he never felt he made. Still a mechanical miss, weaker evidence
  of a real retrieval gap than it looked.
- **q40** (Mem0 differentiator): confirmed low-priority — authored in early June,
  before the storage pipeline was reliable. Not touched further.
- **q42** (scoring fix): confirmed genuinely ambiguous — multiple scoring fixes exist
  in the corpus, gold's match_text is a bare number range with no words. Bad gold,
  not a system defect.
- **q44** ("when am i trying to ship this" → "finish before august"): **the prior
  session's staleness claim was WRONG.** Checked real timestamps: "ship status
  remains delayed, no new ship date" was created 2026-07-06 13:39; "finish Gaussian
  Memory before August" was created 2026-07-06 20:41 — seven hours LATER, same day.
  Gold is the more recent belief, not the stale one. This is a genuine retrieval
  miss, not a bad-gold case — corrects the 2026-07-08 audit.
- **q43** (confidence-tracking, zero shared words with gold): the #1 wrong result
  ("Emotional intensity above 0.7 halves initial uncertainty...") looked like noise
  by domain tag (personal-life-style) but is REAL, accurate system logic
  (`gaussian.ts:75`, `if (emotionalIntensity > 0.7) base *= 0.5`) — a correct,
  complementary answer mis-domained by domain-bleed, not garbage. The only clean,
  fully-uncontested miss left in the set once every other one was actually checked.

Net: of the 5 originally-flagged vague failures, 1 was already fixed (q34), 2 were
bad gold (q40 low-priority, q42), 1 was a wrong staleness claim now corrected to a
real miss (q44), and 1 is genuinely hard with no confound (q43).

### Main set (v1: 26 queries, multihop: 6 queries) — same treatment, same pattern

Full query/gold/top-3-response dump for every miss (not just aggregate pass/fail) —
see `bench/tools/inspect_all.mjs`, usage: `node bench/tools/inspect_all.mjs <gold
files> ` (env `MISSES_ONLY=1` to filter, `BASELINE=1` to run baseline mode instead of
gaussian). Of 9 flagged misses (q06, q09, q10, q26, q27, q28, q29, q30, q31), 6 had
the correct fact sitting in the top 3 responses, just phrased differently than gold's
exact string (q09, q10, q28, q29, q30, q31) — scorer brittleness, not retrieval
failure. Two hold up as real: **q26** (repo path — genuinely absent from top 3) and
**q27**, which is confounded twice over — the query itself is unnatural (no real
agent asks "what techniques make up your own retrieval pipeline" mid-task) AND its
top-1 result was Claude's own past commentary text outranking the actual documented
fact (buried at rank 3) — a real ranking-quality concern independent of the query's
naturalness.

**Baseline (naive cosine) got the same treatment, not just Gaussian — this matters:**
re-ran `bench/tools/inspect_all.mjs` with `BASELINE=1` against the same two gold
files. Baseline has MORE raw misses (10 vs 9) and, critically, does NOT get the same
rescue on close reading: q05, q16, q18, q27 return either nothing relevant or a
conflicting/wrong fact in the top 3 (not just differently-worded correct answers).
Conclusion: the brittle-scorer problem cuts asymmetrically — Gaussian's richer
candidate sources (BM25 fusion, dedup, entity graph) surface correct-but-differently-
worded answers more often, which the strict scorer then wrongly zeroes; baseline's
narrower approach more often returns genuinely nothing. The TRUE gap between Gaussian
and baseline is at least as large as the raw scored numbers show, likely larger.

**Version-integrity check, since this determines whether any of the above is even
valid:** confirmed the deployed worker matches the code being read (the `/bench/
retrieve` trace's `guaranteedInjected` field only exists because of 2026-07-09
morning's guarantee-slot code — its presence in live traces proves that code is
live, independent of `wrangler deployments list`'s timestamp ordering, which looked
inconsistent but isn't a reliable signal). Separately confirmed the entity-token gate
means the cluster-routing/access-frequency machinery never fires for most v1/multihop
queries at all (they're mostly entity-bearing) — so the v1/multihop "mostly correct"
finding is validated against the STABLE core retrieval, independent of whatever gets
decided about experiments 3/4 below.

### Cluster-routing (experiment 3): two failed redesigns, then removed

Given cluster-routing's thin justification (from the 2026-07-09 morning session:
1 of 12 vague queries, q36, uniquely rescued by it), attempted to re-gate it as a
fallback instead of always-on, to cut its per-query cost (extra Vectorize + D1 query
on every no-entity query) down to only the cases it might actually help.

**Attempt 1** (confidence-gated: fire only when the primary fetch's best real cosine
hit is weak, threshold 0.55) — implemented, unit-tested (5 new tests, all passing),
deployed, and it broke q36 on live re-verification. Root cause, confirmed via a new
`topRealCosine`/`clusterFallbackTriggered` trace field added specifically to debug
this: q36's top real cosine hit is 0.81 — a CONFIDENT score, nowhere near the
threshold. The theory that crowding produces a weak top score was wrong: crowding
produces a confident-but-WRONG top score (several similar "LeetCode goal" memories
compete; one of them, not the right one, matches well enough to look confident). A
single top-1 magnitude check can't distinguish "one correct dominant match" from
"one wrong dominant match with the real target buried one rank down" — they look
identical on that one number.

**Attempt 2** would need a genuinely different signal — score concentration across
the top-N (many close-together strong scores = crowding signature), not top-1
magnitude. Real, more involved design work, for a mechanism whose ceiling across the
entire 12-query vague set is 1 confirmed win. Decision: not worth a second design
iteration for that ceiling — **cluster-routing (the search-time MICRO_VECTORIZE
consultation) is removed entirely**, both attempts' code reverted. This returns the
vague set to the already-validated baseline (0.42-0.50 recall via harness fixes +
access-frequency) — not a regression, just walking back a detour. (`assignMicroCluster`'s
WRITE-time cluster assignment in `microcluster.ts` is unrelated and untouched — only
the search-time consultation is gone.)

### What was kept

- **Access-frequency (experiment 4)**: unchanged trigger (`querySigmaVal > 0.35 ||
  entityTokens.length === 0`), still has its one confirmed win (q34) at low cost
  (single D1 query, no chained second query).
- **Project-scoping fix**: the access-frequency query (`SELECT id FROM memories
  ORDER BY access_count DESC LIMIT 20`) had no project filter at all, unlike every
  other query in the file — for multi-project accounts, this meant "top 20 by
  access_count" pulled globally-hot ids from whichever project dominates total
  activity, silently dropped later at the project-scoped row fetch. No leak (row
  fetch was always scoped), but wasteful, and meant the source could contribute
  nothing for any project other than the dominant one. Fixed — now scoped like
  everything else.

### Still open (unchanged from 2026-07-09 morning, not addressed today)

Diversity cap vs on-topic clusters (q38 u0), the register misses (q33 unnatural
query, q43 genuine), q30's k=8 asymmetry, high-top_k precision on the main set. None
of today's work touched these.

## Planned for next session (2026-07-09 evening)

1. **Sigma-aware diversity cap.** Right now `applyDiversityCap`'s type/cluster limits
   are pure counts — a well-consolidated, heavily-reinforced, low-sigma memory gets
   capped identically to a fresh, uncertain one. This is the actual mechanism behind
   the q09/q10-style "real fact exists but gets crowded out" cases (see the
   otherTypeLimit sweep above: 4→7 fixed 3 real queries with zero regression, but
   plateaued — some gaps are structural, not just a threshold problem). Cognitive
   psychology's interference-theory literature says consolidated memories should
   resist crowding better than fresh ones; the IR literature's Maximal Marginal
   Relevance (Carbonell & Goldstein 1998) is the principled continuous version of
   what the current cap crudely discretizes. Concrete next step: let low-sigma items
   bypass the count cap more readily, reusing the existing `guaranteedInjectedIds`
   exemption pattern rather than inventing a new mechanism.
2. **LLM-judge as a proper harness tier**, not just a one-off calibration check.
   Tonight's Haiku judge run (10 cases) agreed with manual reading on 9/10 and caught
   one real overreach (q10) — cheap (~19K tokens for 10 cases) and genuinely more
   reliable than lexical fuzzy-matching, which was directly proven to fail (q36 scored
   a *higher* overlap coefficient than a true positive). Worth wiring into
   `bench/ablation.mjs`/`inspect_all.mjs` as an automatic tier for any unit that's an
   `id`/`text` miss, rather than re-running one-off agent calls each time.
3. **Run LoCoMo** — after (1) and (2) land, so the external, comparable number
   reflects the actually-improved system, not tonight's starting state.

---

## Session log — 2026-07-23: register-miss follow-up, live-verified against `baa71a2`

The recall numbers in the 2026-07-09 sessions above (0.68–0.79 main+multihop,
0.42–0.58 vague) are **stale** — superseded by `baa71a2` (2026-07-17, "Fix retrieval
regression: unbounded sigma-exempt diversity cap"), which bounded the unbounded
sigma-exempt diversity cap from 2026-07-13 that had let the most-retrieved half of
the corpus become permanently cap-exempt. Frozen ablation from that commit: recall
**0.85 (main+multihop) / 0.71 (vague)**, tokens *down* (main+multihop p50 1010→944,
vague p50 1307→1083). This document wasn't updated at commit time; noting it here
so the numbers above aren't taken as current.

Re-ran `bench/tools/probe_register.mjs` against the live worker for the "Remaining
misses" list (q33/q42/q43/q44) plus q36:

- **q33, q42: already fixed** — both hit live now. Not a code fix; the gold set was
  re-authored to v2 (`retrieval_gold.vague.json`, 2026-07-09 evening session) after
  the close-read audit found the originals were bad gold, not real misses.
- **q36: real bug, now fixed** — traced with the register probe: gold *was*
  cosine-reachable (baseline rank 24, cosine=0.653) but gaussian's final output
  dropped it anyway. Root cause: the live corpus had accumulated ~24 near-duplicate
  "struggling with/aiming to complete N LeetCode problems" episodic memories across
  5+ domains and 4+ projects (captured over 2026-05-16 through 2026-07-09, mostly
  auto-store from casual conversation), all scoring high enough to fill every
  candidate slot ahead of the one specific goal-fact memory. Confirmed via direct D1
  query these were never deduped (`revision_count=0` on all, 10+ distinct
  `cluster_id`s) — and under `baa71a2`'s same-project merge scoping, memories stored
  under different `project` values are now structurally unmergeable by the cron even
  if it ran again. This is a corpus-hygiene problem, not a retrieval bug: no ranking
  change would fix it without risking the same kind of single-query overfit that
  `baa71a2` itself had to clean up. Fixed with a one-time manual cleanup (24 memories
  deleted via `memory_delete`, R2-archived first, confirmed against the user's actual
  current goal before deleting anything): 7 near-duplicate sentiment captures from a
  2026-05-26 session, plus 17 superseded goal-number restatements (abandoned targets
  180/250/500/"1k-2k", plus repeat captures of the same "20/150 done" moment) from
  2026-05-26/27. Kept: the current goal (150 by August, `f387472b`), the detailed
  2026-06-22 cadence plan (`536295f2`), the most recent progress marker
  (`d4511402`), and all working-style/feedback/personal-venting content. Re-verified
  live post-cleanup: gold now hits at gaussian rank 2 (`probe_register.mjs --ids
  q36`).
- **q43, q44: confirmed still open, genuine register misses** — not cosine-reachable
  even at baseline depth 100. No corpus cleanup or ranking change touches this; still
  needs query/memory register normalization at embed time or a keyword-OR FTS
  candidate source, per the "Still open" item 2 above.

---

## Session log — 2026-07-23 (later): full re-run after corpus-wide dedup cleanup

Same-day follow-up to the register-miss session above. After the q36 fix, ran
`memory_find_duplicate_clusters` (new tool, see git log) across every domain with
5+ memories in duplicate clusters (all except `personal-life-style`, held back for
separate review) and manually deleted 837 near-duplicate memories via
`memory_delete` (R2-archived, each judged individually — contradictions, evolving
decisions, and topically-similar-but-factually-distinct content were preserved).
Corpus dropped from the low-thousands to a meaningfully smaller, cleaner base.

**Gold-integrity casualty, found before re-running the benchmark**: 5 of the 42
distinct gold ids referenced across the three frozen gold files got swept up as
duplicates and deleted (`23869ee3`, `48ccda8f`, `c985a5b9`, `ab8b3eba`, `2dc50727`
— all judged as genuine restatements at the time, correctly, since duplicate
judgment doesn't know a row is gold-tagged). Regenerated `bench/gold/id_groups.json`
via the existing `bench/tools/derive_id_groups.mjs` (re-runnable by design, frozen
`retrieval_gold.*.json` files untouched) — needed `CI=true` in the environment to
stop a new wrangler CLI banner ("Cloudflare agent skills are available...") from
polluting the `--json` stdout the script parses.

Net effect: **3 units are now permanently unscoreable as real misses** — not a
retrieval defect, a benchmark artifact. Each deleted id's fact survives in the
corpus via a kept sibling, but the sibling's exact wording doesn't literally
contain the frozen `match_text` substring, so neither id-matching nor the
text-fallback can credit it:
- q10 unit "augmentation approach because it improves all workflows" (main set)
- q28 unit "vectorize-backed ann lookup" (multihop set)
- q31 / q39 unit "domain rebuild from unstable to stable" (multihop + vague sets,
  same underlying fact, same original id)

(A 4th casualty, q32's "ai timelines are way off" unit, still scores fine —
its dead id happened to land in the frozen gold's first `match_text` group, and
the surviving sibling's text still contains that literal substring.) Did not
hand-edit the frozen gold files to route around this — same convention this repo
already uses for bad-gold cases (q40/q42) — flagging honestly instead. Re-authoring
those 3 units against their surviving sibling ids is fair game for a future
session if the recall hit is worth closing.

**Results** (frozen trials, ID-first unit matching, k=8 — the standard comparison
point):

| set | gaussian recall | vs `baa71a2` (2026-07-17) | note |
|---|---|---|---|
| main+multihop (29 q) | **0.85** | 0.85 (unchanged) | cleanup removed noise, not signal — recall held exactly |
| vague (12 q) | **0.79** | 0.71 (+0.08) | q36 fix is the main driver |

Full k=4/8/16/24 frontier, main+multihop: recall 0.80/0.85/0.82/0.82, gaussian
tokens 5.7x/3.5x/2.7x/1.6x baseline. Vague: recall 0.71/0.79/0.79/0.79, tokens
12.9x/7.1x/4.9x/3.1x baseline. Both sets still show the same top_k=16/24 pattern
flagged in prior sessions (gaussian's token cost advantage shrinks as k grows,
recall plateaus) — untouched by tonight's work, still open per the "Still open"
list further up.

---

# Part 2 — Landscape Research (reference, compiled June 15, 2026)

---

## 1. What Benchmarks Exist for AI Memory Systems?

### LoCoMo (Long-Term Conversational Memory)

**Paper:** "Evaluating Very Long-Term Conversational Memory of LLM Agents" — ACL 2024
**Source:** https://github.com/snap-research/locomo — CC BY-NC 4.0, file is `data/locomo10.json`

**What it measures:**
- 10 annotated long-term conversations, each ~300 turns, ~9,000–16,000 tokens, spanning up to 32 sessions
- Three tasks: (1) question answering across four sub-types (single-hop, multi-hop, temporal, open-domain), (2) event summarization, (3) multimodal dialogue generation
- Metrics: **F1** and **BLEU-1** for QA; the field has also adopted a unifying **LLM-as-Judge** accuracy score

**How to run it:**
- Original repo has `scripts/evaluate_gpts.sh` and `scripts/evaluate_claude.sh`
- Cleaner wrapper: [EasyLocomo](https://github.com/playeriv65/EasyLocomo)
- Single-file reference: [SimpleMem test_locomo10.py](https://github.com/aiming-lab/SimpleMem/blob/main/test_locomo10.py)
- Pattern: ingest conversations → answer 1,540 QA pairs → score with LLM judge

**Published scores (human ceiling ~88%):**

| System | LLM-Judge % | Notes |
|---|---|---|
| Human | ~88 | |
| GPT-4 (4K ctx) | ~32 | |
| Mem0 | 92.5 | Disputed — see §7 |
| Zep | 75.14 / 94.7 | Disputed — see §7 |
| MemoryOS | +49% F1 over baseline | EMNLP 2025 oral |
| Memory-R1 | 45.0 F1 | +48% vs Mem0 baseline |
| Letta filesystem | 74.0 | GPT-4o-mini |

**Important caveat:** Active benchmark manipulation controversy between Mem0 and Zep. Scores are NOT comparable across papers unless evaluation protocol is identical.

---

### LongMemEval

**Paper:** arXiv:2410.10813, ICLR 2025
**Source:** https://github.com/xiaowu0162/longmemeval
**HuggingFace:** `xiaowu0162/longmemeval`

**What it measures:**
- 500 manually curated questions across five abilities: information extraction, multi-session reasoning, temporal reasoning, knowledge updates, abstention
- Two test sizes: LongMemEval_S (~115K tokens/question, 40 sessions); LongMemEval_M (~1.5M tokens, 500 sessions)
- Metric: accuracy (LLM-as-judge via GPT-4o)

**How to run:**
```bash
export OPENAI_API_KEY=YOUR_KEY
python3 evaluate_qa.py gpt-4o your_hypothesis_file ../../data/longmemeval_oracle.json
```
Hypothesis file: JSONL with `question_id` and `hypothesis` fields.

**Published scores:** Zep: 63.8%; Mem0: 49.0% (independent evaluation with GPT-4o). Mem0's self-reported score is 94.4% — discrepancy is due to different backbone LLMs and evaluation setups.

---

### LongMemEval-V2

**Paper:** arXiv:2605.12493 (May 2026)
**Source:** https://github.com/xiaowu0162/LongMemEval-V2
**HuggingFace:** `xiaowu0162/longmemeval-v2`

**What it measures:**
- 451 manually curated questions + 1,870 web-agent task trajectories
- Tests whether memory helps agents become "experienced colleagues" — recalling interface affordances, recurring failure patterns
- Best system achieves 72.5%; best plain RAG achieves 48.5%
- Includes latency as a required reported metric

**Relevance:** Most directly relevant benchmark for a coding-assistant memory system.

---

### BEAM (Beyond a Million Tokens)

**Paper:** arXiv:2510.27246, ICLR 2026
**Source:** https://github.com/mohammadtavakoli78/BEAM
**HuggingFace:** `Mohammadta/BEAM` and `Mohammadta/BEAM-10M`

**What it measures:**
- 100 conversations at four scales (128K, 500K, 1M, 10M tokens), 2,000 human-validated questions
- 10 memory abilities: abstention, contradiction resolution, event ordering, extraction, instruction following, knowledge update, multi-session reasoning, preference following, summarization, temporal reasoning

**Mem0 April 2026 scores:**
- BEAM-1M: 64.1 (6,719 tokens/query)
- BEAM-10M: 48.6 (6,914 tokens/query)

**Note:** Not relevant for our use case (single-user BYOC at normal coding session scale). Skip for now.

---

### MemBench

**Paper:** ACL 2025 Findings
**Source:** https://github.com/import-myself/Membench

**What it measures:**
- Distinguishes factual vs reflective memory at two levels
- Three metric dimensions: **effectiveness** (accuracy), **efficiency** (memory operations), **capacity** (degradation as store grows)

**Why it matters:** Capacity metric directly maps to our σ decay + pruning. No other system publishes accuracy-vs-store-size curves.

---

### MemoryAgentBench

**Paper:** ICLR 2026
**Source:** https://github.com/HUST-AI-HYZ/MemoryAgentBench

**What it measures:**
- Four competencies: accurate retrieval (AR), test-time learning (TTL), long-range understanding (LRU), conflict resolution (CR)
- Includes EventQA and FactConsolidation datasets
- Conflict resolution (CR) directly maps to our contradiction surface rate metric

---

### MemGym

**Paper:** arXiv:2605.20833 (June 2026) — very new

**What it measures:**
- Five evaluation tracks: tool-use dialogue, coding (SWE-Gym + MemGym-CodeQA), web navigation, deep research
- The coding track is the only public benchmark specifically testing memory in coding contexts
- Too new for meaningful comparison baseline yet

---

## 2. How Have Mem0, Zep, and Letta Evaluated Their Systems?

### Mem0

**Primary paper:** arXiv:2504.19413 (ECAI 2025)
**Benchmarks repo:** https://github.com/mem0ai/memory-benchmarks
**Benchmark blog:** https://mem0.ai/blog/ai-memory-benchmarks-in-2026

**What they report:**
- Three-benchmark suite: LoCoMo, LongMemEval, BEAM
- Evaluation pipeline: Ingest → Search → Evaluate; LLM generates answers from retrieved memories; judge LLM scores
- April 2026 scores: LoCoMo 92.5 / LongMemEval 94.4 / BEAM-1M 64.1 at ~6,900 tokens/query
- Head-to-head comparison: https://mem0.ai/blog/benchmarked-openai-memory-vs-langmem-vs-memgpt-vs-mem0-for-long-term-memory-here-s-how-they-stacked-up

**Credibility issue:** Zep filed a formal GitHub issue (zep-papers/issues/5) showing Mem0's Zep score was wrong due to role assignment errors. Letta independently reproduced LoCoMo and scored 74.0% vs Mem0's reported 68.5% for Mem0-graph. No independent verification of Mem0's self-reported numbers.

---

### Zep (Graphiti)

**Paper:** arXiv:2501.13956 (January 2025)
**Blog:** https://blog.getzep.com/state-of-the-art-agent-memory/
**Counter-blog:** https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/

**What they report:**
- Primary: LongMemEval (500 QA pairs) and DMR (Deep Memory Retrieval)
- LongMemEval with GPT-4o: Zep 71.2% vs full-context baseline 63.8%; latency 2.58s vs 28.9s
- Latest self-reported: 94.7% on LoCoMo at 155ms p95, 5,760-token median context; 90.2% on LongMemEval
- Architecture: temporal knowledge graph (Graphiti) with `valid_from`/`valid_to` timestamps

**Credibility issue:** Zep's LoCoMo scores range from 58.44% to 94.7% depending on evaluator. Protocol sensitivity is massive.

---

### Letta / MemGPT

**Blog:** https://www.letta.com/blog/benchmarking-ai-agent-memory/

**What they report:**
- Filesystem-based agent (files + grep tools) vs Mem0 on LoCoMo
- Result: **74.0% accuracy** with GPT-4o-mini, vs Mem0's claimed 68.5%
- Conclusion: simple filesystem agent beats specialized memory systems with same backbone LLM
- No dedicated metrics paper; MemGPT's original DMR benchmark is now saturated by modern models

---

### OpenAI Memory
- No published paper; Mem0 head-to-head: LoCoMo 52.9%, ~5,000 tokens/query. Cloud-only.

### LangMem
- Mem0 head-to-head: LoCoMo 58.1%, ~130 tokens/query (retrieves almost nothing).

---

## 3. What Does the Community Actually Care About?

**Source threads:**
- HN: "Ask HN: Thinking about memory for AI coding agents" — https://news.ycombinator.com/item?id=46742800
- GitHub: Mem0 Issue #2066 (graph cost: 62 photo descriptions → >1 hour, 15x cost)
- GitHub: zep-papers/issues/5 (benchmark methodology dispute)

**Top complaints, ranked by frequency:**

1. **Noise injection / context bloat** — vague memories inject wrong signals; agents behave worse with memory than without on simple tasks. Confirmed quantitatively in Stompy coding benchmark.

2. **Hallucinated memories** — HaluMem benchmark found: 43% max recall rate, 62% accuracy, 74% omission rate on knowledge updates. Recall collapses from 43% to 3% at 1M tokens.

3. **Staleness / no decay** — "A memory about a user's employer is accurate until they change jobs." No system evaluates this. Our σ decay directly addresses this.

4. **Contradiction surface** — "When two stored memories contradict each other, which one wins?" No standard benchmark. Our `valid_from`/`valid_to` + σ model addresses this.

5. **Epistemic trust gap** — "LoCoMo tests did the agent recall the right thing. There's an entire evaluation dimension above that: should the agent trust what it recalled?" No existing benchmark covers confidence-weighted retrieval. This is Bhattacharyya.

6. **Write cost** — Mem0 graph variant prohibitively expensive at scale; Zep self-hosting requires graph infra.

7. **Duplicate accumulation** — requires manual curation. Our Kalman merge at cosine > 0.82 addresses this.

8. **EU compliance / data sovereignty** — all cloud systems fail EU AI Act data residency. Our BYOC model addresses this.

9. **Benchmark manipulation distrust** — The Mem0/Zep dispute has made developers skeptical of all published numbers.

---

## 4. LoCoMo Details + How to Run

**Yes, it can be run.** Dataset: `locomo10.json` — 10 conversations, 1,540 QA pairs.

**Easiest path:**
```bash
git clone https://github.com/playeriv65/EasyLocomo
# OR copy:
# https://github.com/aiming-lab/SimpleMem/blob/main/test_locomo10.py
```

**Evaluation protocol:**
1. For each of 10 conversations: ingest all turns session-by-session into the memory system
2. For each QA pair: retrieve relevant memories, generate answer using LLM
3. Score answer vs ground truth using LLM judge (GPT-4o or Claude 3.5 Haiku)
4. Report: overall accuracy + per-category (single-hop, multi-hop, temporal, open-domain)
5. Also report: tokens injected per query, p50/p95 latency

**Metrics:** LLM-Judge accuracy % (community standard for Mem0/Zep comparisons). Also report F1 for academic credibility. Include adversarial category — omitting it is how Mem0/Zep inflated scores.

**Time estimate:** ~2–4 hours of API calls for 1,540 QA pairs. Cost: <$20 with Claude 3.5 Haiku.

---

## 5. Quick Self-Hosted Retrieval Quality Benchmarks

### Option A: RAGAS Synthetic Testset

**Source:** https://docs.ragas.io/en/stable/getstarted/rag_testset_generation/

```python
from ragas.testset import TestsetGenerator
generator = TestsetGenerator(llm=generator_llm, embedding_model=embeddings)
dataset = generator.generate_with_langchain_docs(memory_docs, testset_size=100)
```

Metrics: `context_recall`, `context_precision`, `faithfulness`, `answer_relevancy`. Can run locally with Ollama at zero API cost. Requires no external dataset — generates ground truth from your own memory store.

---

### Option B: Entity Graph Precision/Recall

1. Export all stored memories + entity links
2. For 50 seed memories, define expected related memories (via entity graph BFS)
3. Issue 50 queries, measure Precision@K and Recall@K on associated memory retrieval
4. Directly validates spreading activation and association fidelity

Time estimate: 2–4 hours to implement, <30 minutes to run.

---

### Option C: MemBench Capacity Test

Run MemBench to show accuracy vs memory store size — validates σ decay + nightly pruning. No other system publishes this curve.

---

## 6. What Is MemArchitect?

**Paper:** arXiv:2603.18330 — "MemArchitect: A Policy Driven Memory Governance Layer"

**Key claims:**
- Policy-driven approach to memory lifecycle management (what to store, when to evict, dependency tracking)
- Evaluated on **LoCoMo-10** — same `locomo10.json` from snap-research. No novel dataset.
- Compared against MemOS and SimpleMem

**Conclusion:** "MemArchitect's benchmark dataset" in our TODO means running against LoCoMo-10 and comparing per-category to their published scores. The exact per-category numbers are in the PDF (arXiv:2603.18330). Run same format: single-hop, temporal, multi-hop, open-domain.

---

## 7. The Benchmark Credibility Problem

The field has a serious credibility problem:

- Mem0 self-reports 92.5% on LoCoMo; independent researchers put correct-protocol scores at 58–75%
- Zep originally claimed 84%; corrected to 58.44% by Mem0; Zep counter-claimed 75.14%
- A simple filesystem agent with grep beats Mem0-graph on LoCoMo with identical backbone (74.0% vs 68.5%)
- [zep-papers/issues/5](https://github.com/getzep/zep-papers/issues/5) shows evaluation protocol matters more than the system

**Implication for us:** To be credible, publish the evaluation harness code, exact backbone LLM, top-k parameter, and include the adversarial category. Any blog post that omits these will be dismissed by practitioners who've followed the dispute.

**Our edge:** We can publish the eval harness in the same repo as the system. Full reproducibility is a differentiator.

---

## 8. Recommended Benchmarking Path

| Priority | Benchmark | Effort | Value | Target Date |
|---|---|---|---|---|
| 1 | LoCoMo-10 QA (all 4 categories) | 1 day | Table stakes — required for any comparison | June 20 |
| 2 | Latency p50/p95 vs Mem0 API | 0.5 day | Cloudflare edge is a hard differentiator | June 21 |
| 3 | Token efficiency per query | 0.5 day | Collected during LoCoMo run for free | June 21 |
| 4 | Contradiction surface rate | 1 day | Novel metric; no competing system publishes this | June 23 |
| 5 | RAGAS synthetic recall/precision | 1 day | Self-contained; validates hybrid retrieval | June 25 |
| 6 | LongMemEval_S (500 questions) | 2 days | Completes the Mem0/Zep comparison picture | June 28 |
| 7 | Identity coherence (50 queries) | 0.5 day | Differentiating qualitative metric | June 28 |

**July 1 ship** — schedule completes June 28, leaving 2 days to write the post.

### What NOT to run by July 1
- BEAM — requires 1M–10M token scale; not relevant for single-user BYOC
- LongMemEval_M — 500 sessions; too slow to run before July 1
- MemGym — released June 2026; comparison baselines not established yet
- AMA-Bench — complex multi-domain agentic setup; doesn't match our use case

---

## 9. Narrative Angle for the Blog Post

**The killer differentiator: epistemic governance.**

Every other system is evaluated on "did it retrieve the right thing." Gaussian Memory is the first to publish a metric for:
- "Should the agent trust what it retrieved?" — contradiction surface rate
- "Does confidence correlate with evidence quality?" — σ model (Bhattacharyya multiplier)
- "Does accuracy degrade as the store grows?" — capacity curve via MemBench

Frame LoCoMo as **parity with Mem0/Zep**, then show the metrics no one else publishes. The narrative: memory systems have been racing to optimize recall on a benchmark. We're optimizing for something harder — knowing what to trust.

---

## Key Sources

| Resource | URL |
|---|---|
| LoCoMo GitHub | https://github.com/snap-research/locomo |
| EasyLocomo | https://github.com/playeriv65/EasyLocomo |
| SimpleMem test_locomo10.py | https://github.com/aiming-lab/SimpleMem/blob/main/test_locomo10.py |
| LongMemEval GitHub | https://github.com/xiaowu0162/longmemeval |
| LongMemEval-V2 GitHub | https://github.com/xiaowu0162/LongMemEval-V2 |
| BEAM GitHub | https://github.com/mohammadtavakoli78/BEAM |
| MemGym arXiv | https://arxiv.org/abs/2605.20833 |
| MemBench GitHub | https://github.com/import-myself/Membench |
| MemoryAgentBench GitHub | https://github.com/HUST-AI-HYZ/MemoryAgentBench |
| AMA-Bench GitHub | https://github.com/AMA-Bench/AMA-Bench |
| Mem0 memory-benchmarks | https://github.com/mem0ai/memory-benchmarks |
| Mem0 ECAI 2025 paper | https://arxiv.org/pdf/2504.19413 |
| Mem0 benchmarks blog 2026 | https://mem0.ai/blog/ai-memory-benchmarks-in-2026 |
| Mem0 head-to-head comparison | https://mem0.ai/blog/benchmarked-openai-memory-vs-langmem-vs-memgpt-vs-mem0-for-long-term-memory-here-s-how-they-stacked-up |
| Zep temporal KG paper | https://arxiv.org/abs/2501.13956 |
| Zep state-of-the-art blog | https://blog.getzep.com/state-of-the-art-agent-memory/ |
| Zep vs Mem0 dispute | https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/ |
| Zep-papers benchmark issue | https://github.com/getzep/zep-papers/issues/5 |
| Letta benchmarking blog | https://www.letta.com/blog/benchmarking-ai-agent-memory/ |
| LoCoMo ACL 2024 paper | https://aclanthology.org/2024.acl-long.747/ |
| LongMemEval arXiv | https://arxiv.org/abs/2410.10813 |
| LongMemEval-V2 arXiv | https://arxiv.org/abs/2605.12493 |
| BEAM arXiv | https://arxiv.org/pdf/2510.27246 |
| MemArchitect arXiv | https://arxiv.org/pdf/2603.18330 |
| MemoryOS GitHub | https://github.com/BAI-LAB/MemoryOS |
| MemBench ACL 2025 | https://aclanthology.org/2025.findings-acl.989/ |
| RAGAS testset generation | https://docs.ragas.io/en/stable/getstarted/rag_testset_generation/ |
| HN: AI coding agent memory | https://news.ycombinator.com/item?id=46742800 |
| AI memory crisis article | https://medium.com/@mohantaastha/the-ai-memory-crisis-why-62-of-your-ai-agents-memories-are-wrong-792d015b71a4 |
| 5 memory systems compared | https://dev.to/varun_pratapbhardwaj_b13/5-ai-agent-memory-systems-compared-mem0-zep-letta-supermemory-superlocalmemory-2026-benchmark-59p3 |
