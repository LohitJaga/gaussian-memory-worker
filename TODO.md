# Gaussian Memory — TODO

## Next session
- [ ] Re-run `memory_rebuild_domains` on clean data (post junk deletion) for better domain anchors
- [ ] Trigger nightly cron manually once: `memory_decay` → verify identity synthesis produces usable CLAUDE.md
- [ ] Cold start onboarding: 5-10 question interview to seed semantic memories for new users

## Quality / Signal
- [ ] Improve semantic memory count — currently 74/2138. New Llama prompt classifies type per fact (deployed)
- [ ] Improve `memory_extract_and_store` pre-filter: skip lines with URLs/file paths before sending to Llama
- [ ] Test retrieval quality after a week of L'Oreal sessions — are relevant memories surfacing?

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
- [x] Junk memory cleanup: deleted URL strings, repo name noise (~20 memories)
- [x] Llama extraction prompt: structured output with type classification, SKIP rules
- [x] Retrieve hook stderr output: injected memories visible in terminal
