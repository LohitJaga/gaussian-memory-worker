# Gaussian Memory — TODO

## Ship Goal — July 1 2026
BYOC model: users deploy to their own Cloudflare account, pay their own $5/month, own their data.
Open source + blog post + one-command setup. Not commercial, not hosted.

## Thesis
**The memory layer for any agent or any LLM — including eve.**
eve (and every agent framework) ships execution, sandbox, orchestration, tracing — but
*no persistent semantic memory*. That gap is the whole product. Don't compete on agent
infrastructure; be the portable, vendor-neutral memory layer that plugs into all of them.
Differentiators: Bayesian/Gaussian uncertainty (memories sharpen/decay), cross-session +
cross-LLM ground truth, edge-native BYOC.

---

## Decay / Cron — ROOT CAUSE FOUND (2026-06-18)
**The nightly cron is silently broken — this is why decay "doesn't work" and cold/old junk piles up.**
Investigated 2026-06-18. `memory_sigma_history` has ZERO `decay`/`prune` events ever; 645 prunable
(σ>1.8) rows and 358 cold-archive-eligible rows are still sitting in D1 un-touched.
- **Root cause:** `scheduled()` (index.ts:146-154) calls `consolidateColdMemories` and `updateDecay`,
  each wrapped in `.catch(() => {})`. Both do **unbounded full-table scans** (`SELECT ... FROM memories`
  with no LIMIT over ~4.6k rows) → time out / `D1_ERROR: overloaded` → error swallowed → 0 work done,
  no log. The e2e `decay` test reproduces the timeout.
- [x] **Fixed the cron failure (verified in code, 2026-07-05):** `updateDecay` (cron.ts:15-20) now
      bounded to `LIMIT 500` ordered by `access_count, timestamp`; `consolidateColdMemories`
      (cron.ts:389-396) bounded to `LIMIT 200`. `scheduled()` (index.ts:194-214) wraps every cron job
      in a named `run()` helper that logs failures via `console.error` instead of swallowing them.
- [x] **R2 cold-archive undo path — confirmed live (2026-07-05):** `consolidateColdMemories`
      (cron.ts:387-460) archives to R2 then deletes from D1/Vectorize; runs on the now-bounded scan
      so it actually executes on every cron tick instead of timing out first.
- [x] **No deletion audit log — fixed (2026-07-05):** `memory_delete` (tools.ts:1109-1141) and
      `memory_bulk_delete` (tools.ts:1305-1350) now archive each memory to R2 at `memories/{id}.json`
      (same shape as `consolidateColdMemories`) before hard-deleting from D1/Vectorize; R2 write
      failures are caught and logged but never block the delete.
- [x] **Verified the retrieval problem exists + fixed it (2026-06-18):** ran real retrievals — cold
      verbatim junk WAS surfacing (chat-speak at 1.5+). Fixed via MMR dedup + session/recency rebalance
      (retrieval) + a one-time cleanup of the junk (see Done 2026-06-18). Retrieval is now clean.
- [x] **Soft-forget decay — implemented, not the exact prescribed formula (confirmed 2026-07-05):**
      cron.ts:27 uses `stability = 1 + ln(access_count+1)` to scale the decay delta (matches the S0
      shape), plus an explicit 3x penalty for cold-stale rows (access_count=0, >7d old, cron.ts:30-34).
      Not the literal `R = exp(-Δt/S)` exponential-retention formula from the plan, but functionally
      addresses "flat decay doesn't account for reinforcement." Revisit only if this approximation
      turns out to prune wrong in practice.
- Sim done 2026-06-17: S0=5→prune 2422(46%), S0=7→1825(35%), S0=10→636(12%,all cold).
- Corpus size note: domain rebuild logged 5,244 on 2026-06-17; 5,170 at session start 2026-06-18
  (backup-proven); 4,608 after today's cleanup. No bulk deletion found yesterday (git Jun 17 = extension
  work only; decay never ran). The ~74 Jun17→Jun18 drift is merges/small deletes — unverifiable (no audit log).

---

## Priority 1 — Do before July 1 (the actual ship)

### Packaging (the real gap — building is mostly done, this isn't)
- [x] One-command setup (`npx gaussian-memory init`) — confirmed 2026-07-05: README documents full
      flow (D1/Vectorize/KV creation, wrangler.toml patch, migrations, deploy, AUTH_TOKEN secret,
      `~/.gaussian-memory-env`, Claude Code + Zed hook auto-config). Git history shows 2 rounds of
      "fix init crash on fresh clone" — exercised against fresh clones, not just the original deploy.
- [ ] Verify a fresh end-to-end install works on a genuinely separate stranger's Cloudflare account
      (fresh-clone testing so far has been on your own account/machine — not the same test)
- [ ] README: thesis + Bayesian/Gaussian differentiator present ("What it does" section) — still
      missing an architecture diagram and a competitor table (vs eve/Mem0)
- [ ] One-line pitch + 1–2 hard numbers (see Benchmarking) so it's not forgettable

### Benchmarking (need numbers for README/blog)
- [ ] Latency — p50/p95 retrieve, edge vs Mem0 API roundtrip (quickest real number)
- [ ] Token savings per call from caching (the resume-point metric)
- [ ] Retrieval quality on a labeled query set
- [ ] Identity coherence — 50 queries, LLM-judge whether injected context is coherent
- [ ] Association fidelity — 100 annotated pairs, BFS precision/recall
- [ ] Contradiction surface rate (lower = better)
- [ ] LoCoMo-style accuracy vs MemArchitect benchmark
- [ ] Reconstruction — how well injected memories reconstruct original context

### Client Compatibility
- [x] Zed — confirmed 2026-07-05: `init` auto-merges a `context_servers` entry into
      `~/.config/zed/settings.json` (README:185-200), same auto-config tier as Claude Code.
- [x] Cursor / OpenCode — documented as broken upstream (README "Known gaps"), not a GM bug:
      Cursor's `sessionStart.additional_context` and OpenCode's `tool.execute.after` are both
      unwired in-runtime, linked to real upstream issue threads.
- [ ] Windsurf, Continue.dev — only a one-line "should work, plain JSON-RPC 2.0" claim in README
      (line 204), never actually verified against a running instance.
- [ ] OpenAI Codex/CLI — not mentioned in README at all yet.
- [ ] "Supported Clients" table in README once the above are confirmed

### Domain Rebuild — KNOWN ISSUE (2026-07-01)
- [ ] **personal-life domain (180 memories) was lost in full rebuild** — Llama scattered them into career-job-search and gaussian-memory-dev (both now suspiciously large: 1238 and 537). personal-life is now in the domain hints for both classifiers so it re-emerges for new memories, but the 180 old ones need a targeted=false rebuild to recover. Not urgent — retrieval still works, just personal content surfaces in wrong domain. Do when there's time to babysit another 156-batch rebuild in OpenCode.
- [ ] **g2f-* micro-domain explosion** — full rebuild fragmented bayer-datamine into 8 g2f-* sub-domains. Fixed via SQL merge on 2026-07-01. bayer-datamine hint added to classifier. If rebuild is run again, confirm g2f content stays consolidated.
- [ ] **targeted=false param was silently ignored** (fixed 2026-07-01 by OpenCode: string-aware parse + schema declaration). Confirm the fix is in src/tools.ts before any future full rebuild.

### Domain Classifier Instability — UPDATED FIX PLAN (supersedes the hybrid-gate plan below), NOT YET IMPLEMENTED (2026-07-02)
**Update after further research + one more rebuild rerun**: rebuild #6 (same 31-domain code, rerun clean)
landed on 50 again — confirms the instability is a stable failure mode, not a fluke. Pulled all 50 real
`domain_anchors` centroids from prod D1 and computed all 1225 pairwise cosine similarities: median sim = 0.91,
and genuine duplicates (e.g. `github-project`↔`github-tool` = 0.992) sit in the *same* range as genuinely
unrelated domains (e.g. `github-profile`↔`bayer-traitprediction-project` = 0.985). **This invalidates the
0.82-gate plan below** — a single global threshold on raw running-mean centroids cannot separate "same domain"
from "different domain" here. Also checked: `refreshDomainSummary`/`refreshStaleDomainSummaries` (domain.ts:195,
cron.ts:322) already exist and run on a growth trigger, but confirmed (by reading the full function body) they
ONLY write a display summary to KV (`domain_summary:${name}`) — they never re-embed the summary or touch
`domain_anchors.embedding`. So none of the centroid-quality problem is mitigated by existing code; this is
genuinely unbuilt, not a case of unused infrastructure.

**Likely cause of the blur**: a running-mean centroid over many memories regresses toward the corpus-wide mean
as a domain grows — it's an average of everything ever filed under that name, so two large, mature domains end
up looking similarly "central" and hard to tell apart by cosine sim alone, even when their content is obviously
different to a human. This is a known failure mode in streaming/incremental clustering, not specific to this repo.

**Published fix that matches this exact failure mode**: k-LLMmeans / k-NLPmeans (arXiv 2502.09667) — periodically
(not every item) replace the numeric running-mean centroid with a fresh embedding of an LLM-generated *textual
summary* of the cluster's current top members. A summary embedding sits further out in semantic space (it
describes what's distinctive, not an average of everything), so it should separate real duplicates from
merely-related-but-distinct domains much better than the raw running mean does.

**Revised plan** (research only so far, not implemented — do this next session):
1. **Reground, don't just display**: extend `refreshDomainSummary` (domain.ts:195) so that, on the same growth
   trigger it already has (≥5 memories, 1.25x growth since last summary), it also calls `embed()` on the
   generated summary text and *replaces* (not blends with the running mean) `domain_anchors.embedding` for that
   domain. Keep the existing KV write as-is. This is the "periodic re-grounding" step from the paper — cheap,
   reuses text already being pulled for the summary.
2. **Add an actual anchor-merge pass — this doesn't exist today.** `remapToAnchoredDomains` (domain.ts:277-307)
   only handles assignments with NO matching anchor yet; it never compares two anchors that both already exist
   in `domain_anchors` against each other. Two near-duplicate anchors created in different batches (e.g.
   `github-project` and `github-tool`) currently never get merged, no matter how similar their centroids are,
   because `anchoredNames.has(...)` short-circuits before any similarity check runs. Add a periodic pass (end of
   a full rebuild, and/or nightly cron) that computes pairwise similarity across all *regrounded* anchors only
   (skip ones still on a raw running-mean centroid — too blurry to compare meaningfully) and merges pairs above
   a threshold: reassign the smaller anchor's memories to the larger one, sum `memory_count`, delete the smaller row.
3. **Don't reuse 0.82 for step 2.** It was tuned against raw running-mean vectors; regrounded (LLM-summary)
   vectors are a different embedding distribution and likely need a different cutoff. Before trusting a number,
   repeat the pairwise-similarity measurement done above but on regrounded centroids for a handful of known-dup
   vs. known-distinct pairs, and pick a threshold empirically — same method that already disproved 0.82.
4. **Set `temperature: 0`** on the `classifyBatchDomains` and `classifyDomainWithLlama` Workers AI calls
   (currently unset, Workers AI defaults to ~0.6) — reduces run-to-run sampling variance independent of the
   merge-pass fix, cheap and safe to do regardless.
5. Leave `classifyBatchDomains` itself as pure LLM classification per batch — the fix point is post-hoc merging
   with better-grounded centroids, not trying to get every batch's assignment right in one shot. Do NOT
   re-attempt a code-level "always remap during full-path" threshold trick (commit 9d7e128, reverted) —
   confirmed to over-merge distinct domains.
Verify by re-running the full rebuild 2x after implementing and confirming domain count converges to roughly the
same number both times — a single good-looking run has already been proven not to mean the fix works (this
happened twice this session: 31 domains looked fixed, then reran clean and got 50).

<details>
<summary>Original hybrid-gate plan (2026-07-02, invalidated by the pairwise-similarity data above — kept for history)</summary>

### Domain Classifier Instability — ROOT CAUSE FOUND, FIX DESIGNED, NOT YET IMPLEMENTED (2026-07-02)
Ran 5 full rebuilds (~4700-4800 memories each) in one session trying to land on a stable domain count.
Same underlying code produced wildly different results run to run: **15 → 31 → 49 (hit the 50 cap) → 6
(catastrophic over-merge, 2 domains absorbed 2000+ memories each) → reverted to the known-good 31-domain
code and reran → landed on 50 (the cap) again.** Confirmed via retrieval.ts:323 that domain is only a
+0.05 soft score boost, not a hard retrieval filter — so this is a correctness/cleanliness bug, not a
functional retrieval regression, but it's a bad look for a public repo and worth fixing properly.

**Root cause**: `classifyBatchDomains` (domain.ts) makes an independent LLM call per batch of ~10 memories
during a full rebuild, and `useFullPath` mode skips `remapToAnchoredDomains` entirely for the whole rebuild
after batch 1 (tools.ts ~1514-1515) — meaning there is zero error-correction on the LLM's domain-name
choices. Since later batches see a domain list shaped by earlier (non-deterministic, temperature-unset)
LLM sampling, small early divergences cascade into wildly different total fragmentation by the end. Two
prior fix attempts both failed: a generic "avoid near-duplicate domain names" prompt instruction (made it
worse: 31→49) and a code-level embedding-similarity remap at threshold 0.6 applied during full rebuilds
(over-corrected badly: 49→6, merged genuinely distinct projects into mega-domains).

**Fix, designed but not yet built — hybrid deterministic-gate + LLM approach:**
The codebase already has a fully deterministic nearest-centroid classifier, `classifyDomain` (domain.ts:47-78,
threshold 0.82 — already tuned from real usage history, see git log `214f929`), but it's currently only used
as a fallback (JSON-parse failure or 50-cap hit), never as the primary path. Git history shows this project
already tried pure-embedding-only classification early on (thresholds 0.75→0.88→reverted to 0.82) and moved
*toward* LLM classification for a reason — likely because pure-embedding-only produces worse, less
semantically meaningful groupings and its fallback naming (`deriveAnchorName`, domain.ts:24-45) just grabs a
crude capitalized keyword instead of a clean name. So: don't replace the LLM, gate it.
1. Add a shared `findBestAnchor(muArr, env)` helper (refactor out of `classifyDomain`'s existing anchor-fetch
   loop) that returns `{name, sim}` for the best-matching existing anchor.
2. In both `classifyDomainWithLlama` and `classifyBatchDomains`, check `findBestAnchor` FIRST. If similarity
   ≥ 0.82, assign directly — no LLM call, fully deterministic, no sampling variance. Only call the LLM for
   memories that *don't* clearly match an existing anchor — the genuinely ambiguous cases where semantic
   judgment actually earns its keep. All 6 call sites of `classifyDomainWithLlama` in tools.ts already pass
   `precomputedMu`, so this fast-path costs zero extra embed() calls.
3. Set `temperature: 0` on the remaining LLM calls (currently unset anywhere in domain.ts, Workers AI default
   is 0.6) to reduce variance on the genuinely-ambiguous cases that still need the LLM.
4. Do NOT re-attempt the code-level "always remap in full-path mode" approach (commit 9d7e128, reverted) —
   confirmed empirically to over-merge distinct domains at threshold 0.6.
Should implement and test against a fresh full rebuild before trusting it — prior "looks fixed" impressions
this session (31 domains) turned out to be one lucky run, not a stable fixed point, so verify by re-running
the rebuild 2x and confirming domain count converges to roughly the same number both times, not just once.

</details>

### Domain Classifier — regrounding + merge fix IMPLEMENTED, LOHIT SAYS DON'T TRUST IT YET (2026-07-02, evening)
Built and deployed the plan above: `refreshDomainSummary` now re-embeds its summary and replaces the centroid
(`is_regrounded` flag), added `findAnchorMerges`/`applyAnchorMerge` (domain.ts), wired a nightly merge pass into
cron at `ANCHOR_MERGE_THRESHOLD = 0.83` (empirically swept, not guessed), and added `/admin/reground-domains` +
`/admin/merge-domains` (dry-run by default) for manual runs. Ran the actual convergence test the plan called for://
full wipe-rebuild → both raw runs hit the 50-domain cap (unchanged — the classifier's own instability isn't
touched by this fix, only cleaned up after). Reground + merge brought both runs down to **47 domains** —
matching baseline-to-baseline, which is the number this fix was supposed to produce.

**But manual review of the merge candidates found real problems, not just cosmetic ones:**
- **False positive at the validated threshold**: `ukg-system-project` (86 memories!) → `claude-code-project` at
  0.838 — Lohit confirmed UKG is a timecard tool, totally unrelated. This is *above* the 0.83 cutoff that
  looked clean on the first rebuild's data, so 0.83 is not actually a safe universal cutoff — it was tuned on
  one sample and already produced a bad merge on the second.
- **Missed real duplicates**: `w1-project` (7), `w2-project` (32), `w3-project` (16), `w4-project` (49),
  `w5-project` (44) are all confirmed by Lohit to be the same thing (L'Oréal weekly work-tracking) but only
  `w3-project → w2-project` (0.868) surfaced as a candidate — w1/w4/w5 weren't flagged as duplicates of each
  other or of w2/w3 at all, despite being conceptually identical. The pairwise-threshold approach caught some
  duplicates and missed others in the exact same cluster.
- Separately: `ukg-system-project` having 86 memories as its own domain in the first place (for a timecard tool)
  suggests the *classifier itself* is over-eager to keep growing a domain that should probably be tiny or folded
  into general admin/logistics content — a symptom the merge-pass band-aid doesn't address at the source.
- `leetcode-problem` ↔ `job-search` (0.840) — Lohit wants these kept separate (correctly did NOT auto-merge,
  held for manual review, this one's fine as a judgment call either way).

**Lohit's verdict, verbatim: "domains still have major issues, i dont trust this at all."** Net assessment:
regrounding+merge is a real, measured improvement (catches true duplicates like the `lore-al`/`loreal` typo and
`gaussian-memory-worker`/`gaussian-memory` split cleanly) but is NOT a solved problem — it has both false
positives and false negatives on the same validated threshold, and the underlying classifier still produces
wildly fragmented output (50-cap) before any cleanup runs. Do not present this as "fixed" going forward.

**Left in a safe, non-destructive state**: 3 confident merges applied (typo dup, gaussian-memory-worker dup,
gemini-3.5-flash dup) → 47 domains. `ukg-system-project`, `leetcode-problem`/`job-search`, and the
w1-w5-project cluster were explicitly NOT merged — left for a proper pass. Regrounding + nightly merge cron is
live in production either way (`ANCHOR_MERGE_THRESHOLD = 0.83` in cron.ts) — worth deciding whether to disable
the automatic nightly merge until the false-positive risk is better understood, since it now runs unattended
every night at a threshold that's already known to produce at least one bad merge.

**To pick up tomorrow:**
1. Decide whether nightly auto-merge (cron.ts `mergeDuplicateAnchors`) should be disabled until threshold
   reliability is better understood, or left running with manual monitoring.
2. Investigate why `w1/w4/w5-project` didn't pair with `w2/w3-project` despite being the same conceptual
   domain — likely means their regrounded summaries emphasize different weekly specifics (SKU anomaly vs. paid
   media vs. calendar API) enough to separate embeddings, even though a human immediately sees them as one
   L'Oréal-work bucket. May need a different signal than pairwise centroid similarity for this case (e.g.
   explicit naming-pattern detection for `w[0-9]-project`, or a coarser "does this look like a sub-project of an
   existing bigger domain" check) rather than relying on embedding similarity alone.
3. Investigate why `ukg-system-project` grew to 86 memories as a business-admin/timecard domain in the first
   place — may be a separate classifier-prompt issue (e.g. "personal/non-work" bucket rule not catching
   logistics-adjacent work content) rather than something the merge pass should be responsible for fixing.
4. Re-sweep the merge threshold with this second (worse) data point included — 0.83 already produced a false
   positive, so the "safe cutoff" from before doesn't hold across rebuilds; may need per-pair review permanently
   rather than a trustable global number, or an entirely different signal.

### Cleanup
- [ ] One-time prune of old verbatim noise in the pool (pre-distillation junk: "Yeah, I do." etc.) — for clean demo retrievals

### Blog
- [ ] Blog post (outline at Downloads/blog_post_outline.md)

### Quality / Testing
- [ ] E2E coverage for remaining tools: `memory_auto_store`, `memory_extract_and_store`, `memory_store_decision`, `memory_store_diff`, `memory_list`, `memory_timeline`, `memory_belief_drift` / `backfill`, `memory_orphan_check`, `memory_judge`, `memory_capture_passive`, `memory_update`, `memory_delete`, `identity_profile_get/set`, domain rebuild/retag/build_entities
- [ ] Retrieval edge case tests: empty query, domain filter, `synthesize=true`, temporal queries (`yesterday`, `this week`), entity boost
- [ ] Unit tests for `src/domain.ts` — classification accuracy + centroid management
- [ ] Unit tests for `src/storage.ts` — Kalman merge correctness, contradiction detection
- [ ] Unit tests for `src/retrieval.ts` — RRF fusion, sigma gating, spreading activation
- [ ] Clean up dead code in `extensions/browser/inject.js`: `GM_TOOLS`, `GM_TOOL_NAMES`, `injectGMTools()`, `injectToolResults()` — unused since Claude tools were dropped; keeping them implies they're active
- [x] Fixed duplicate-POST bug: guarded `tapClaudeStream` (tee failure returns raw response, never re-fetches) + explicit return in Claude catch for pre-dispatch errors (2026-06-17)
- [x] Fixed double-store: `captureChatGPTSSE` now stores the turn exactly once via a `stored` flag / `flush()` ([DONE] or stream end) (2026-06-17)

### Polish
- [ ] Platform import (`npx gaussian-memory import --from mem0`)

---

## Priority 2 — Reach (post-July)

### Browser extension — memory in consumer web LLMs
- [x] Claude.ai — working (context-inject + turn capture via extract_and_store; tools dropped, they hung the chat UI)
- [x] ChatGPT — working (context-inject + both-direction capture; verified live 2026-06-17)
- [x] Unified both platforms on the extract/distill path (clean facts, not verbatim) — verified
- [ ] Gemini — HARDER (probed 2026-06-17): (1) uses **XHR not fetch** → must also wrap
      XMLHttpRequest.open/send; (2) prompt in URL-encoded **nested-array f.req** (protobuf-ish),
      parse-by-position + re-encode. Real build, not a quick port. "Coming soon" for launch.
- [ ] Chrome Web Store submission (or document "load unpacked" for dev-audience launch)

### Agent affordances — tool descriptions as skill docs (2026-06-23)
MCP tools have mechanical descriptions (what, not when). For an MCP server consumed by agents, tool descriptions
ARE the skill docs — the only non-optional surface the agent reads every turn. Fix descriptions to teach agent behavior:
- `memory_timeline` → frame as temporal/"what did I do this week," fix recency sort (currently ranks by access freq)
  - **REPRO 2026-06-29 (tested live w/ Claude):** `memory_timeline(personal-life)` returns ALL rows stamped the same `2026-05-26` (a backfill/import date), so chronological view is collapsed — cannot surface "yesterday" no matter what. Tried passing `order=date_desc`: the MCP layer accepted the extra param (schema permissive) but output was **byte-identical** → handler either ignores `order` OR every row shares one date so re-sort is a no-op. **Root cause = data layer: ingestion flattened event timestamps onto import date.** Two fixes: (1) preserve real `created_at`/event date on ingest (don't overwrite with import time); (2) have timeline parse `order`/`since` and sort by `last_accessed`/event date, not access-freq. Until (1), recency is fundamentally unqueryable (also breaks the `yesterday`/`this week` retrieval edge-case tests above). NOTE: `order`/`since` should be declared in the tool's inputSchema, not just silently accepted.
- `memory_list` → frame as recency/audit tool ("use with since= for 'what did I save today'")
- `memory_retrieve` → frame as topical default, add cross-ref to list/timeline for temporal needs
- `memory_store` → prefer over auto_store, always pass explicit domain (mis-domained memories don't surface)
- `memory_auto_store` → convenience path; note domain inference defaults generic causing mis-tags
- Also ship optional paste-in CLAUDE.md in npm docs for clients that ignore MCP instructions field
See session 2026-06-23 with lohit for full draft copy + rationale.

### Be the memory layer for frameworks
- [ ] Vendor-neutral adapter so any agent framework (incl. eve) can use GM as its memory
- [ ] Universal hooks: normalize agent events to a common schema (portable, not Vercel-locked)

### Self-improvement loop — outcome→behavior (Brain parity, added 2026-06-20)
Perplexity Brain (launched 2026-06-18) closes a record→reflect-overnight→improve-execution loop
(+25% on repeated tasks). GM today is record→retrieve. We already store agent activity (episodic
session summaries, `memory_store_decision` {decision,context,alternatives,outcome}) — the missing
wire is outcome→retrieval-priority. Mechanism (reuses existing Bayesian machinery):
- [ ] **Log retrievals:** new D1 table `retrieval_log {session_id, query, retrieved_ids[], scores[], ts}`
      — without this there's no way to attribute outcomes back to memories.
- [ ] **Harvest reward (sparse, strong signals only):** explicit = `store_decision.outcome` + in-session
      corrections; implicit = reuse `belief_drift` — contradicted memory = negative, reinforced = positive.
- [ ] **Nightly reflect pass (Cron Trigger — same job as the decay/cleanup cron):** give each memory a
      Beta(α,β) utility belief; helped-in-good-session → α++, present-in-corrected → β++. Existing
      sigma/sharpness encodes confidence in utility. Pass also does dedup/supersede/decay (one job).
- [ ] **Feed back into scorer:** `baseScore = 0.6·cos + 0.25·recency + 0.15·freq + w_u·utility[m]`
      → misleading memories suppressed even when cosine-similar, reliable ones boosted. Closed loop.
- Gotchas: weak credit assignment (update on strong signals only, not every session); rich-get-richer
  (keep ε exploration floor + recency/cosine for cold start); reward sparsity (converges slowly).
- ~2–3 focused sessions; reuses log + belief_drift + cron + Bayesian scorer already built.

### Hosted (optional, later)
- [ ] DO-hosted version (per-user isolation, free beta → $1–2/month) — only if BYOC demand justifies it
- [ ] Rebrand (Mnemo taken, need new name)

---

## Done (2026-06-17)
- Domain rebuild — 5,244 memories cleanly classified into 17 real domains (no garbage)
- D3 `/viz` galaxy — every memory as a point, Gaussian clouds per domain; Twitter-demo-ready
- Browser extension: ChatGPT support + unified distillation path + dropped hanging Claude tools
- Killed P2 "Agent OS" roadmap (eve owns it); refocused thesis on the memory layer
- Diagnosed decay: fires but too gentle to prune (flat additive, not time-aware) → see DO TOMORROW

## Dropped (eve owns this — not worth building solo)
- ~~Agent OS: state checkpointing, inter-agent messaging, DO orchestration, model routing, sandboxed compute~~
  (Vercel eve does all of it; the moat is memory, which eve lacks.)
