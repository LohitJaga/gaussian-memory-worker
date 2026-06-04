# Gaussian Memory — TODO

## Next Session (May 27+)
- [x] Finish domain rebuild — complete: 2455 memories, 75 domains (May 26)
- [x] Fix retrieval scoring — cosine+recency+access_freq deployed (May 26)
- [x] Cross-domain dedup fix — tighter merge thresholds deployed (May 26)
- [x] Domain rebuild #2 — 3449 memories → 55 anchored domains (May 26)
- [x] Singleton domain cleanup — memory_cleanup_singletons tool deployed, 131 domains → 48 anchored domains (May 27)
- [x] Spreading activation — already implemented inline in retrieve() via anchor-based neighborhood scoring (May 27)
- [x] Stop hook quality fix — JSON bleed filter, min length 20, intra-batch dedup at 0.92 cosine threshold (May 27)
- [x] Sigma fix — sharpenSigma contradiction-aware (widen ×1.2) + adaptive floor for sparse domains (May 27)
- [x] Nightly cron fully automated — decay → cross-batch dedup (0.90) → singleton cleanup → summary refresh → identity synthesis (May 27)
- [x] Domain summary refresh — nightly sweep of top-20 stale domains, 90-day recency filter, better prompt (May 27)
- [x] Hook injection fix — project-aware keyword routing (gaussian/loreal/leetcode/bayer), dynamic fallback queries from prompt words, threshold 0.85→0.90 (May 27)
- [x] Receipt logging — see May 29 sprint below
- [x] True spreading activation — second Vectorize pass from top-3 anchors, ~ markers (May 28)

## ✅ May 29 — Quality + Maintenance Sprint (DONE)
- [x] GLM-4.7-flash swap — all Llama 3.1 8B calls replaced except memory_store_diff (GLM fails for short-prompt tasks), ~4.7× cheaper on input tokens
- [x] Stop hook truncation removed — full sessions now captured up to 30K chars via GLM 131K context (was head+tail 4500 char hack)
- [x] Domain summary threshold guard — summary only shown if ≥2 memories from domain in results (was showing for every domain including 1-memory hits)
- [x] Domain-specific summary prompt — prompt now includes domain name so summaries stop converging to generic text
- [x] Per-project isolation — `project` column in D1, Vectorize metadata, all 3 hooks auto-detect git root via `git rev-parse`. Retrieval filters to [current_project, 'default']. Legacy memories stay in 'default' pool and surface as fallback
- [x] PostToolUse quality gate — (1) Edit/Write: skip new_string < 30 chars, (2) Bash: expanded skip list (git ops, npm/pip install, mkdir/touch/chmod/rm/mv/cp), output < 15 chars skipped, (3) Worker: semantic entropy check strips digits/punctuation, skips if old=new after stripping
- [x] Exact normalized match fast path in storeMemory — Graphiti-style: before Bhattacharyya, check normalized text equality on Vectorize candidates. Catches re-ingestion with trivial surface diffs, zero extra API calls
- [x] Nightly junk pruning — `pruneJunkMemories` in cron: cold episodic < 80 chars > 30 days old auto-cleared every night
- [x] Accelerated decay 1.5× — cold memories (access_count=0, age>60 days) get decaySigma applied twice per cron run. Dead weight hits σ>2.0 pruning threshold ~2× faster
- [x] Daily cold dedup — `deduplicateColdMemories`: 500 oldest cold memories at 0.93 threshold every night. Oldest-first so domain-bleeding duplicates from weeks ago get hit immediately. Our differentiator vs competitors (all use MD5/exact match only)
- [x] Cron rebuild 30→2000 rows/night — `cronRebuildBatch` ports batch-10 GLM classification from tool handler. Time-budget guard (10 min). Full reclassify in ~4 nights vs 213 days
- [x] 49 garbage memories deleted — file ops (.png, .ipynb, git LFS, staged), raw chat filler
- [x] Timeline fixed — Week 3 was misdated June 2–4, corrected to June 14–20
- [x] Cold memory R2 archive tier — added to nightly consolidation plan: nightly Llama compress cold σ>1.5 → R2 artifact, drop from D1/Vectorize, lazy retrieval fallback
- [x] Bug fix: GLM response parsing — added `choices[0].message.content` fallback across all GLM call sites
- [x] Bug fix: entropy check null safety — `!= null` instead of truthiness so empty old_string doesn't bypass check

## Usability Blockers — fix before Week 2 tools matter
- [x] Receipt logging — done May 29, see Quality Issues section
- [x] Orphan check / repair tool — done May 29, see Quality Issues section

## Quality Issues — fix before Week 2
- [x] Receipt logging — `~/.claude/gaussian-receipts.jsonl`, JSONL per prompt: ts, project, query_hash, topic, latency_ms, injected, results, score_buckets. Async subshell, never blocks injection. Rotates at 500 lines (May 29)
- [x] Extraction prompt SKIP rules — added vague intent SKIP ("Wants to", "Is considering", "Is planning", etc.), specificity rule (preserve exact names/numbers/technologies), standalone test, aspirational noise rule. Also fixed `.slice(-4000)` → `.slice(0, 60000)` — was silently dropping first 26K chars of every long session at worker level (May 29)
- [x] Orphan check / repair tool — `memory_orphan_check` tool: getByIds in batches of 20 (Vectorize hard limit), reports count + IDs, repair=true re-embeds and upserts. Found 1 orphan out of 6,431, repaired (May 29)
- [x] GLM guardrails for memory_store_diff — JSON output format (`{"description":"..."}`) + temperature:0 + fallback raw text. Working. Drops from $0.282/M to $0.060/M input on every PostToolUse call (May 29)

## Quality / Signal
- [ ] Test retrieval quality after a week of L'Oreal sessions — are relevant memories surfacing?
- [ ] Track semantic memory % weekly (now ~115/2254, target 10-15%)
- [ ] Weekly spot check: query 3 things worked on last week, verify relevant memories surface
- [ ] Fix: homework/Bayer memories still surfacing in unrelated queries — domain rebuild + better scoring should fix
- [x] PostToolUse quality gate — deployed May 29: length filter + expanded bash skip + semantic entropy check + junk pruning cron
- [ ] Safety checks for users — D1 backup strategy, Vectorize consistency checks, graceful degradation if worker is unreachable. No memory loss on deploy or migration.
- [ ] Auth: API key on worker endpoints — currently unauthenticated, anyone with the URL can read/write/delete all memories. Blocker before sharing publicly.
- [ ] Indirect prompt injection hardening — stop hook captures arbitrary text; malicious content from visited sites could get stored and injected. Add sanitization pass stripping instruction-like patterns before storage.
- [ ] Llama classification injection — user text passed directly to Llama for domain classification. "Ignore previous instructions" could manipulate domain assignment. Fix: stricter system prompt rejecting meta-instructions.

## Ship Goal — July 1 2026
BYOC model: users deploy to their own Cloudflare account, pay their own $5/month, own their data.
Open source + blog post + one-command setup. Not commercial, not hosted.

### ✅ Week 1 (May 28) — DONE
- [x] Batch D1 reads (`WHERE id IN`) — 10 sequential queries → 1 (May 28)
- [x] Domain filter before sigma deserialization (May 28)
- [x] `mu` reuse in memory_auto_store — embed once, reuse for classify (May 28)
- [x] `returnMetadata: 'indexed'` on all 4 Vectorize query paths (May 28)
- [x] `memory_store` returns conflict candidates on cosine > 0.85 (May 28)
- [x] Temporal grounding — ISO date injected into Llama extraction prompt (May 28)
- [x] Spreading activation — true second Vectorize pass from top-3 anchors, ~ markers (May 28)

### Week 2 (June 7–13) — New Tools
- [x] `memory_judge` — conflicts_with / supersedes / compatible / extends + memory_relations table (D1). LLM verdict via Llama 3.3 70B. Auto-judges all contradiction_flag=1 memories or single ID. Superseded memories marked [SUPERSEDED] at retrieve time. (May 29)
- [x] `memory_capture_passive` — parses Key Learnings/Decisions/Problems Solved/Insights/Action Items headers + bullets. Intra-batch dedup at 0.92. Section type → memory_type inference. Caps at 20/call. (May 29)
- [x] `memory_timeline` — chronological view per domain (or top accessed cross-domain). Groups by month, shows date/sigma/access_count/conflict markers. Superseded and conflict memories flagged inline. (May 29)
- [x] `memory_store` structured params — topic_key upsert (prevents proliferation, same key updates in place) + revision_count tracking. Prefix ID lookup support. D1 migration: topic_key TEXT, revision_count INTEGER. (May 29)
- [x] Per-project isolation — done May 29, see Quality + Maintenance Sprint
- [ ] Nightly consolidation — compress cold σ>1.5 memories via Llama, write compressed artifact to R2, drop from D1/Vectorize. Retrieval falls back to R2 cold archive only if live pool scores below threshold. Live pool stays sharp; cold tier grows cheaply with zero egress cost.

### Week 3 (June 14–20) — Advanced + Ship Infra
- [x] D1 FTS5 virtual table — 6,366 memories indexed, dual-write triggers (INSERT/UPDATE/DELETE), unicode61 tokenizer. (June 3)
- [x] RRF scoring — merges Vectorize cosine + FTS5 BM25 with RRF k=60. FTS5-only IDs injected into D1 candidate pool. (June 3)
- [x] Score normalization — min-max per component (cosine, recency, accessFreq) within result batch before combining. Spread improved from 0.9-1.2 → 0.28-1.33. (June 3)
- [x] Recency hot tier — KV 'hot:recent_ids' (24h TTL, 100 IDs FIFO). Written on every store, merged into candidate pool on retrieve. Hot memories score 1.52 vs cold 0.28. (June 3)
- [x] MCP project fix — project='default' now searches all memories (no project filter). Enables direct MCP calls without hook. (June 3)
- [x] Extraction prompt improved — Mem0-style transition capture "Switched X → Y because Z", exact parameter preservation (topK=2 not "small topK"), 15-80 word range. (June 3)
- [x] LLM project retag — memory_retag_projects tool, Llama classifies default pool into correct projects. 4,093 → 2,764 default (genuinely ambiguous remainder). (June 3)
- [x] Sleep command filter — posttool hook now skips sleep/wait/true/false/exit commands. 10 garbage memories deleted. (June 3)
- [x] Security fixes — SQL injection in project clause (parameterized binding), FTS5 operator precedence (parenthesized project clause). (June 3)
- [ ] Multi-hop BFS spreading activation (configurable depth)
- [ ] `valid_from`/`valid_to` on memories + schema migration
- [ ] `npx gaussian-memory init` script (wrangler deploy + MCP config + hooks)
- [x] Generalize retrieval hook — removed all hardcoded project/keyword mappings. Now purely project-name-anchored (git root → Q2/Q3). Works for any project without config. Short messages (<25 chars) use project-anchored Q1 instead of empty-word fallback. No config file needed — new projects auto-detected. (May 29)
- [ ] Generalize BYOC worker — no hardcoded personal info in wrangler.toml/index.ts, gaussian.config.json for user identity
- [ ] OpenCode + PiDev hook support — ship hooks/ folder in repo with Claude Code + OpenCode + PiDev variants. OpenCode is most popular open-source harness, needs native support for BYOC adoption. Research extension/plugin format for both. Validate PostToolUse hook fires correctly in each harness and retrieval quality is consistent across call patterns.
- [ ] `npx gaussian-memory ingest <file.md>` — CLI wrapper over memory_capture_passive for cold start onboarding. Reads markdown file, chunks by ## headers, calls capture_passive per section. New users can seed store from existing notes before first session.
- [x] Stop hook extraction: add "implementation decisions with specific parameters" as priority category — done June 3, extraction prompt updated with Mem0 transition format + parameter precision.
- [x] Session-aware retrieval — Llama 3.1-8b rewrites short queries (<60 chars) using prompt context before embedding. 1.5s timeout, fallback to raw query. Hook passes PROMPT as context on Q1. (June 2)
- [x] Session summary memories — second GLM pass in memory_extract_and_store synthesizes session into: worked on / decided / still open. Stored as memory_type='session' with emotional_intensity=0.9 (tight sigma, slow decay). +0.20 retrieval boost. type preserved on all merge paths. (June 1)
- [ ] Compaction-triggered extraction — Claude Code doesn't expose a compaction hook yet. When context fills mid-session, memories before compaction are currently lost until Stop. Future: hook into compaction event to run memory_extract_and_store on pre-compaction context.
- [x] Entity graph retrieval — entity_nodes + memory_entities tables created. 1-hop traversal in retrieve(): query tokens → lookup entity_nodes → pull connected memory_ids → boost +0.1/shared entity (max 0.2). Retroactive batch job (memory_build_entities): all 6,373 memories processed via Llama → 2,051 unique entities, 4,535 links. Forward extraction: new memories queued to KV pending_entity_queue on store (awaited), processPendingEntityQueue() runs in cron nightly (50/run). memory_process_entity_queue test tool added. (June 3)

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
- [x] Orphan check (done May 29 — `memory_orphan_check` with repair flag)
- [ ] Cold start onboarding (5-question interview seeds day 1)
- [x] Receipt logging (done May 29 — `~/.claude/gaussian-receipts.jsonl`)
- [ ] Auth hardening (confirm bearer token on all endpoints)
- [ ] Retrieval quality spot check (3 queries from last week, verify surfacing)
- [ ] Hook safety + UX (print hook content before install, y/N confirmation)

### Post-ship (July+)
- [ ] DO hosted version (per-user isolation, free beta → $1-2/month)
- [ ] Async write queue (Cloudflare Queues)
- [ ] BM25 hybrid alongside Vectorize
- [ ] Multi-user DO isolation
- [ ] Analytics `/stats` endpoint (80% done via memory_stats)
- [ ] Rebrand (Mnemo taken, need new name)

## Visualization (pre-ship demo)
- [ ] Domain graph — D3.js or canvas, nodes sized by memory count, edges between related domains by centroid cosine similarity
- [ ] Activation overlay — highlight which nodes lit up during a retrieve() call, show spreading activation in real time
- [ ] Ship as `/viz` endpoint on the worker or standalone HTML — embed in README + use in Twitter demo video

## Competitor Techniques to Steal

### From Mem0 (researched June 2, 2026)
- [x] **Entity boost** — Mem0-style: extract capitalized tokens + @cf/ patterns + CW SKUs from query (max 3 entities). Embed each, query Vectorize topK=10, boost matching memory scores by min(0.25, 0.5/spread). GLM memory score 0.89→0.98 on entity queries. (June 2)
- [ ] **Over-fetch + rerank** — Mem0 fetches `max(topK * 4, 60)` candidates, then reranks with BM25 + entity scores before returning top-k. We return raw Vectorize top-k with no reranking. Cheap win.
- [ ] **BM25 hybrid** — Mem0 lemmatizes query, runs keyword search alongside semantic. Already in Week 3 TODO (FTS5) but worth prioritizing — keyword search catches exact SKU names, function names, etc. that cosine misses.
- [ ] **Context at storage not retrieval** — Mem0 uses last 10 messages during extraction (storage), not retrieval. Their retrieval is pure semantic + entity. Our session-aware retrieval plan (GLM intent extraction) is the opposite approach — worth testing both.

### From Zep
- [ ] **Session graph** — Zep maintains a separate session-level knowledge graph updated each turn. Retrieval queries the graph first, then vector store. More structured than our domain routing but higher maintenance.

## Differentiators vs SuperMemory (ship separately with blog/Twitter)
- [ ] Decision trails — store not just what happened but why: decision + context + alternatives considered. Surface "last time you faced this tradeoff you chose Y because Z." No other memory system does this.
- [ ] Belief drift over time — expose the Gaussian uncertainty model: "3 months ago you thought X, now your behavior suggests Y — here's what changed." Key-value stores can't do this.
- [ ] Contradiction surfacing (already built) — "you said you prefer X but you keep doing Y." Stateful probabilistic model detects this; a key-value store can't. Needs to be marketed as a feature.

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
