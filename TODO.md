# Gaussian Memory — TODO

## Next session
- [ ] Re-run `memory_rebuild_domains` after 3-5 clean sessions (post extraction pre-filter fix)
- [ ] Trigger nightly cron manually once: `memory_decay` → verify identity synthesis produces usable CLAUDE.md
- [ ] Cold start onboarding: 5-10 question interview to seed semantic memories for new users

## Quality / Signal
- [ ] Test retrieval quality after a week of L'Oreal sessions — are relevant memories surfacing?
- [ ] Track semantic memory % weekly (currently 77/2128 = 3.6%, target 10-15%)
- [ ] Weekly spot check: query 3 things worked on, verify ≥0.95 retrieval score

## Architecture (pre multi-user)
- [ ] Per-user isolation via Durable Objects (planned, not started)
  - Each user gets own DO instance, isolated D1 + Vectorize namespace
- [ ] Auth: API key per user on every worker request
- [ ] Setup automation: one-liner install script (`claude mcp add` + hook files)
- [ ] Cold start UI: web form → POST to `memory_store` with semantic type

## Done
- [x] Parallel multi-query retrieve hook (3 queries, score ≥0.95, identity domain filtered)
- [x] Stop hook noise filter (>20 char lines only)
- [x] CLAUDE.md KV sync for cross-device bootstrap (identity_profile_get/set)
- [x] Nightly cron: decay + identity synthesis from semantic memories
- [x] Contradiction surfacing in retrieve (de-biasing pass)
- [x] Soft-collapse blending (`synthesize=true` param on memory_retrieve)
- [x] memory_bulk_delete tool (SQL LIKE pattern)
- [x] memory_rebuild_domains: batch embed + anchor cache (fixes CPU/subrequest limits)
- [x] Domain threshold 0.75→0.82, classifyDomainFromCache optimization
- [x] Junk memory cleanup: deleted URL strings, repo name noise (~40 memories)
- [x] Llama extraction prompt: structured output with type classification, SKIP rules
- [x] Retrieve hook /dev/tty output: injected memories visible in terminal
- [x] Stop hook: head→tail (tail -c 4000 not head -c 1500), captures real work not setup
- [x] Stop hook: shell pre-filter strips file paths + URLs before sending to worker
- [x] Worker pre-filter: TypeScript strips paths/URLs/extensions/UUIDs before Llama call
- [x] Increased extraction limit: 3-5 facts → 5-8 facts per session, max_tokens 300→500
- [x] Decay fixed: batched D1 writes (was silently failing with 2138 individual calls)
