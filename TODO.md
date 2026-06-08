# Gaussian Memory — TODO

## Ship Goal — July 1 2026
BYOC model: users deploy to their own Cloudflare account, pay their own $5/month, own their data.
Open source + blog post + one-command setup. Not commercial, not hosted.

## Active

### Core / Retrieval
- [ ] Multi-hop BFS spreading activation (configurable depth)
- [ ] Over-fetch + rerank — fetch `topK * 4`, rerank with BM25 + entity scores before returning top-k
- [ ] Context at storage not retrieval — use last 10 messages during extraction, pure semantic at retrieval
- [ ] Fix: homework/Bayer memories surfacing in unrelated queries — needs targeted domain rebuild

### Schema / Storage
- [ ] `valid_from`/`valid_to` on memories + schema migration
- [ ] Nightly consolidation — compress cold σ>1.5 via Llama → R2, drop from D1/Vectorize, lazy fallback

### Infrastructure / Quality
- [ ] E2E test suite (store → retrieve → sigma → dedup → decay)
- [ ] Hook safety UX — print hook content before install, y/N confirmation
- [ ] D1 backup strategy + graceful degradation if worker unreachable
- [ ] Retrieval quality spot check (3 queries from last week, verify surfacing)
- [ ] Init: auto-write `source ~/.gaussian-memory-env` to shell profile (detect zsh/bash, append line, confirm to user) AND write `Authorization` bearer token into `~/.claude/mcp.json` — both were missing, token was never in MCP config so tool calls were silently Unauthorized (hooks worked via zshrc independently)

### Polish + Docs
- [ ] index.ts modularization (typed interfaces, split modules)
- [ ] README (neuroscience angle, competitor table, tagline)
- [ ] Blog post (outline at Downloads/blog_post_outline.md)
- [ ] Decision trails memory type — {decision, context, alternatives, outcome}
- [ ] Platform import (`npx gaussian-memory import --from mem0`)

### Demo
- [ ] D3 `/viz` endpoint — domain graph + activation overlay, ship as standalone HTML for Twitter demo

## Post-ship (July+)
- [ ] DO hosted version (per-user isolation, free beta → $1-2/month)
- [ ] Rebrand (Mnemo taken, need new name)
- [ ] Universal Hooks Protocol — spec + per-agent adapters normalizing agent events to a common schema. Hook once, memory everywhere.
- [ ] Agent OS — memory as the kernel. Routing, handoffs, personalization, cross-editor state on shared memory ground truth.
- [ ] Session bus / handoffs table — D1 `handoffs` table as cross-LLM coordination layer.
- [ ] Model routing — hard tasks → Opus, fast/cheap → DeepSeek free, both share memory.
- [ ] Browser extension — inject retrieved memories into ChatGPT/Claude.ai/Gemini web sessions.
