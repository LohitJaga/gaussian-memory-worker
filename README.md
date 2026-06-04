# Gaussian Memory

Persistent memory for AI coding assistants. Works across sessions, devices, and projects without any manual setup once installed.

Built on Cloudflare Workers. You deploy it to your own account, own your data, and pay Cloudflare directly (~$0/month on the free tier for most users).

---

## What it does

Every session, the system automatically captures what you worked on, what decisions you made, and what's still open. Next session it injects the relevant context before you even ask.

The difference from other memory systems is that memories have a **confidence level (σ)** that changes over time. Beliefs you keep reinforcing become sharp and surface reliably. Things you haven't thought about in weeks fade out. Retrieval adapts to how specific your question is — a precise technical query only surfaces memories you've actively reinforced; a broad exploratory question surfaces a wider range.

---

## Quick start

**Requirements:** Node.js 18+, a Cloudflare account.

```bash
git clone https://github.com/LohitJaga/gaussian-memory-worker
cd gaussian-memory-worker
npx gaussian-memory init
```

`init` handles everything:
- Creates D1 database, Vectorize index, and KV namespace in your Cloudflare account
- Patches `wrangler.toml` with your resource IDs
- Runs D1 schema migrations
- Deploys the worker
- Generates and sets an `AUTH_TOKEN` secret
- Writes `~/.gaussian-memory-env` with your worker URL and token (chmod 600)
- Auto-installs and configures Claude Code hooks if `~/.claude` exists

One step after it finishes:

```bash
# macOS / Linux
echo 'source ~/.gaussian-memory-env' >> ~/.zshrc && source ~/.gaussian-memory-env

# Windows (WSL) — same as above inside your WSL shell
# Windows (native) — add GAUSSIAN_WORKER_URL and GAUSSIAN_AUTH_TOKEN to System Environment Variables
```

Restart Claude Code and it's live.

---

## Cloudflare plan

The **free tier works** for most users. Workers AI has a 10,000 neuron/day limit on the free plan which is sufficient for normal daily usage (a few sessions, storing 5–15 memories, retrievals). The paid Workers plan ($5/month) is only needed once your corpus grows beyond ~2,000 memories or you run heavy batch maintenance jobs.

---

## Seed your memory (recommended)

New users can start with context rather than building it from scratch over weeks:

```bash
npx gaussian-memory ingest my-context.md
```

Create a markdown file with `##` section headers and `-` bullet points:

```markdown
## About me
- Software engineer, 3 years Python and TypeScript
- Currently building a SaaS app, focusing on the auth layer

## Working preferences
- Concise responses, no unnecessary explanation
- Show file:line references when pointing to code

## Current projects
- Rewriting auth middleware — moving from JWT to session tokens
- Exploring Cloudflare Workers for lower latency

## Key decisions
- Chose PostgreSQL over MongoDB for relational data model
- Using Tailwind for styling, no component library
```

Each bullet is stored as a memory. The section header provides context. Run it once and the system starts knowing you.

---

## Hook setup

### Claude Code (macOS / Linux)
Configured automatically by `npx gaussian-memory init`. Nothing to do.

Manual setup if needed:
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

### Claude Code (Windows)
Use WSL. Run `npx gaussian-memory init` inside WSL and add the env vars to your WSL shell profile.

### OpenCode
Copy the hook config and scripts:
```bash
mkdir -p ~/.config/opencode/hooks
cp hooks/gaussian-*.sh ~/.config/opencode/hooks/
chmod +x ~/.config/opencode/hooks/gaussian-*.sh
cp hooks/opencode-command-hooks.jsonc ~/.config/opencode/command-hooks.jsonc
```

Add env vars to your shell profile as above.

### PiDev and other MCP-compatible editors
Add the worker as an MCP server. After running `init`, your worker URL and token are in `~/.gaussian-memory-env`. You can call MCP tools directly (`memory_retrieve`, `memory_store`, etc.) even without hook-based automatic capture.

---

## How it works

### The σ model

Every memory stores a confidence value σ ∈ [0, ∞):
- **Stored:** σ = 0.5 (uncertain, newly observed)
- **Retrieved:** σ decreases (sharpens) — you confirmed this was relevant
- **Ignored:** σ increases nightly via exponential decay
- **Pruned:** σ > 2.0 — decayed past usefulness

### Retrieval

The primary scoring function uses **Bhattacharyya distance** — a measure of distributional overlap between the query's uncertainty and each memory's σ. A precise technical query (short, specific) has low σ and matches memories with similarly low σ. A vague exploratory question has high σ and allows uncertain memories through. The system retrieves differently depending on what kind of answer you're looking for.

After Bhattacharyya scoring:
- **Cluster cohesion bonus:** memories co-retrieved with shared entity links score higher as a group
- **σ hard gate:** memories above the query-adaptive σ ceiling are filtered out
- **σ tiebreaker:** equal-scoring memories resolve in favor of the sharper one
- **Threshold retrieval:** all memories above a score floor are returned (not a fixed top-k)

### Merging

When two memories are semantically similar (cosine > 0.82), they merge via **Kalman update** rather than duplicating. The merged uncertainty is the optimal combination of both. This is why the system doesn't accumulate dozens of near-identical facts over time.

### Nightly cron (6am UTC)

1. Prune cold low-quality memories (episodic, < 80 chars, age > 30 days, never accessed)
2. Decay all σ values (1.5× rate for memories cold > 60 days)
3. Deduplicate recent memories (cosine > 0.90)
4. Deduplicate cold memories (cosine > 0.93, oldest-first)
5. Collapse singleton domains
6. Refresh stale domain summaries
7. Process entity extraction queue (50/run)
8. Synthesize identity profile from semantic memories → push to KV

---

## Architecture

| Component | Role |
|---|---|
| Cloudflare Workers | MCP server (HTTP/JSON-RPC 2.0), all logic runs at edge |
| D1 (SQLite) | Memory store: text, σ diagonal, domain, type, access metadata, σ history |
| Vectorize | Dense vector search (768D BGE-base-en-v1.5) |
| FTS5 virtual table | Full-text keyword search, fused with Vectorize via RRF (k=60) |
| Workers AI | BGE embeddings, Llama 3.1 8B for extraction/synthesis, GLM-4.7-flash for quality gating |
| KV | Identity profile cache, hot tier (recently accessed memory IDs, 24h TTL) |
| Cron | Nightly maintenance — decay, dedup, entity processing, identity synthesis |

---

## MCP tools

| Tool | Description |
|---|---|
| `memory_store` | Store with explicit domain, type, and optional `topic_key` for upsert |
| `memory_auto_store` | Store with automatic domain and type inference |
| `memory_retrieve` | Bhattacharyya-weighted retrieval. `synthesize=true` blends equidistant memories |
| `memory_extract_and_store` | LLM-based fact extraction from a raw session log |
| `memory_capture_passive` | Parse structured notes with Key Learnings / Decisions / Problems Solved headers |
| `memory_store_diff` | Store semantic meaning of a code diff or command output |
| `memory_update` | Re-embed and update an existing memory |
| `memory_delete` | Delete by ID |
| `memory_bulk_delete` | Delete all memories matching a text pattern |
| `memory_list` | List all memories, optionally filtered by domain |
| `memory_decay` | Manual decay pass |
| `memory_stats` | Total count, σ distribution, domain breakdown, access heat |
| `memory_orphan_check` | Detect D1 memories missing Vectorize vectors. `repair=true` re-embeds. |
| `memory_rebuild_domains` | Re-classify all memory domains (batched, resumable, 2000/run) |
| `memory_cleanup_singletons` | Merge domains with fewer than N memories into nearest anchor |
| `memory_retag_projects` | LLM-based project re-tagging for the default memory pool |
| `memory_build_entities` | Retroactive entity extraction for entity graph traversal |
| `memory_judge` | LLM verdict on two memories: supersedes / conflicts_with / extends / compatible |
| `memory_timeline` | Chronological σ trajectory per domain |
| `memory_belief_drift` | Show how confidence in a memory has changed over time |
| `memory_belief_drift_backfill` | Reconstruct σ history for existing memories from access metadata |
| `identity_profile_get` | Fetch synthesized identity profile from KV |
| `identity_profile_set` | Push identity profile to KV for cross-device sync |

---

## Belief drift

Every memory logs σ snapshots over time. You can query how your confidence in a belief evolved:

```
memory_belief_drift(query="architecture decision")
```

```
● Chose edge deployment — zero maintenance, lower latency
Domain: file-management · Age: 45d · Accessed: 12x
σ: 0.500 → 0.190 (Δ+0.310) — strongly reinforced — confident belief
Trajectory (5 snapshots):
  2026-05-01  σ=0.500  [store]
  2026-05-10  σ=0.390  [synthetic]
  2026-05-20  σ=0.280  [sharpen]
  2026-06-04  σ=0.190  [sharpen]
```

---

## File structure

```
src/index.ts              MCP server, tool handlers, retrieval pipeline
src/gaussian.ts           Bhattacharyya, Kalman merge, σ decay/sharpen math
bin/gaussian-memory.js    CLI — init and ingest commands
hooks/
  gaussian-retrieve.sh    UserPromptSubmit hook — retrieves context before each prompt
  gaussian-posttool.sh    PostToolUse hook — stores semantic meaning of code changes
  gaussian-store.sh       Stop hook — extracts facts from session, syncs CLAUDE.md
  opencode-command-hooks.jsonc  OpenCode configuration template
  README.md               Hook setup instructions
schema.sql                D1 schema
wrangler.example.toml     Template for manual resource setup
```

---

## Status

Single-user BYOC, working end-to-end. Ship target: July 1 2026.

Multi-user (Durable Objects per-user isolation) is post-ship.
