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

## DO TOMORROW (2026-06-18) — Decay
Don't blind-build aggressive deletion — verify first, prefer non-destructive.
- [ ] **Verify the problem exists first:** run ~5 real retrievals against the live pool; do cold/old
      memories actually surface and pollute, or is recency weighting (0.25) already burying them?
      If retrieval is already clean → decay is NOT the priority, deprioritize this.
- [ ] If junk surfaces → **soft-forget (no delete):** replace `decaySigma = s+delta` (flat, not
      time-aware) with a forgetting-curve model:
      `S = S0·(1+ln(access+1)); R = exp(−Δt/S); σ_target = floor + (ceil−floor)·(1−R)`
      using `last_accessed` (NOT creation `timestamp` — current cron bug). Sets σ → retrieval
      deprioritizes faded memories. Reversible.
- [ ] Consider whether hard-delete (current prune at σ>2.0) should exist at all — Anki/FSRS never
      delete. If kept: delete ONLY access_count=0 AND idle>45d AND σ>ceiling (sim: ~636 at S0=10d).
      **Back up first** (`npx gaussian-memory backup`).
- [ ] Alternative/simpler lever to consider: just retune retrieval scoring weights (favor recency/
      sharpness) — directly fixes "recent wins" with zero deletion.
- Sim done 2026-06-17: S0=5→prune 2422(46%), S0=7→1825(35%), S0=10→636(12%,all cold).

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

### Be the memory layer for frameworks
- [ ] Vendor-neutral adapter so any agent framework (incl. eve) can use GM as its memory
- [ ] Universal hooks: normalize agent events to a common schema (portable, not Vercel-locked)

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
