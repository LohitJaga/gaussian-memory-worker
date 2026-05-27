# Gaussian Memory — TODO

## Next Session (May 27+)
- [x] Finish domain rebuild — complete: 2455 memories, 75 domains (May 26)
- [x] Fix retrieval scoring — cosine+recency+access_freq deployed (May 26)
- [x] Cross-domain dedup fix — tighter merge thresholds deployed (May 26)
- [x] Domain rebuild #2 — 3449 memories → 55 anchored domains (May 26)
- [x] Singleton domain cleanup — memory_cleanup_singletons tool deployed, 131 domains → 48 anchored domains (May 27)
- [ ] Add spreading activation — memory_edges table in D1, one-hop traversal on retrieve, boosts related memories
- [ ] Receipt logging — retrieve hook emits privacy-safe receipt (query_hash, result_count, score_buckets, injected=true/false, latency_ms) to local log file
- [ ] Verify stop hook quality — check what this session stored, confirm priority categories (decisions/problems/context) vs old flat extraction

## Quality / Signal
- [ ] Test retrieval quality after a week of L'Oreal sessions — are relevant memories surfacing?
- [ ] Track semantic memory % weekly (now ~115/2254, target 10-15%)
- [ ] Weekly spot check: query 3 things worked on last week, verify relevant memories surface
- [ ] Fix: homework/Bayer memories still surfacing in unrelated queries — domain rebuild + better scoring should fix

## Ship Goal — July 1 2026
BYOC model: users deploy to their own Cloudflare account, pay their own $5/month, own their data.
Open source + blog post + one-command setup. Not commercial, not hosted.
- [ ] `npx gaussian-memory init` — one command: clone worker, wrangler deploy, install MCP config + hooks
- [ ] Spreading activation graph (differentiator from SuperMemory — they don't have this)
- [ ] Retrieval receipts — privacy-preserving debug artifact, another differentiator
- [ ] Cold start onboarding: 5-10 question interview seeds semantic memories on first run
- [ ] Multi-user isolation via Durable Objects (per-user SQLite, Vectorize filter by user_id)
- [ ] Auth: API key per user
- [ ] Analytics endpoint `/stats` (already 80% there via memory_stats)
- [ ] Blog post: "Self-hosted Bayesian memory for Claude Code with spreading activation" — HN + Cloudflare audience
- [ ] Platform import tool: accept JSON exports from mem0/SuperMemory so users don't lose history when switching

## Done — May 26 2026
- [x] Upgraded to Cloudflare Workers Paid ($5/month) — removed 10K neuron/day cap
- [x] Domain classifier fix: now passes existing 50 domains to Llama, tells it to consolidate — stops fragmentation
- [x] Domain cap raised 50 → 75 (safety valve, Llama guidance keeps it small autonomously)
- [x] memory_store_diff tool: PostToolUse now passes raw diff to worker, Llama infers semantic meaning before storing (replaces useless "Edited index.ts: {" format)
- [x] PostToolUse hook rewritten to use memory_store_diff for Edit/Write/Bash
- [x] Stop hook: beginning+end capture (replaces tail-only, early session decisions no longer lost)
- [x] Extraction prompt: priority categories (decisions / problems solved / project context / preferences) replaces flat "5-8 facts"
- [x] Fact cap raised 8 → 12 per session
- [x] Retrieval verified working: loreal-internship surfaces at score 1.05, gaussian-memory-dev domain building correctly
- [x] Domain rebuild ran (partial — ~120/2254 with new prompt before stopping)

## Done — Before May 26
- [x] PostToolUse hook (gaussian-posttool.sh): fires after every Edit/Write/Bash
- [x] Stop hook JSON artifact fix: filter strips raw JSON lines from leaking into extraction
- [x] Domain cap enforcement at INSERT time in updateDomainCentroid + rebuild
- [x] memory_rebuild_domains: 2220/2261 → 50 domains
- [x] Parallel multi-query retrieve hook (3 queries, score ≥0.85, identity domain filtered)
- [x] Stop hook pre-filter: strips file paths/URLs/extensions before Llama
- [x] CLAUDE.md KV sync for cross-device bootstrap
- [x] Nightly cron: decay + identity synthesis
- [x] Contradiction surfacing in retrieve
- [x] Soft-collapse blending (synthesize=true)
- [x] memory_bulk_delete tool
- [x] Decay fixed: batched D1 writes
- [x] Llama extraction prompt: structured output with type classification + SKIP rules
- [x] classifyDomainWithLlama: replaces cosine classifier
- [x] Two-stage retrieve: domain centroid routing → Vectorize filter → global fallback
- [x] memory_retrieve: domain summary injection
- [x] memory_rebuild_domains: Llama batch classification
