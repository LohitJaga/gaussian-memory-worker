# Gaussian Memory — TODO

## Ship Goal — July 1 2026
BYOC model: users deploy to their own Cloudflare account, pay their own $5/month, own their data.
Open source + blog post + one-command setup. Not commercial, not hosted.

## Thesis (sharpened after Vercel eve, 2026-06-17)
**The memory layer for any agent or any LLM — including eve.**
eve (and every agent framework) ships execution, sandbox, orchestration, tracing — but
*no persistent semantic memory*. That gap is the whole product. Don't compete on agent
infrastructure (eve owns it); be the portable, vendor-neutral memory layer that plugs into
all of them. Differentiators: Bayesian/Gaussian uncertainty (memories sharpen/decay),
cross-session + cross-LLM ground truth, edge-native BYOC.

---

## Priority 1 — Do before July 1 (the actual ship)

### Packaging (the real gap — building is mostly done, this isn't)
- [ ] One-command setup (`npx gaussian-memory init`) — clean deploy to a stranger's own Cloudflare acct
- [ ] Verify a fresh end-to-end install works (not just dogfooded on my own deployment)
- [ ] README: thesis above + Bayesian/Gaussian differentiator, neuroscience angle, architecture diagram, competitor table (incl. where it sits vs eve/Mem0)
- [ ] One-line pitch + 1–2 hard numbers (see Benchmarking) so it's not forgettable

### Benchmarking (define before running — need numbers for README/blog)
- [ ] Latency — p50/p95 retrieve, Cloudflare edge vs Mem0 API roundtrip (quickest real number)
- [ ] Token savings per call from caching (the resume-point metric)
- [ ] Retrieval quality on a labeled query set
- [ ] Identity coherence — 50 diverse queries, LLM-judge whether injected context forms a coherent self-consistent picture
- [ ] Association fidelity — annotate 100 memory pairs as related, measure BFS precision/recall
- [ ] Contradiction surface rate — how often retrieval injects directly conflicting memories (lower = better)
- [ ] LoCoMo-style accuracy — comparable number vs MemArchitect's benchmark dataset
- [ ] Reconstruction — given a query, how well injected memories reconstruct original context vs ground truth

### Client Compatibility
- [ ] Verify + document: Zed MCP support
- [ ] Verify + document: OpenAI Codex / CLI MCP support
- [ ] Verify + document: Windsurf, Continue.dev, other Claude Code alternatives
- [ ] "Supported Clients" table in README once confirmed

### Blog (after features stable)
- [ ] Blog post (outline at Downloads/blog_post_outline.md)

### Polish
- [ ] Platform import (`npx gaussian-memory import --from mem0`)

---

## Priority 2 — Reach (post-July, where the project actually grows now)

### Browser extension — memory in consumer web LLMs (eve does NOT touch this — wide open)
- [x] Claude.ai — working (fetch intercept: inject memories + GM tools, capture/store, UI scrub)
- [ ] ChatGPT (chatgpt.com/backend-api/conversation — JSON, doable: context inject + capture; tools not feasible on their web)
- [ ] Gemini (gemini.google.com — batchexecute/protobuf payloads, hard; later)
- [ ] Ship as the headline demo: "memory that follows you across Claude, ChatGPT, your coding agents"

### Be the memory layer for frameworks
- [ ] Vendor-neutral integration story / adapter so any agent framework (incl. eve) can use GM as its memory
- [ ] Universal hooks: normalize agent events to a common schema (portable, not Vercel-locked)

### Hosted (optional, later)
- [ ] DO-hosted version (per-user isolation, free beta → $1–2/month) — only if BYOC demand justifies it
- [ ] Rebrand (Mnemo taken, need new name)

---

## Dropped (2026-06-17) — eve owns this space, not worth building as a solo dev
- ~~State checkpointing / durable execution~~ (Vercel Workflow)
- ~~Inter-agent messaging / routing / session bus~~ (eve channels + subagents)
- ~~Orchestration via Durable Objects (one DO per agent, spawn sub-agents)~~ (eve runtime)
- ~~Model routing across agents~~ (eve agent.ts config)
- ~~Sandboxed compute~~ (eve microVMs)
Reason: this was the over-scoped, feasibility-risky part of the plan and never the
differentiator. The moat is memory, which eve lacks. Refocus there.
