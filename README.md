# Gaussian Memory

Persistent memory for AI coding assistants. Works across sessions, devices, and projects without any manual setup once installed.

Built on Cloudflare Workers. You deploy it to your own account, own your data, and pay Cloudflare directly (~$0/month on the free tier for most users).

## What it does

The system automatically captures what you worked on, what decisions you made, and what's still open, then injects the relevant context at the start of each session before you ask.

The difference from other memory systems is that memories have a **confidence level (σ)** that changes over time. Beliefs you keep reinforcing become sharp and surface reliably. Things you haven't touched in weeks fade out. A precise technical query only matches memories you've actively reinforced; a vague exploratory question casts wider.

## Quick start

**Requirements:** Node.js 18+, a [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works).

**Step 0 — authenticate with Cloudflare (one time):**
```bash
npm install -g wrangler
wrangler login
```

**Step 1 — deploy:**
```bash
git clone https://github.com/LohitJaga/gaussian-memory-worker
cd gaussian-memory-worker
npm install
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

That's it. `init` auto-appends `source ~/.gaussian-memory-env` to your `~/.zshrc` or `~/.bashrc`, writes the auth token to `~/.claude/mcp.json`, and prompts before installing hook scripts.

Reload your shell (`source ~/.zshrc` or open a new terminal), then restart Claude Code and it's live.

On Windows without WSL, add `GAUSSIAN_WORKER_URL` and `GAUSSIAN_AUTH_TOKEN` as System Environment Variables instead.

## Cloudflare plan

Workers AI has a 10,000 neuron/day limit on the free plan. Two sessions/day with the nightly cron runs around 2,000–2,500 neurons. The 10,000/day free limit is not a concern for normal use.

The one exception is `memory_rebuild_domains`, which re-classifies every memory in your corpus via Llama 3.3 70B. At ~15 neurons per memory, a 500-memory corpus costs ~7,500 neurons in a single run. Run it off-peak or upgrade to paid ($5/month) before triggering it on a large corpus.

## Seed your memory (recommended)

New users can start with context rather than building it from scratch over weeks:

```bash
npx gaussian-memory ingest my-context.md
```

Point it at any markdown file — your existing CLAUDE.md, README, notes, or a purpose-built context file. The parser handles real-world formatting: YAML frontmatter, nested bullets, ordered lists, checkboxes, code blocks (skipped), and plain paragraphs under headers.

Example format (but most markdown works):

```markdown
## About me
- Software engineer, 3 years Python and TypeScript
- Currently building a SaaS app, focusing on the auth layer

## Working preferences
- Concise responses, no unnecessary explanation
- Show file:line references when pointing to code

## Current projects
- Rewriting auth middleware, moving from JWT to session tokens
- Exploring Cloudflare Workers for lower latency

## Key decisions
- Chose PostgreSQL over MongoDB for relational data model
- Using Tailwind for styling, no component library
```

Each bullet or paragraph is stored as a memory. The section header is prepended as context.

## Hook setup

### Claude Code
Configured automatically by `npx gaussian-memory init`. Nothing to do.

Manual setup if needed: copy the hook scripts and add them to `~/.claude/settings.json`:
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
Configured automatically by `npx gaussian-memory init` if `~/opencode.json` is detected. Nothing to do.

Manual setup: add to `~/opencode.json`:

```json
{
  "plugin": ["~/.opencode/gaussian-memory.mjs"],
  "mcp": {
    "gaussian-memory": {
      "type": "remote",
      "url": "https://your-worker.workers.dev",
      "headers": {
        "Authorization": "Bearer your-token"
      }
    }
  }
}
```

Then copy the plugin file:
```bash
cp hooks/opencode-gaussian-memory.mjs ~/.opencode/gaussian-memory.mjs
```

**What you get:**
- **MCP tools** — all 23 memory tools available natively in the model's tool list. The model calls `memory_retrieve`, `memory_store`, etc. without any prompting.
- **Auto-store** — every user and assistant message >80 chars is stored automatically via plugin hooks (`chat.input`, `chat.message`).
- **Session-end extraction** — `session.idle` and `session.compacted` hooks trigger `memory_extract_and_store` on the full session transcript.
- **Cross-editor memory** — Claude Code and OpenCode share the same D1/Vectorize backend. Context stored in one editor surfaces in the other.

### Cursor
Configured automatically by `npx gaussian-memory init` if `~/.cursor` is detected. Nothing to do.

Manual setup: create or edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "gaussian-memory": {
      "type": "http",
      "url": "https://your-worker.workers.dev",
      "headers": {
        "Authorization": "Bearer your-token"
      }
    }
  }
}
```

For auto-storage on session end, create `~/.cursor/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "sessionEnd": [
      {
        "type": "command",
        "command": "bash ~/.cursor/hooks/gaussian-store.sh",
        "timeout": 30
      }
    ]
  }
}
```

Then copy the hook script:
```bash
cp hooks/cursor-gaussian-store.sh ~/.cursor/hooks/gaussian-store.sh
chmod +x ~/.cursor/hooks/gaussian-store.sh
```

**What you get:**
- **MCP tools** — all 23 memory tools available in agent mode. Call `memory_retrieve` or `memory_store` directly.
- **Auto-store** — `sessionEnd` hook extracts and stores memories when you close a conversation.
- **Auto-inject** — not available yet. Cursor's `sessionStart` hook supports an `additional_context` output field that would enable this, but injection is currently broken upstream ([forum thread](https://forum.cursor.com/t/sessionstart-hook-additional-context-is-never-injected-into-agents-initial-system-context/158452)). When they fix it, Cursor will have full parity with Claude Code.

### Zed

`init` auto-configures Zed if `~/.config/zed/` exists. It merges a `context_servers` entry into `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "gaussian-memory": {
      "url": "https://your-worker.workers.dev",
      "headers": { "Authorization": "Bearer your-token" }
    }
  }
}
```

Restart Zed and the memory tools are available in the assistant.

### Other MCP-compatible editors

Any editor that supports remote HTTP MCP servers should work for tool calls: Windsurf, Continue.dev, VS Code (MCP extension), etc. The worker is a plain JSON-RPC 2.0 HTTP endpoint — no SSE or OAuth required.

`init` also writes a universal `~/.mcp.json` using the emerging MCP standard format. Some editors pick this up automatically; for others, copy it into your editor's own MCP config:

```json
{
  "mcpServers": {
    "gaussian-memory": {
      "type": "http",
      "url": "https://your-worker.workers.dev",
      "headers": { "Authorization": "Bearer your-token" }
    }
  }
}
```

`init` also prints this snippet at the end of setup with your real URL and token filled in.

Auto-inject and auto-store depend on each editor's hook system and aren't verified beyond Claude Code, OpenCode, and Cursor. If you get it working in another editor, PRs welcome.

## Backup

Export your D1 memory store to a local SQL file at any time:

```bash
npx gaussian-memory backup
```

Writes a timestamped `.sql` file in the current directory. Run before migrations or destructive cron operations.

## Known gaps

**Cursor: auto-inject not working.** Cursor's `sessionStart` hook supports an `additional_context` return field designed for exactly this — inject retrieved memories before the first message. It's broken in the current Cursor release ([forum thread](https://forum.cursor.com/t/sessionstart-hook-additional-context-is-never-injected-into-agents-initial-system-context/158452)). Until it's fixed, you can call `memory_retrieve` manually at the start of a session, or rely on the model to do it proactively since the tools are registered.

**OpenCode: tool output capture not working.** The plugin implements `tool.execute.after` but it's never triggered in OpenCode v1.16.2 (issue [#25918](https://github.com/anomalyco/opencode/issues/25918) — declared but not wired up in the runtime). Claude Code's `PostToolUse` hook captures every file edit and bash command as a semantic diff; OpenCode can't do this yet. Conversation content is still captured via `chat.input`/`chat.message` hooks.

**pi.dev: not supported.** Pi explicitly has no built-in MCP support and requires a custom TypeScript extension. No config to provide yet.

**Personal CLI tools: not applicable.** Gaussian Memory is designed for AI agent workflows. Automatic capture only fires when an MCP-connected agent (Claude Code, etc.) is running your session. Work done directly in the terminal without an agent (shell scripts, CLI tools, manual commands) won't be captured unless you call the MCP tools explicitly.

## How it works

### The σ model

Every memory stores a confidence value σ ∈ [0, ∞):
- **Stored:** σ = 0.5 (uncertain, newly observed)
- **Retrieved:** σ decreases (sharpens): you confirmed this was relevant
- **Ignored:** σ increases nightly via exponential decay
- **Pruned:** σ > 2.0, decayed past usefulness

### Retrieval

Base score is a weighted combination of **cosine similarity** (0.50), **BM25 keyword match** (0.15), **recency** (0.22), and **access frequency** (0.13), normalized within each retrieval batch. BM25 is a first-class signal — a memory that keyword-matches precisely surfaces even with a mediocre vector score. This base is then modulated by a **Bhattacharyya multiplier** — the key differentiator.

The Bhattacharyya multiplier compares the query's confidence against each memory's σ. A precise technical query (low σ) amplifies memories with similarly low σ — sharp, well-reinforced facts. A vague exploratory query (high σ) allows uncertain memories through. This is what makes retrieval context-sensitive rather than purely semantic.

After scoring:
- **Temporal validity filter:** memories with `valid_to` set (superseded by a newer version) are excluded before scoring — expired facts never surface
- **Spreading activation:** top-3 hits become anchors; neighboring memories in the entity graph score a secondary boost
- **Cluster cohesion bonus:** memories co-retrieved with shared entity links score higher as a group
- **σ tiebreaker:** equal-scoring memories resolve in favor of the sharper one (lower σ = more reinforced)
- **Threshold retrieval:** all memories above a score floor are returned, not a fixed top-k

### Merging

When two memories are semantically similar (cosine > 0.82), they merge via **Kalman update** rather than duplicating. The merged uncertainty is the optimal combination of both. This is why the system doesn't accumulate dozens of near-identical facts over time.

### Nightly cron (6am UTC)

1. Prune cold low-quality memories (episodic, < 80 chars, age > 30 days, never accessed)
2. Consolidate cold memories (σ > 1.5, age > 90 days) — compress via Llama to R2, delete from D1/Vectorize to reclaim space
3. Decay all σ values — FSRS-inspired stability weighting: frequently accessed memories resist forgetting (`stability = 1 + log(access_count + 1)`, effective decay rate `0.02 / stability`)
4. Deduplicate recent memories (cosine > 0.90)
5. Deduplicate cold memories (cosine > 0.93, oldest-first)
6. Collapse singleton domains
7. Refresh stale domain summaries
8. Process entity extraction queue (50/run)
9. Synthesize identity profile from semantic memories → push to KV

## Architecture

| Component | Role |
|---|---|
| Cloudflare Workers | MCP server (HTTP/JSON-RPC 2.0), all logic runs at edge |
| D1 (SQLite) | Memory store: text, σ diagonal, domain, type, access metadata, σ history |
| Vectorize | Dense vector search (768D BGE-base-en-v1.5) |
| FTS5 virtual table | Full-text keyword search, fused with Vectorize via RRF (k=60) |
| Workers AI | BGE embeddings, Llama 3.1 8B for extraction/synthesis, Llama 3.3 70B for contradiction judgment |
| KV | Identity profile cache, hot tier (recently accessed memory IDs, 24h TTL) |
| R2 | Cold storage for consolidated memories (σ > 1.5, age > 90 days) |
| Cron | Nightly maintenance: consolidation, decay, dedup, entity processing, identity synthesis |

## MCP tools

These tools are called by the AI agent, not by you directly. In Claude Code (or any MCP-connected agent), you ask the agent to store or retrieve something and it calls the tool on your behalf. You can also trigger them explicitly: "retrieve memories about X" or "store that I decided Y", and the agent will call the appropriate tool. For scripted or headless use, the worker is a plain JSON-RPC 2.0 HTTP endpoint you can hit with curl.

| Tool | Description |
|---|---|
| `memory_store` | Store with explicit domain, type, and optional `topic_key` for upsert |
| `memory_auto_store` | Store with automatic domain and type inference |
| `memory_retrieve` | Hybrid retrieval (cosine + BM25 + recency + access_freq) with Bhattacharyya multiplier. `synthesize=true` blends equidistant memories |
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
src/tools.ts              All 23 tool handlers
src/retrieval.ts          Hybrid retrieval scoring, spreading activation, entity graph, temporal pipeline
src/storage.ts            Store, merge, dedup, entity extraction queue
src/gaussian.ts           Bhattacharyya, Kalman merge, σ decay/sharpen math
src/cron.ts               Nightly maintenance jobs
bin/gaussian-memory.js    CLI: init, ingest, and backup commands
hooks/
  gaussian-retrieve.sh         UserPromptSubmit hook: retrieves context before each prompt
  gaussian-posttool.sh         PostToolUse hook: stores semantic meaning of code changes
  gaussian-store.sh            Stop hook: extracts facts from session, syncs CLAUDE.md
  opencode-mcp-config.json     OpenCode MCP config template (~/.config/opencode/opencode.json)
  README.md                    Hook setup instructions
scripts/
  integration-test.sh          Live smoke test: 22 tool calls against deployed worker
schema.sql                D1 schema
wrangler.example.toml     Template for manual resource setup
```

## Status

Single-user BYOC, working end-to-end. Ship target: July 1 2026.

Multi-user (Durable Objects per-user isolation) is post-ship.
