# Gaussian Memory — Known Problems & Proposed Fixes

Current state: 6,449 memories, 73 domain anchors, 3 memory_relations rows.
Written May 30 2026 after full codebase + dashboard audit.

---

## P1 — Cron fails nightly [CRITICAL]

**What:** `deduplicateColdMemories` calls `batchEmbed(500 texts)` and `cronRebuildBatch` calls `batchEmbed(2000 texts)`. Workers AI `@cf/baai/bge-base-en-v1.5` has a batch limit of ~100 texts per call. Both blow past it. The cron errors at `deduplicateColdMemories` and everything after it (cleanupSingletons, refreshStaleDomainSummaries, cronRebuildBatch, synthesizeIdentityProfile) never runs.

**Evidence:** Analytics show `errors: 1, requests: 1` at 06:00:55 UTC May 30. All prior cron runs affected similarly once memory count grew past ~100 cold.

**Impact:** Nightly maintenance is completely broken. Decay, dedup, domain refresh, identity synthesis — none of it runs reliably.

**Fix:** Chunk `batchEmbed` internally to batches of 100, run sequentially. One-function change, everything that calls it stays the same:

```ts
async function batchEmbed(texts: string[], env: Env): Promise<Float32Array[]> {
  const CHUNK = 100;
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += CHUNK) {
    const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: texts.slice(i, i + CHUNK) }) as any;
    for (const vec of result.data as number[][]) {
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      out.push(new Float32Array(vec.map(v => v / norm)));
    }
  }
  return out;
}
```

Additionally: `cronRebuildBatch` re-embeds memories that are already in Vectorize. Replace `batchEmbed` there with `VECTORIZE.getByIds` to pull stored vectors directly — eliminates the embed API calls entirely for the rebuild path.

---

## P2 — The core Gaussian scoring function is dead code [CRITICAL]

**What:** `distributionalScore()` (index.ts:195) and `querySigmaVal` (index.ts:209) are computed but **never used in the retrieval scoring formula**. The actual primary score is:

```
primaryScore = 0.6 * cosine + 0.25 * recency + 0.15 * accessFreq
```

This is standard semantic search. Every competitor does exactly this. The Gaussian model (Bhattacharyya distance, uncertainty-aware retrieval, sharp memories activating selectively) is implemented in the math library but disconnected from what actually ranks results. `sigmaWeight` is used as a multiplier in spreading activation but not in the primary ranking.

**Impact:** The core differentiator — "sharp confident memories rank higher than fuzzy uncertain ones for tight queries; broad uncertain memories surface for vague queries" — does not exist in practice. The system is semantically identical to Mem0 in retrieval quality.

**Fix:** Replace the flat `0.6 * cosine` weight with a sigma-modulated score. When `querySigmaVal` is low (specific query), weight cosine heavily and penalize high-sigma memories. When `querySigmaVal` is high (vague query), allow high-sigma memories to surface:

```ts
const sigFactor = 1.0 - 0.3 * (meanSigma(memSigma) / (querySigmaVal + 0.01));
const cosineWeighted = cosineSim * Math.max(0.4, sigFactor);
const primaryScore = 0.6 * cosineWeighted + 0.25 * recency + 0.15 * accessFreq;
```

Or use `distributionalScore(cosineSim, querySigmaVal, meanSigma(memSigma))` directly as the cosine component. Either way, sigma needs to affect ranking or the Gaussian model is purely cosmetic.

---

## P3 — Domain routing is the wrong pre-filter [HIGH]

**What:** Stage 1 retrieval (index.ts:211-228) scores the query against all 73 domain centroids, picks top-3 with score > 0.25, and uses those as a hard Vectorize filter. The problem: domain centroids are built from project-mixed memories. Top domain "memory-management" has 425 memories in 'default' project (all your projects mixed) and only 3 in 'gaussian-memory-worker'. The centroid is an average of everything — L'Oreal work, Bayer data, personal preferences, and actual Gaussian dev work. When a Gaussian query matches "memory-management", the Vectorize filter includes ~428 mixed-context memories.

**Evidence:** `social-media-attitudes` domain has appeared 27 times in retrieval injections during Gaussian Memory work sessions. `data-management`, `data-storage`, `data-quality-control` — all project-mixed — dominate the injection receipts.

**Additional issue:** The 0.25 cosine threshold against domain centroids is extremely permissive. Almost any query scores above 0.25 against some domain, so the filter almost always fires even when the centroid match is weak.

**Impact:** Wrong memories surface (L'Oreal, Bayer, personal) in project-specific sessions. The domain routing is actively hurting retrieval quality, not helping it.

**Fix:** Two options, not mutually exclusive:

Option A — Raise threshold to 0.55+ and require top domain score to be meaningfully higher than second (gap > 0.1) before filtering. This prevents spurious domain selection.

Option B — Replace domain filter with project filter in the Vectorize query. `project` is already indexed in Vectorize metadata. Use `{ project: { $in: [project, 'default'] } }` instead of the domain filter. This correctly scopes the search before D1 runs. Domain alignment becomes a scoring boost (small +0.05-0.10 for matching domain) rather than a gate.

Option B is the right long-term direction and aligns with project isolation being the correct boundary.

---

## P4 — No session summary memories [HIGH]

**What:** The stop hook extracts up to 12 individual facts from the session log via Llama. There is no "session summary" memory — no record of what was worked on, what decisions were made, what's still open. `session_type: 0` in the DB confirms no session memories exist.

**Impact:** Every new session starts cold on continuity. The system can surface facts about you (preferences, career goals, past projects) but cannot answer "what were we doing in the last session on this project?" This is the primary stated goal of the system and it's not implemented.

**Fix:** Add a second Llama pass at the end of the stop hook, after `memory_extract_and_store`. Synthesize the session into a single structured memory:

```
Worked on: [what], Decided: [key decisions], Still open: [unresolved items], Project: [project]
```

Store as `memory_type='session'` with high emotional_intensity so it starts with a tight sigma and survives decay. This is Week 3 roadmap but it's the single highest-leverage unimplemented feature.

---

## P5 — memory_judge pipeline is dormant [HIGH]

**What:** `contradiction_flag` is only set when cosine > 0.88 AND one text has a negation word the other doesn't (`NEGATION` regex, index.ts:34). This triggers on almost nothing — only 2 memories are flagged out of 6,449. `memory_judge` only auto-runs on `contradiction_flag=1` memories. So the judge runs on 2 memories and produces 3 relations. The `conflict_candidates` surfaced by `storeMemory` (near-misses with cosine > 0.85, index.ts:164) are returned in the API response but nothing ever acts on them.

**Impact:** The contradiction/supersedes pipeline — a key differentiator — is effectively unused. Near-duplicate memories accumulate instead of being judged and resolved.

**Fix (two parts):**

1. Wire `memory_judge` into the nightly cron. After `deduplicateRecentMemories`, run judge on the last N near-miss pairs stored in the past 24h. The `conflict_candidates` from each `storeMemory` call could be queued in KV for the cron to process.

2. Broaden what memory_judge targets. Don't wait for `contradiction_flag=1`. Instead, query for memory pairs with cosine 0.82–0.95 (similar but not merged) that have no existing relation. Judge those. This is where the real semantic redundancy and conflicts live.

---

## P6 — Spreading activation missing project filter [MEDIUM]

**What:** The second Vectorize pass (spreading activation, index.ts:338-379) fetches new D1 rows without a project filter:

```ts
const newRows = await env.DB.prepare(
  `SELECT id, text, domain, memory_type, sigma_diagonal, access_count, contradiction_flag, timestamp, last_accessed
   FROM memories WHERE id IN (...)`  // ← no project filter
).bind(...newIds).all<...>();
```

The primary query (index.ts:254) correctly filters `project = ? OR project = 'default'`. The spreading activation query does not. Any memory — from any project — can surface through spreading activation.

**Impact:** L'Oreal and Bayer memories surface via spreading activation even when they would be filtered by the primary query. This is one of the causes of irrelevant context injection.

**Fix:** Add ` AND (project = ? OR project = 'default')` to the spreading activation D1 query. Pass `project` parameter through to that query. One-line fix.

---

## P7 — Vectorize metadata loses project on merge [MEDIUM]

**What:** When memories merge, the Vectorize upsert omits the `project` field (index.ts:142):

```ts
// Merge path:
await env.VECTORIZE.upsert([{
  id: bestId,
  values: Array.from(mu),
  metadata: { domain, memory_type: memoryType },  // project missing
}]);

// Spawn path (correct):
await env.VECTORIZE.upsert([{
  id,
  values: Array.from(mu),
  metadata: { domain, memory_type: memoryType, project },  // has project
}]);
```

After any merge, the Vectorize entry loses its project tag. If project-based Vectorize filtering is ever used (see P3 Option B), merged memories will not be correctly scoped.

**Fix:** Add `project` to the merge-path metadata. One word.

---

## P8 — Retrieve hook timeout too tight [MEDIUM]

**What:** Both `gaussian-retrieve.sh` and `gaussian-posttool.sh` use `--max-time 2`. The worker's retrieval pipeline (embed query + domain routing + Vectorize + D1 + spreading activation) takes 1.5-2.5s. At 2s, queries frequently timeout.

**Evidence:** Receipts show `latency_ms: 2000` on most entries (capped by timeout). 21% zero-result rate, many of those are timeouts not genuine empty results.

**Impact:** Relevant memories exist but aren't injected because the hook times out before the worker responds. The system appears broken when it's just slow.

**Fix:** Increase to `--max-time 4` in both hooks. The retrieve hook runs 3 parallel queries so the wall time is `max(q1,q2,q3)` — 4s is still fast from the user's perspective. Alternatively, optimize retrieve latency by eliminating Stage 1 domain routing (saves ~100ms per anchor D1 query across 73 anchors).

---

## P9 — PostToolUse stores too much low-signal noise [MEDIUM]

**What:** Every Edit, Write, and non-trivial Bash call goes through `memory_store_diff`. Despite filters, many low-value memories are stored. `social-media-attitudes` (27 injections), `data-management`, `data-storage` are the top domains hitting retrieval — but 90%+ of these are irrelevant to the current session. The `fileEditPenalty = 0.55` in retrieval suppresses some file-edit memories but they still surface.

**Evidence:** 3,234 episodic memories at avg access 2.5x. 1,742 episodic memories are cold (never accessed) = 53.8% of episodic type. Most of these are PostToolUse-generated.

**Impact:** The 'default' pool fills with noise, domain centroids get polluted with low-signal content, and retrieval quality degrades over time.

**Fix:** Raise the quality bar at storage time, not retrieval time. In `memory_store_diff`, before calling Llama for description, check: is this a code edit to a file in a real source directory? Is the semantic content likely useful? The Llama description step already filters some noise via the entropy check, but the check strips digits/punctuation only — it doesn't assess whether the remaining content is actually worth storing.

Consider making PostToolUse only fire on Write (new files) and meaningful Bash commands, not every Edit. Edits that are bug fixes or refactors in the same session are already captured by the stop hook's session extraction.

---

## P10 — cronRebuildBatch design creates inconsistency [MEDIUM]

**What:** At the start of each rebuild cycle (when `REBUILD_OFFSET` is null), the function deletes ALL domain anchors:

```ts
if (offsetRaw === null) {
  await env.DB.prepare('DELETE FROM domain_anchors').run();
}
```

It then rebuilds them incrementally over 4-5 nights (6,449 memories / ~1,500 per night). During this window, domain anchors are partially built — the first 1,500 memories have anchors, the rest don't. Stage 1 routing in retrieval uses these partial anchors, producing inconsistent results mid-cycle.

Additionally: re-embedding all memories nightly is wasteful when vectors are already in Vectorize. `getByIds` would eliminate embed API calls for the rebuild path.

**Fix:** Don't wipe and rebuild. Instead, only reclassify memories with `domain = 'general'` — these are the ones that failed initial classification and actually need work. This set stays small (currently 186 memories, grows only when classifyDomainWithLlama fails). Drop `REBUILD_OFFSET` pagination entirely. The whole function runs in seconds instead of days.

---

## P11 — Default pool has no project tagging [LOW]

**What:** 6,426 memories are in `project = 'default'` — all pre-May-29. Retrieval includes them as a shared pool across all project contexts. This is intentional (documented in the code), but has no way to indicate "this memory is specifically L'Oreal context" vs "this is a general preference that applies everywhere."

**Impact:** L'Oreal memories surface in Gaussian Memory sessions and vice versa. Domain routing was supposed to handle this but doesn't (see P3).

**Fix (optional, low priority):** A one-time migration that runs `classifyDomainWithLlama` on each 'default' memory and tries to infer a project tag from content. Store result in a new `inferred_project` column. Use this as a soft filter in retrieval (if `inferred_project` is set and doesn't match current project, score penalty rather than exclusion). This is optional because P3 Option B would largely solve the symptom.

---

## P12 — topic_key and revision_count are designed but unused [LOW]

**What:** `memory_store` supports `topic_key` for named upserts and tracks `revision_count`. Currently: `has_topic_key: 0, revised: 0` — neither feature has ever been used. The MCP tools expose topic_key but the hooks don't pass it, and there's no guidance on when to use it.

**Impact:** Growing redundancy in semantic memories as slightly updated facts create new entries instead of updating existing ones.

**Fix:** Document when to use topic_key in the tool description. For the hooks: the stop hook could use topic_key for known stable facts (career goals, working style preferences) so they update in place rather than accumulating versions.

---

## Summary by priority

| # | Problem | Priority | Effort |
|---|---------|----------|--------|
| P1 | Cron fails nightly (batchEmbed) | CRITICAL | 30min |
| P2 | distributionalScore is dead code | CRITICAL | 2hr |
| P3 | Domain routing as hard filter | HIGH | 2hr |
| P4 | No session summary memories | HIGH | 3hr |
| P5 | memory_judge pipeline dormant | HIGH | 2hr |
| P6 | Spreading activation no project filter | MEDIUM | 15min |
| P7 | Vectorize metadata loses project on merge | MEDIUM | 5min |
| P8 | Retrieve hook timeout too tight | MEDIUM | 5min |
| P9 | PostToolUse signal-to-noise | MEDIUM | 1hr |
| P10 | cronRebuildBatch wipes-and-rebuilds | MEDIUM | 1hr |
| P11 | Default pool no project tagging | LOW | 4hr |
| P12 | topic_key/revision unused | LOW | 1hr |

**Recommended fix order:**
~~P6, P7, P8~~ ✅ done May 30
P3 → P2    drop domain routing + wire sigma scoring (retrieval quality, do together)
P1 + P10   batchEmbed chunking + cronRebuildBatch to domain='general' only (do together)
P4         session summary memories (biggest UX win, the stated goal)
P5         memory_judge into cron pipeline
P9         PostToolUse noise reduction
FTS5/RRF   Week 3 — hybrid retrieval, biggest competitive gap
P11, P12   low priority, post-ship cleanup
