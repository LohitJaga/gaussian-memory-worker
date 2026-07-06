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
Research already done — see `BENCHMARKING.md` (compiled 2026-06-15): which public benchmarks exist
(LoCoMo, LongMemEval, BEAM, MemBench, MemoryAgentBench, MemGym), how Mem0/Zep/Letta evaluate themselves
(with the known credibility disputes between them), a concrete LoCoMo-10 run plan, and a recommended
benchmarking order. No actual numbers have been produced yet — this section is genuinely unstarted,
but don't re-research from scratch, the plan already exists.
- [x] Latency — first real number, then fixed the biggest tail cost (2026-07-06). Initial measurement
      (15 `memory_retrieve` calls, live worker, ~4.6k-memory corpus, persistent HTTP/2 connection to
      isolate real server time from per-call handshake overhead): **p50=1.5s, p95=9.9s**. Root-caused
      the tail to `retrieval.ts`'s `domainSizeRows` query (`SELECT domain, COUNT(*) FROM memories
      GROUP BY domain`) — an unindexed full-table scan run on **every single retrieve call**, only
      used to set a confidence-floor threshold in `sharpenSigma` (tolerant of staleness). Fixed by
      cache-aside through KV with a 60s TTL (`getDomainSizeMap`, retrieval.ts) instead of hitting D1
      every call. Deployed and re-measured: **p50=1.4s (~6% down), p95=3.9s (~60% down)**. Not
      benchmarked against Mem0's API yet. p50 is still not fast for a "real-time" pitch — `retrieve()`
      still does ~6-8 D1/Vectorize/Workers-AI round trips per call (embed, vector query, FTS5, entity
      graph, cluster cohesion, candidate fetch, BFS hops) — but the worst-case is no longer ~10s.
- [x] **New bug found + fixed while chasing this (2026-07-06)**: the e2e sigma regression test failed
      deterministically (reproduced twice, not flaky) because `retrieve()`'s project scoping is
      `project = ? OR project = 'default'` — even the e2e suite's own unique test project always also
      searches real `default`-project data. Since `default` now contains extensive real dogfooding
      content about "Bayesian," "sharpen with reinforcement," etc., the freshly-stored test memory got
      crowded out / deduped against real higher-access-count memories instead of surfacing cleanly.
      Several *other* tests in the same file were only passing because their assertions didn't filter
      by the test's unique prefix and were silently matching real production content instead of the
      memory the test actually stored — a suite-wide false-confidence gap, not just the one failure.
      Fixed by switching the e2e fixtures (`TEXT_A`/`TEXT_B`) to topically unrelated synthetic content
      (penguin banding / synth repair) with zero real-world overlap, instead of Bayesian/Cloudflare
      content that collides with this project's own vocabulary — test-only change, zero production
      behavior change. Verified: full e2e suite (10/10) passes clean now.
- [x] **`OR project='default'` fallback — made opt-out instead of ripped out (2026-07-06)**: the fallback
      itself is genuinely useful for real callers (project-scoped agents still surfacing general
      identity/preference facts) so it stays the default — ripping it out would regress real usage just
      to fix test isolation. Added `strictProject` param to `retrieve()` (retrieval.ts) and `strict_project`
      to the `memory_retrieve` MCP tool (tools.ts) so a caller can opt a specific query out of the
      default-project blend for true isolation. Extracted `projectScopeClause()` since the same
      `project === 'default' ? '' : '...OR default'` logic was duplicated 3x in retrieval.ts (temporal
      fetch, main candidate fetch, BFS re-fetch) — centralizing it meant strict-mode support landed in
      all 3 at once instead of risking 2-of-3. Also declared `project` in the tool's inputSchema (was
      silently accepted but undocumented, same gap already flagged for `memory_timeline`'s `order`/`since`).
      e2e suite now passes `strict_project: true` on every retrieve call — real exercise of the new
      param, not just unit tests. Deployed + verified: 10/10 e2e pass, and ~30% faster (41s vs ~62-70s)
      since strict scoping means a smaller candidate pool to dedupe against.
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

### Domain / cluster_id split — RESOLVED (2026-07-05)
Everything above this line (regrounding, anchor-merge, hybrid-gate, k-LLMmeans plans) is superseded and
removed — none of it shipped; it's preserved in git history (stashed, never merged) if ever needed for
reference. The actual fix ended up being architectural, not a better threshold: domain was doing two jobs
(human-facing named taxonomy + the signal retrieval depends on for dedup/diversity), and no amount of
threshold-tuning fixes a taxonomy job's instability from corrupting a retrieval-mechanics job. Split them:

- **domain** — unchanged, still the named/capped taxonomy for browsing + (now-abandoned) `/viz`. Full-corpus
  rebuild replaced with deterministic clustering (Fable's work, 2026-07-05): clusters raw embeddings first
  (order-independent average-linkage, no LLM in the grouping step), one LLM call per resulting cluster for
  naming only. Rerunning on the same corpus now reproduces the same domains — the original instability
  (15/31/49/6/50 across reruns) is gone. `clusterStep`'s O(k²) merge-trace computation crashed Workers'
  CPU budget around k~2100 micro-clusters (well under the naive 2500 safety cap, never load-tested) — bounded
  to the largest 500 clusters only (rebuild.ts, `MAX_MERGE_CANDIDATES`), small ones fold in via existing
  nearest-cluster-or-general logic. Rebuild tool works now; not urgent to ever run since day-to-day tagging
  isn't affected by any of this.
- **cluster_id** (new) — raw, unnamed, uncapped micro-cluster assignment, pure embedding math, no LLM,
  backed by a dedicated `MICRO_VECTORIZE` index (`src/microcluster.ts`). This is what `storage.ts`'s dedup
  gates and `retrieval.ts`'s diversity cap actually read now, instead of domain — confirmed via live testing
  (2026-07-05: verified a known 6-member near-duplicate cluster got correctly suppressed to ≤3 in real
  results). Domain mislabeling can no longer corrupt dedup or repetition control.
- [x] **`/viz` repointed to cluster_id, then abandoned as not worth further effort (2026-07-05)** — after
  3 rounds of tuning (label/placement density, dust/glow contrast, cosmic color palette + radial gradient)
  it still didn't look compelling. Purely cosmetic, not worth more time; left functional but unpolished.
- [ ] **Known minor gap, low priority**: `retrieval.ts`'s adaptive sigma floor (line ~40-44/527,
  `sharpenSigma`'s domain-size-based confidence floor) still reads `domain`, not `cluster_id` — the one
  retrieval-adjacent thing domain mislabeling can still quietly affect. Confirmed via live testing this does
  NOT cause wrong search results (tested 3 unrelated queries, only correct content surfaced) — it only nudges
  confidence scoring slightly. Two candidate fixes were considered and both rejected on real technical
  grounds: swapping to cluster_id count doesn't work (clusters are too fine-grained — nearly every memory
  would read as "sparse" since most clusters have 1-5 members); swapping to the memory's own access_count
  doesn't work either (already double-counted in baseScore's `normAccess` term — would create a rich-get-richer
  loop rewarding anything retrieved often, relevant or not). A live embedding-neighborhood-density check
  (looser similarity threshold than cluster_id's, computed at retrieval time) was proposed as a third option
  but not built — revisit only if real evidence shows this actually causing bad ranking, not preemptively.

### Cleanup
- [ ] One-time prune of old verbatim noise in the pool (pre-distillation junk: "Yeah, I do." etc.) — for clean demo retrievals

### Blog
- [ ] Blog post — outline exists (`../blog_post_outline.md`, 123 lines, "Reconstructive Memory for
      AI Agents") but the post itself is unwritten. Path was stale (said Downloads/, actually lives
      one directory up from this repo) — fixed 2026-07-06.

### Quality / Testing
- [ ] E2E coverage for remaining tools: `memory_auto_store`, `memory_extract_and_store`, `memory_store_decision`, `memory_store_diff`, `memory_list`, `memory_timeline`, `memory_belief_drift` / `backfill`, `memory_orphan_check`, `memory_judge`, `memory_capture_passive`, `memory_update`, `memory_delete`, `identity_profile_get/set`, domain rebuild/retag/build_entities
- [ ] Retrieval edge case tests: empty query, domain filter, `synthesize=true`, temporal queries (`yesterday`, `this week`), entity boost
- [x] `microcluster.test.ts` existed but wasn't wired into `npm test` — fixed (2026-07-06), was silently never running
- [x] Unit tests for `src/domain.ts` (2026-07-06) — `domain.test.ts`, 16 tests covering `deriveAnchorName` + `bestAnchor`.
      Found 2 real (minor) bugs while writing these, both fixed same day (2026-07-06): (1) the fallback-pass
      regex stripped uppercase letters instead of case-folding, so a capitalized stop-listed word reaching that
      pass got corrupted (e.g. "Session" → "ession") instead of being matched or skipped — fixed by lowercasing
      before stripping (domain.ts:43); (2) `bestAnchor`'s `bestSim` started at -1 with a strict `>` compare, so
      a lone anchor at exactly sim=-1 returned `null` instead of that anchor — fixed by using `-Infinity` as the
      sentinel (domain.ts:64). Tests updated to pin the corrected behavior. Ran a multi-angle code review on
      this whole diff after (2026-07-06): correctness angles found nothing; cleanup findings led to a shared
      `normalizeToken()` helper in `deriveAnchorName` (was 3 independently-written passes, same bug class could
      have recurred), consolidating `gaussian.ts`'s `cosine()` to delegate to `embed.ts`'s `dotProduct()` (was
      two copies of the same math), and parameterizing `dedupBySimilarity`'s thresholds + `sigmaGate`'s
      floor/multiplier (were hardcoded, inconsistent with `applyDiversityCap`'s style) — with tests added that
      actually exercise the new parameters.
- [x] Unit tests for `src/retrieval.ts` (2026-07-06) — extracted the pure pieces (`rrfMerge`, `minMaxNormalize`,
      `tokenize`/`jaccardSimilarity`/`dedupBySimilarity`, `sigmaGate`, `applyDiversityCap`) out of the monolithic
      `retrieve()` into named exports (behavior-preserving refactor, verified via typecheck + full e2e-adjacent
      test pass), then added `retrieval.test.ts`, 32 tests. The BFS/spreading-activation score combination
      itself is still untested at unit level — it's entangled with live Vectorize calls inside the hop loop;
      e2e is still the right coverage tool for that part.
- [x] Unit tests for `src/storage.ts` contradiction detection (2026-07-06) — exported `isContradiction` and
      `normalizeForExactMatch` (was an inline arrow fn), added `storage.test.ts`, 12 tests. Kalman merge math
      itself was already covered by `gaussian.test.ts` (storage.ts just calls `kalmanMerge`, doesn't reimplement
      it). The spawn/merge/contradiction *branching* in `storeMemory` remains untested at unit level — it's
      inline D1/Vectorize/KV calls, would need a mocked `Env` to isolate; not attempted this pass.
- [x] Clean up dead code in `extensions/browser/inject.js` — confirmed 2026-07-05: `GM_TOOLS`/`GM_TOOL_NAMES`/`injectGMTools()`/`injectToolResults()` don't exist anywhere in the repo (removed in commit `38f3c7c`, part of the 2026-06-17 session); this item was just never checked off
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
