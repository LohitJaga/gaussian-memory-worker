# Gaussian Memory — TODO

## Ship Goal — July 1 2026
BYOC model: users deploy to their own Cloudflare account, pay their own $5/month, own their data.
Open source + blog post + one-command setup. Not commercial, not hosted.

---

## Priority 1 — Do before July 1

### Core / Retrieval
- [x] Multi-hop BFS spreading activation ✓

### Infrastructure / Quality
- [ ] E2E test suite (store → retrieve → sigma → dedup → decay)
- [ ] Benchmarking — retrieval latency (p50/p95), scoring quality on labeled query set, D1 query count per retrieve call

### Client Compatibility
- [ ] Verify + document: Cursor MCP support (likely works, needs confirmation)
- [ ] Verify + document: Zed MCP support
- [ ] Verify + document: OpenAI Codex / CLI MCP support
- [ ] Verify + document: Windsurf, Continue.dev, other Claude Code alternatives
- [ ] Add "Supported Clients" table to README once confirmed

### README + Blog (after features are stable)
- [ ] README: Bhattacharyya differentiator, neuroscience angle, architecture diagram, competitor table
- [ ] Blog post (outline at Downloads/blog_post_outline.md)

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
