# Gaussian Memory — TODO

## Ship Goal — July 1 2026
BYOC model: users deploy to their own Cloudflare account, pay their own $5/month, own their data.
Open source + blog post + one-command setup. Not commercial, not hosted.

---

## Priority 1 — Do before July 1

### README (do first — it's the project's resume)
- [ ] README: Bhattacharyya differentiator, neuroscience angle, architecture diagram, competitor table
- [ ] Blog post (outline at Downloads/blog_post_outline.md)

### Core / Retrieval
- [ ] Multi-hop BFS spreading activation (configurable depth)
- [ ] Over-fetch + rerank — fetch `topK * 4`, rerank with BM25 + entity scores before returning top-k
- [ ] Context at storage not retrieval — use last 10 messages during extraction, pure semantic at retrieval
- [ ] Fix: homework/Bayer memories surfacing in unrelated queries — targeted domain rebuild

### Schema / Storage
- [ ] `valid_from`/`valid_to` on memories + schema migration
- [ ] Nightly consolidation — compress cold σ>1.5 via Llama → R2, drop from D1/Vectorize, lazy fallback

### Infrastructure / Quality
- [ ] E2E test suite (store → retrieve → sigma → dedup → decay)

### Polish
- [ ] Decision trails memory type — {decision, context, alternatives, outcome}
- [ ] LangChain BaseMemory wrapper example — thin HTTP client, lives in examples/langchain_memory.py
- [ ] `npx gaussian-memory show [N]` — pretty-print last N retrievals
- [ ] D3 `/viz` endpoint — domain graph + activation overlay, ship as standalone HTML for Twitter demo
- [ ] Platform import (`npx gaussian-memory import --from mem0`)

---

## Priority 2 — July+ (Agent OS roadmap)

### State Checkpointing (~1-2 weeks)
- [ ] `checkpoints` table in D1: `agent_id`, `task_id`, `step`, `state_json`, `timestamp`
- [ ] Serialize agent context (tool calls made, intermediate results, next step) at each step
- [ ] Resume from checkpoint on failure or cross-agent handoff

### Inter-Agent Messaging (~2-3 weeks)
- [ ] Message queue in D1 or Cloudflare Queues: `from_agent`, `to_agent`, `payload`, `status`
- [ ] Routing layer to dispatch messages to the right agent
- [ ] Session bus / `handoffs` table as cross-LLM coordination layer

### Orchestration — Durable Objects (~3-4 weeks, hardest piece)
- [ ] One Durable Object per agent instance — persistent state, communicates with other DOs
- [ ] Spawn sub-agents, pass context, await results
- [ ] Model routing: hard tasks → Opus, fast/cheap → DeepSeek, both share memory ground truth

### Broader Agent OS
- [ ] Universal Hooks Protocol — spec + per-agent adapters normalizing agent events to common schema
- [ ] Browser extension — inject retrieved memories into ChatGPT/Claude.ai/Gemini web sessions
- [ ] DO hosted version (per-user isolation, free beta → $1-2/month)
- [ ] Rebrand (Mnemo taken, need new name)
