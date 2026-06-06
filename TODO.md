# Gaussian Memory — TODO

## Ship Goal — July 1 2026
BYOC model: users deploy to their own Cloudflare account, pay their own $5/month, own their data.
Open source + blog post + one-command setup. Not commercial, not hosted.

## Active / Current

### Quality / Signal
- [ ] Weekly spot check: query 3 things worked on last week, verify relevant memories surface
- [ ] Fix: homework/Bayer memories still surfacing in unrelated queries — needs domain rebuild
- [ ] Safety checks for users — D1 backup strategy, graceful degradation if worker unreachable
- [ ] Decay too weak — zero-access memories never get pruned (0 prunable after decay run). Add 3× sigma multiplier for access_count==0 memories so cold pile clears in weeks not months

### Week 3 Remaining
- [ ] Multi-hop BFS spreading activation (configurable depth)
- [ ] `valid_from`/`valid_to` on memories + schema migration
- [ ] Generalize BYOC worker — no hardcoded personal info, gaussian.config.json for user identity
- [ ] Nightly consolidation — compress cold σ>1.5 via Llama → R2, drop from D1/Vectorize, lazy fallback
- [ ] Compaction-triggered extraction — hook into Claude Code compaction event when exposed

### Week 4 (June 21–27) — Polish + Docs
- [ ] index.ts modularization (typed interfaces, split modules)
- [ ] README (neuroscience angle, competitor table, tagline)
- [ ] Blog post (outline at Downloads/blog_post_outline.md)
- [ ] D3 `/viz` endpoint (domain graph + activation overlay)
- [ ] Belief drift report — "σ=0.2 → σ=0.6 over 3 months"
- [ ] Decision trails memory type — {decision, context, alternatives, outcome}
- [ ] Platform import (`npx gaussian-memory import --from mem0`)

### June 28–July 1 — Test + Security Window
- [ ] E2E test suite (store → retrieve → sigma → dedup → decay)
- [ ] Cold start onboarding (5-question interview seeds day 1)
- [ ] Retrieval quality spot check (3 queries from last week, verify surfacing)
- [ ] Hook safety + UX (print hook content before install, y/N confirmation)

## Competitor Techniques to Steal

### From Mem0
- [ ] Over-fetch + rerank — fetch `topK * 4` candidates, rerank with BM25 + entity scores before returning top-k
- [ ] BM25 hybrid — keyword search catches exact SKU names, function names that cosine misses
- [ ] Context at storage not retrieval — use last 10 messages during extraction, pure semantic at retrieval

### From Zep
- [ ] Session graph — session-level knowledge graph updated each turn, retrieval queries graph first then vector store

## Differentiators (ship with blog/Twitter)
- [ ] Decision trails — store not just what happened but why: decision + context + alternatives. Surface "last time you faced this tradeoff you chose Y because Z"
- [ ] Belief drift over time — "3 months ago you thought X, now your behavior suggests Y — here's what changed"
- [ ] Contradiction surfacing (built) — needs marketing as a feature

## Post-ship (July+)
- [ ] DO hosted version (per-user isolation, free beta → $1-2/month)
- [ ] Async write queue (Cloudflare Queues)
- [ ] Multi-user DO isolation
- [ ] Analytics `/stats` endpoint
- [ ] Rebrand (Mnemo taken, need new name)
- [ ] Universal Hooks Protocol — spec + per-agent adapters (Claude Code, OpenCode, Cursor, Codex, pi.dev) normalizing agent events to a common schema. Hook once, memory everywhere.
- [ ] Agent OS — memory as the kernel. Routing, handoffs, personalization, cross-editor state all sit on top of shared memory ground truth. Most agent OS projects start with orchestration and bolt memory on — this inverts that.
- [ ] Session bus / handoffs table — D1 `handoffs` table as cross-LLM coordination layer. Claude writes task + complexity, DeepSeek polls and picks up. Emergent already (Claude responses surfacing in DeepSeek retrieval as side effect of today's integration).
- [ ] Model routing — hard tasks → Opus, fast/cheap → DeepSeek free, both share memory. Better than OpenRouter (which has zero personalization). Cross-editor memory sync makes this viable.

## Visualization (pre-ship demo)
- [ ] Domain graph — D3.js, nodes sized by memory count, edges between related domains by centroid cosine similarity
- [ ] Activation overlay — highlight which nodes lit up during retrieve(), show spreading activation in real time
- [ ] Ship as `/viz` endpoint or standalone HTML — embed in README + Twitter demo video
