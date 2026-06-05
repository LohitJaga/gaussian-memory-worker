# Gaussian Memory

Persistent memory for AI coding assistants. Works across sessions, devices, and projects without any manual setup once installed.

Built on Cloudflare Workers. You deploy it to your own account, own your data, and pay Cloudflare directly (~$0/month on the free tier for most users).

## What it does

The system automatically captures what you worked on, what decisions you made, and what's still open — then injects the relevant context at the start of each session before you ask.

The difference from other memory systems is that memories have a **confidence level (σ)** that changes over time. Beliefs you keep reinforcing become sharp and surface reliably. Things you haven't touched in weeks fade out. A precise technical query only matches memories you've actively reinforced; a vague exploratory question casts wider.

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

One step after it finishes — add to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.):

```bash
source ~/.gaussian-memory-env
```

Then reload your shell (`source ~/.zshrc` or open a new terminal). On Windows without WSL, add `GAUSSIAN_WORKER_URL` and `GAUSSIAN_AUTH_TOKEN` as System Environment Variables instead.

Restart Claude Code and it's live.

## Cloudflare plan

Workers AI has a 10,000 neuron/day limit on the free plan. Normal use — two sessions, ~20 prompts each, plus the nightly cron — runs around 2,000–2,500 neurons/day. The free tier is fine for most users.

The one exception is `memory_rebuild_domains`, which re-classifies every memory in your corpus via Llama 3.3 70B. At ~15 neurons per memory, a 500-memory corpus costs ~7,500 neurons in a single run. Run it off-peak or upgrade to paid ($5/month) before triggering it on a large corpus.

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

Each bullet is stored as a memory. The section header provides context.

## Hook setup

### Claude Code
Configured automatically by `npx gaussian-memory init`. Nothing to do.

Manual setup if needed — copy the hook scripts and add them to `~/.claude/settings.json`:
```bash
cp hooks/gaussian-*.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/gaussian-*.sh
```

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/gaussian-retrieve.sh", "statusMessage": "Recalling memories..." }] }],
    "PostToolUse":      [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/gaussian-posttool.sh", "timeout": 15, "async": true }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/gaussian-store.sh", "timeout": 30, "async": true }] }]
  }
}
```

> **Windows:** Use WSL. Run `npx gaussian-memory init` inside the WSL shell and add env vars to your WSL shell profile.

### OpenCode
OpenCode has no shell hook system — it integrates via MCP. Add to `~/.config/opencode/opencode.json` (create it if it doesn't exist):

```json
{
  "mcp": {
    "gaussian-memory": {
      "type": "remote",
      "url": "{env:GAUSSIAN_WORKER_URL}",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer {env:GAUSSIAN_AUTH_TOKEN}"
      }
    }
  }
}
```

OpenCode uses `{env:VAR}` syntax — both vars must be in your shell environment before starting OpenCode. A copy of this config is at `hooks/opencode-mcp-config.json`.

### Other MCP-compatible editors
Any editor that supports remote MCP servers works with Gaussian Memory — Cursor, Zed, Continue.dev, etc. The worker is a plain JSON-RPC 2.0 HTTP endpoint. Point the MCP config at `$GAUSSIAN_WORKER_URL` with `Authorization: Bearer $GAUSSIAN_AUTH_TOKEN`. No SSE or OAuth required.

## Known gaps

**OpenCode — auto-capture not implemented.** The MCP config above gives tool access but no automatic memory capture. OpenCode hooks are TypeScript plugins (not shell commands), so wiring up the retrieve/store/posttool lifecycle requires writing a small JS plugin. Contributions welcome.

**pi.dev — not supported.** Pi explicitly has no built-in MCP support and requires a custom TypeScript extension. No config to provide yet.

## How it works

### The σ model

Every memory stores a confidence value σ ∈ [0, ∞):
- **Stored:** σ = 0.5 (uncertain, newly observed)
- **Retrieved:** σ decreases (sharpens) — you confirmed this was relevant
- **Ignored:** σ increases nightly via exponential decay
- **Pruned:** σ > 2.0 — decayed past usefulness

### Retrieval

The primary scoring function uses **Bhattacharyya distance** — a measure of distributional overlap between the query's uncertainty and each memory's σ. A precise technical query (short, specific) has low σ and matches memories with similarly low σ. A vague exploratory question has high σ and allows uncertain memories through.

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

## File structure

```
src/index.ts              MCP server, routing, cron handler
src/tools.ts              All 22 tool handlers
src/retrieval.ts          Bhattacharyya retrieval, entity graph, temporal pipeline
src/storage.ts            Store, merge, dedup, entity extraction queue
src/gaussian.ts           Bhattacharyya, Kalman merge, σ decay/sharpen math
src/cron.ts               Nightly maintenance jobs
bin/gaussian-memory.js    CLI — init and ingest commands
hooks/
  gaussian-retrieve.sh         UserPromptSubmit hook — retrieves context before each prompt
  gaussian-posttool.sh         PostToolUse hook — stores semantic meaning of code changes
  gaussian-store.sh            Stop hook — extracts facts from session, syncs CLAUDE.md
  opencode-mcp-config.json     OpenCode MCP config template (~/.config/opencode/opencode.json)
  README.md                    Hook setup instructions
scripts/
  integration-test.sh          Live smoke test — 22 tool calls against deployed worker
schema.sql                D1 schema
wrangler.example.toml     Template for manual resource setup
```

## Status

Single-user BYOC, working end-to-end. Ship target: July 1 2026.

Multi-user (Durable Objects per-user isolation) is post-ship.
