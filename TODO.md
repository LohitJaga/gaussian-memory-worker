# Gaussian Memory — TODO

## Immediate (next session)
- [ ] Fix domain cap enforcement: INSERT in centroid update bypasses 50-domain cap — add count check there
- [ ] Merge duplicate domains: career-goal/careergoal, data-acquisition/dataacquisition, presentation-formats/presentations-formats
- [ ] Fix "general" bucket (130 memories) — re-run Llama classification on those specifically
- [ ] Re-run memory_rebuild_domains after cap fix to collapse fragmented data-* cluster

## Quality / Signal
- [ ] Test retrieval quality after a week of L'Oreal sessions — are relevant memories surfacing?
- [ ] Track semantic memory % weekly (now 98/2228 = 4.4%, target 10-15%)
- [ ] Weekly spot check: query 3 things worked on last week, verify ≥0.95 retrieval score
- [ ] Domain summaries will auto-generate as domains hit 5+ memories with 25% growth

## Architecture (pre multi-user)
- [ ] Per-user isolation via Durable Objects (planned, not started)
  - Each user gets own DO instance, isolated D1 + Vectorize namespace
- [ ] Auth: API key per user on every worker request
- [ ] Setup automation: one-liner install script (`claude mcp add` + hook files)
- [ ] Cold start onboarding: 5-10 question interview to seed semantic memories

## Done
- [x] Parallel multi-query retrieve hook (3 queries, score ≥0.95, identity domain filtered)
- [x] Stop hook: tail -c 4000 (captures real work, not setup chatter)
- [x] Stop hook + worker: pre-filter strips file paths/URLs/extensions before Llama
- [x] CLAUDE.md KV sync for cross-device bootstrap (identity_profile_get/set)
- [x] Nightly cron: decay + identity synthesis from semantic memories
- [x] Contradiction surfacing in retrieve (de-biasing pass)
- [x] Soft-collapse blending (synthesize=true param on memory_retrieve)
- [x] memory_bulk_delete tool (SQL LIKE pattern)
- [x] Decay fixed: batched D1 writes (was silently failing with 2138 individual calls)
- [x] Llama extraction prompt: structured output with type classification, SKIP rules
- [x] Retrieve hook /dev/tty output: injected memories visible in terminal
- [x] Increased extraction: 3-5 facts → 5-8 facts, max_tokens 300→500
- [x] classifyDomainWithLlama: replaces cosine classifier for new stores (auto_store + extract_and_store)
- [x] updateDomainCentroid: incremental mean centroid per domain, triggers domain summaries
- [x] refreshDomainSummary: Llama summary → KV domain_summary:{name} when domain grows 25%+
- [x] Two-stage retrieve: domain routing via centroid cosine → Vectorize filter → fallback global
- [x] memory_retrieve: domain summary injection grouped by [DOMAIN: name] header
- [x] memory_rebuild_domains: Llama batch classification (1081 → 152 domains, 86% reduction)
