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
- [ ] **Fix the cron failure (highest priority):** bound the scans with `WHERE`+`LIMIT` (process
      candidates in batches, not the whole table), and STOP swallowing errors silently (log them so
      nightly failures are visible). Applies to both `updateDecay` and `consolidateColdMemories`.
- [ ] **R2 cold-archive undo path exists but isn't running:** `consolidateColdMemories` (cron.ts:365)
      archives cold memories to R2 (`R2.put('memories/{id}.json')`) THEN deletes from D1 — the designed
      undo path. But it never executes (358 eligible rows still in D1 → R2 is ~empty). Fixing the cron
      above makes the archive/undo path actually work.
- [ ] **No deletion audit log:** `memory_delete`/`memory_bulk_delete`/prune all hard-delete with no
      record of what/when. Can't reconstruct past counts or undo manual deletes. Add a `memories_archive`
      table (or reuse R2) on ALL delete paths, not just cold-archival, for a real undo + audit trail.
- [x] **Verified the retrieval problem exists + fixed it (2026-06-18):** ran real retrievals — cold
      verbatim junk WAS surfacing (chat-speak at 1.5+). Fixed via MMR dedup + session/recency rebalance
      (retrieval) + a one-time cleanup of the junk (see Done 2026-06-18). Retrieval is now clean.
- [ ] **Still want soft-forget decay** (separate from the cron fix): replace `decaySigma = s+delta`
      (flat) with forgetting-curve `S = S0·(1+ln(access+1)); R = exp(−Δt/S); σ_target = floor +
      (ceil−floor)·(1−R)` using `last_accessed` (NOT creation `timestamp` — current cron bug).
      Reversible (sets σ, doesn't delete). Prefer this over hard-delete (Anki/FSRS never delete).
- Sim done 2026-06-17: S0=5→prune 2422(46%), S0=7→1825(35%), S0=10→636(12%,all cold).
- Corpus size note: domain rebuild logged 5,244 on 2026-06-17; 5,170 at session start 2026-06-18
  (backup-proven); 4,608 after today's cleanup. No bulk deletion found yesterday (git Jun 17 = extension
  work only; decay never ran). The ~74 Jun17→Jun18 drift is merges/small deletes — unverifiable (no audit log).

---

## Priority 1 — Do before July 1 (the actual ship)

### Packaging (the real gap — building is mostly done, this isn't)
- [ ] One-command setup (`npx gaussian-memory init`) — clean deploy to a stranger's own Cloudflare acct
- [ ] Verify a fresh end-to-end install works (not just dogfooded on my own deployment)
- [ ] README: thesis + Bayesian/Gaussian differentiator, neuroscience angle, architecture diagram, competitor table (vs eve/Mem0)
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
- [ ] Verify + document MCP support: Zed, OpenAI Codex/CLI, Windsurf, Continue.dev
- [ ] "Supported Clients" table in README once confirmed

### Domain Rebuild — KNOWN ISSUE (2026-07-01)
- [ ] **personal-life domain (180 memories) was lost in full rebuild** — Llama scattered them into career-job-search and gaussian-memory-dev (both now suspiciously large: 1238 and 537). personal-life is now in the domain hints for both classifiers so it re-emerges for new memories, but the 180 old ones need a targeted=false rebuild to recover. Not urgent — retrieval still works, just personal content surfaces in wrong domain. Do when there's time to babysit another 156-batch rebuild in OpenCode.
- [ ] **g2f-* micro-domain explosion** — full rebuild fragmented bayer-datamine into 8 g2f-* sub-domains. Fixed via SQL merge on 2026-07-01. bayer-datamine hint added to classifier. If rebuild is run again, confirm g2f content stays consolidated.
- [ ] **targeted=false param was silently ignored** (fixed 2026-07-01 by OpenCode: string-aware parse + schema declaration). Confirm the fix is in src/tools.ts before any future full rebuild.

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
