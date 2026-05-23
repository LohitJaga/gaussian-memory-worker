# Gaussian Memory — TODO

## Immediate (next session)
- [ ] Run `memory_bulk_delete` on junk memories after CI deploys:
  - Pattern: `%gaussian-memory.lohit-cloudflare-pm-assesment.workers.dev%`
  - Pattern: `%successfully responded%`
  - Pattern: `%restart gaussian-memory%`
  - Pattern: `%error code:%`
- [ ] Re-run `memory_rebuild_domains` after junk cleanup (fresh anchors from clean data)
- [ ] Verify retrieval quality: "Gaussian memory architecture" should return real facts, not URLs

## Quality / Signal
- [ ] Improve `memory_extract_and_store`: filter tool output patterns before sending to Llama
  - Skip lines containing URLs, file paths with `/`, "successfully", "error code"
- [ ] Improve semantic memory classification: current keyword heuristic only produces 74/2141 semantic
  - Have Llama classify type (episodic/semantic/procedural) as part of extraction
- [ ] Cold start onboarding: 5-10 question interview to seed semantic memories for new users

## Identity Synthesis
- [ ] Trigger nightly cron manually once to generate first auto-CLAUDE.md from semantic memories
- [ ] Validate synthesized profile quality vs manually written CLAUDE.md

## Architecture (pre multi-user)
- [ ] Per-user isolation via Durable Objects (planned, not started)
  - Each user gets own DO instance with isolated D1 + Vectorize namespace
- [ ] Auth: API key per user on every worker request
- [ ] Setup automation: one-liner install script (writes hooks + runs `claude mcp add`)
- [ ] Cold start UI: web form → POST to memory_store with semantic type

## Done this session
- [x] Parallel multi-query retrieve hook (3 queries, score ≥0.95, identity domain filtered)
- [x] Stop hook with noise filter (>20 char lines only)
- [x] CLAUDE.md backed to KV for cross-device sync (identity_profile_get/set)
- [x] Nightly cron: decay + identity synthesis from semantic memories
- [x] Contradiction surfacing in retrieve (de-biasing)
- [x] Soft-collapse blending (synthesize=true param)
- [x] memory_bulk_delete tool (pending CI deploy)
- [x] Domain threshold tuned (0.75→0.82), classifyDomainFromCache optimization
- [x] memory_rebuild_domains: batch embed + anchor cache (fixes CPU limit)
