# Gaussian Memory

**AI memory that remembers what matters, not just what you told it to remember.**

Most memory systems store facts you explicitly give them. Gaussian Memory captures significance — things said in passing that turn out to matter — and surfaces them when they're relevant, weighted by how much you've reinforced them over time.

Built on Cloudflare Workers + D1 + Vectorize. BYOC: deploy to your own account, own your data, pay ~$5/month.

---

## Why it's different

Standard RAG retrieves the most semantically similar stored text. This system retrieves the most *confident* relevant memory — where confidence is a live measurement of how many times you've reinforced a belief, and how recently.

**Concrete example.** Ask "what's my connection to the Cloudflare PM?" without providing any context. A key-value memory store returns a name if you explicitly stored one. Gaussian Memory surfaces: *"encouraged you to start posting and blogging, considering reaching out about the project"* — the significance of the relationship, not just the label.

That happens because:
- High emotional salience at store time → tighter initial σ
- Multiple session references → σ sharpens further
- Query specificity matches memory confidence level → Bhattacharyya overlap is high
- Memory surfaces at the top

---

## How it works

Every memory is a Gaussian distribution (μ, Σ) over a 768-dimensional embedding space.

**σ (sigma)** is confidence. It starts at 0.5 when a memory is stored. It decreases (sharpens) each time the memory is retrieved and confirmed relevant. It increases (fades) nightly via exponential decay if not accessed. When σ exceeds 2.0, the memory is pruned.

**Retrieval is uncertainty-aware.** The primary scoring function uses Bhattacharyya distance — the distributional overlap between the query's uncertainty and each memory's σ. A specific query (short, technical, precise) has low σ and will only match memories with similarly low σ. A vague query has high σ and can surface uncertain memories. This means sharp confident beliefs surface for precise questions, while exploratory queries surface broader context.

**Merging is principled.** When two memories are semantically similar (cosine > 0.82), they merge via Kalman update rather than duplicating. The merged memory's uncertainty is the weighted combination of both, preserving information from each. This is why the system doesn't accumulate dozens of near-identical facts.

**Retrieval pipeline:**

```
Query → embed → Vectorize cosine search (topK × 4 candidates)
              + FTS5 keyword search (exact token match)
     → RRF fusion (combines vector + keyword ranks)
     → Bhattacharyya scoring (σ-weighted primary score)
     → Cluster cohesion bonus (entity graph co-retrieval)
     → σ hard gate (filter by query-adaptive ceiling)
     → σ tiebreaker (equal scores → prefer sharper memory)
     → Spreading activation (second Vectorize pass from top anchors)
     → Return all above threshold floor (not hard topK)
```

---

## Architecture

| Component | Role |
|---|---|
| Cloudflare Workers | MCP server (HTTP/JSON-RPC 2.0), all logic runs at edge |
| D1 (SQLite) | Memory store: text, σ diagonal, domain, type, access metadata, sigma history |
| Vectorize | Dense vector search over μ embeddings (768D BGE) |
| FTS5 | Full-text keyword search, fused with Vectorize via RRF |
| Workers AI | BGE embeddings, Llama 3.1 8B for extraction/synthesis, GLM-4.7-flash for quality gating |
| KV | Identity profile cache, hot tier (recently accessed memory IDs, 24h TTL) |
| Cron (6am UTC) | Decay, dedup, domain cleanup, entity queue processing |

**`src/gaussian.ts`**: Bhattacharyya distance, Kalman update, σ sharpen/decay, diagonal covariance.

---

## Quick start

**Requirements:** Node.js 18+, a Cloudflare account with Workers paid plan ($5/month).

```bash
git clone https://github.com/LohitJaga/gaussian-memory-worker
cd gaussian-memory-worker
npx gaussian-memory init
```

`init` will:
1. Create D1 database, Vectorize index, and KV namespace in your Cloudflare account
2. Patch `wrangler.toml` with your resource IDs
3. Run the D1 schema migrations
4. Deploy the worker
5. Generate and set an `AUTH_TOKEN` secret
6. Print your `GAUSSIAN_WORKER_URL` and `GAUSSIAN_AUTH_TOKEN`

Then add to `~/.zshrc`:
```bash
export GAUSSIAN_WORKER_URL="https://your-worker.workers.dev"
export GAUSSIAN_AUTH_TOKEN="your-token"
```

---

## Hook setup (Claude Code)

```bash
cp hooks/gaussian-*.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/gaussian-*.sh
```

Add to `~/.claude/settings.json`:
```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/gaussian-retrieve.sh", "statusMessage": "Recalling memories..." }] }],
    "PostToolUse":      [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/gaussian-posttool.sh", "timeout": 15, "async": true }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/gaussian-store.sh", "timeout": 30, "async": true }] }]
  }
}
```

For OpenCode, see `hooks/opencode-command-hooks.jsonc`.

---

## Cold start

New users can seed the system from existing notes before their first session:

```bash
npx gaussian-memory ingest my-context.md
```

The file can be any markdown with `##` section headers and `-` bullet points:

```markdown
## Working Style
- Prefer concise responses without emojis
- Pattern-first on LeetCode, attempt before hints

## Current Projects
- Building a probabilistic memory system on Cloudflare Workers

## Key Decisions
- Chose edge deployment over self-hosted for zero maintenance
```

Each bullet is stored as a memory. The section header provides context.

---

## MCP tools

| Tool | Description |
|---|---|
| `memory_store` | Store with explicit domain, type, topic_key for upsert |
| `memory_auto_store` | Auto-infer domain and type from content |
| `memory_retrieve` | Bhattacharyya-weighted retrieval. `synthesize=true` blends equidistant memories |
| `memory_extract_and_store` | LLM extraction from raw session log |
| `memory_capture_passive` | Parse structured notes (Key Learnings / Decisions / Problems Solved headers) |
| `memory_belief_drift` | Show σ trajectory for a memory or topic — how confidence changed over time |
| `memory_belief_drift_backfill` | Reconstruct σ history for existing memories from access metadata |
| `memory_judge` | LLM verdict on memory pairs: supersedes / conflicts_with / extends / compatible |
| `memory_timeline` | Chronological σ trajectory per domain |
| `memory_list` | List by domain |
| `memory_update` | Re-embed and update text |
| `memory_delete` | Delete by ID |
| `memory_bulk_delete` | Delete by text pattern (INSTR, no LIKE complexity limit) |
| `memory_decay` | Manual decay pass |
| `memory_stats` | Counts, σ distribution, domain breakdown, access heat |
| `memory_orphan_check` | Detect D1 entries missing Vectorize vectors. `repair=true` re-embeds. |
| `memory_rebuild_domains` | Re-classify all memory domains (batched, resumable) |
| `memory_build_entities` | Retroactive entity extraction for entity graph traversal |
| `identity_profile_get` | Fetch synthesized identity profile from KV |
| `identity_profile_set` | Push identity profile to KV for cross-device sync |

---

## Belief drift

Every memory has a σ history. Over time you can ask:

```
memory_belief_drift(query="ship July 1 BYOC")
```

```
● Ship Gaussian Memory by July 1 — BYOC, open source, blog post
σ: 0.500 → 0.190 (Δ+0.310) — strongly reinforced — confident belief
Trajectory (8 snapshots):
  2026-05-20  σ=0.500  [store]
  2026-05-25  σ=0.420  [synthetic]
  2026-06-01  σ=0.310  [sharpen]
  2026-06-04  σ=0.190  [sharpen]
```

This is what no key-value memory system can show: not just what you believe, but how confident you've become in it over time.

---

## Nightly cron

Runs at 6am UTC:
1. Prune junk (cold episodic < 80 chars, age > 30 days)
2. Decay all σ values (exponential, 1.5× rate for cold memories > 60 days)
3. Dedup recent memories (cosine > 0.90 within last 24h)
4. Dedup cold memories (cosine > 0.93, oldest-first)
5. Cleanup singleton domains
6. Refresh stale domain summaries
7. Process pending entity queue (50 memories/run)
8. Synthesize identity profile from semantic memories

---

## Auth

All endpoints require a bearer token. Set via:

```bash
wrangler secret put AUTH_TOKEN
# generate with: openssl rand -hex 32
```

Requests without a valid token return 401. The worker returns 500 with setup instructions if `AUTH_TOKEN` is not configured.

---

## File structure

```
src/index.ts       MCP server, tool handlers, retrieval pipeline
src/gaussian.ts    Bhattacharyya, Kalman merge, σ decay/sharpen
bin/gaussian-memory.js  CLI: init + ingest
hooks/             Claude Code + OpenCode hook scripts
schema.sql         D1 schema (memories, domain_anchors, memory_relations,
                   memory_sigma_history, entity_nodes, memory_entities)
wrangler.example.toml  Template — copy and fill in your resource IDs
```

---

## Status

Single-user BYOC working end-to-end. Multi-user (Durable Objects per-user isolation) is post-ship.

Ship target: July 1 2026.
