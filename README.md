# Gaussian Memory

A probabilistic AI memory system built on Cloudflare Workers. Stores memories as Gaussian distributions (μ, Σ) rather than static embeddings — memories sharpen with use, fade without it, and merge when semantically overlapping.

Built and maintained by [Lohit Jagarlamudi](mailto:lohitjagarlamudi@gmail.com).

---

## What it does

Most AI memory systems retrieve facts. This one reconstructs — every recall is a collapse of a probability distribution shaped by time, context, and interference. The goal is something that knows you well enough to be useful across sessions, devices, and contexts without any manual setup.

**Key behaviors:**
- New memories start uncertain (high σ). Frequently accessed memories sharpen (low σ). Unused memories fade and eventually prune.
- Semantically similar memories within the same domain merge via Kalman update rather than duplicating.
- Contradictory memories get flagged and periodically surfaced to prevent confirmation bias.
- Cross-session identity reconstruction: a nightly job synthesizes semantic memories into an identity profile stored in KV — any device picks it up automatically.

---

## Architecture

| Component | Role |
|---|---|
| Cloudflare Workers | MCP server (HTTP/JSON-RPC 2.0) |
| D1 (SQLite) | Memory store: text, σ diagonal, domain, type, access metadata |
| Vectorize | Coarse cosine search over μ embeddings |
| Workers AI (BGE) | Text → normalized 768D embeddings |
| Workers AI (Llama 3.1 8B) | Session fact extraction, identity synthesis, soft-collapse blending |
| KV | Identity profile cache, rebuild state |
| Cron (6am UTC) | Daily decay + entropy pruning + identity synthesis |

**Gaussian math** (`src/gaussian.ts`): Bhattacharyya distance for merge decisions, Kalman update for blending, diagonal covariance for efficiency, domain-informed initial σ via emotional salience.

---

## Memory types

- **Episodic** — specific events and sessions
- **Semantic** — extracted beliefs, values, personality traits
- **Procedural** — behavioral preferences and working style

All three use the same Gaussian encoding. Domain metadata tags prevent cross-domain interference.

---

## MCP tools

| Tool | Description |
|---|---|
| `memory_store` | Store with explicit domain/type |
| `memory_auto_store` | Auto-infer domain and type from content |
| `memory_retrieve` | Semantic retrieval with spreading activation. `synthesize=true` blends equidistant memories |
| `memory_extract_and_store` | LLM-based fact extraction from session logs |
| `memory_list` | List by domain |
| `memory_update` | Re-embed and update text |
| `memory_delete` | Delete by ID |
| `memory_bulk_delete` | Delete by SQL LIKE pattern |
| `memory_decay` | Manual decay pass |
| `memory_rebuild_domains` | Re-classify all memory domains (batched, resumable) |
| `memory_stats` | Health: counts, σ distribution, domain breakdown |
| `identity_profile_get` | Fetch synthesized identity profile from KV |
| `identity_profile_set` | Push identity profile to KV |

---

## Claude Code integration

The system runs automatically via hooks — no manual calls needed.

**On every prompt** (`UserPromptSubmit`): three parallel queries retrieve contextual memories, injected as `additionalContext`. Identity domain filtered (handled by CLAUDE.md). Score threshold ≥0.95.

**On session end** (`Stop`): session log filtered (>20 char lines), sent to `memory_extract_and_store`. Current CLAUDE.md pushed to KV.

**On new device**: `UserPromptSubmit` hook checks if CLAUDE.md exists. If missing, fetches from KV and writes it before the first response.

---

## Stack

```
src/index.ts     — MCP server, tool handlers, retrieval pipeline
src/gaussian.ts  — Bhattacharyya, Kalman merge, σ decay/sharpen math
wrangler.toml    — Worker config, D1/Vectorize/KV bindings, cron
schema.sql       — D1 schema
TODO.md          — Pending work
```

---

## Status

Individual system working end-to-end. Multi-user (Durable Objects per user, auth, onboarding UI) is the next milestone.
