# Gaussian Memory

Persistent memory for AI coding assistants. Works across sessions, devices, and projects — without any manual setup once installed.

Built on Cloudflare Workers. You deploy it to your own account and own your data.

---

## What it does

Every session, the system automatically captures what you worked on, what decisions you made, and what's still open. Next session it injects the relevant context before you even ask. Ask "where did we leave off?" and it reconstructs the prior session from stored memories.

The difference from other memory systems: memories have a confidence level (σ) that changes over time. Beliefs you keep reinforcing become sharp and surface reliably. Things you haven't thought about in weeks fade. The retrieval adapts to how specific your question is — precise technical queries only surface memories you've actively reinforced; broad questions allow uncertain memories through.

---

## Quick start

**Prerequisites:** Node.js 18+, a Cloudflare account (free tier works for most users).

```bash
git clone https://github.com/LohitJaga/gaussian-memory-worker
cd gaussian-memory-worker
npx gaussian-memory init
```

That's it. `init` creates all the Cloudflare resources, deploys the worker, generates an auth token, installs Claude Code hooks, and writes your env vars to `~/.gaussian-memory-env`. One step left after it finishes:

```bash
echo 'source ~/.gaussian-memory-env' >> ~/.zshrc
source ~/.gaussian-memory-env
```

Then restart Claude Code and the system is live.

---

## Seed your memory (optional but recommended)

New users can start with context rather than building it from scratch:

```bash
npx gaussian-memory ingest my-context.md
```

Write a markdown file with `##` sections and `-` bullet points:

```markdown
## About me
- Software engineer, 3 years experience, mostly Python and TypeScript
- Currently building a side project using Cloudflare Workers

## Working preferences  
- Concise responses, no unnecessary explanation
- Show file:line references when pointing to code

## Current projects
- Rewriting the auth layer for my SaaS app
- Exploring edge deployment for lower latency
```

Each bullet becomes a memory. The system starts knowing who you are instead of learning from scratch.

---

## How it works

Memories are stored as vectors with an associated confidence value σ ∈ [0, 1]. At storage time σ = 0.5. Each time a memory is retrieved and confirmed relevant, σ decreases (sharpens). Each night a decay pass increases σ for memories that haven't been accessed (fading). When σ exceeds 2.0, the memory is pruned.

Retrieval uses Bhattacharyya distance — a distributional similarity measure — to match queries against memories. A specific, precise query (short, technical) has low σ and will only match memories with similarly low σ. A vague question has high σ and can surface less certain memories. This means the system retrieves differently depending on what kind of answer you're looking for.

When two memories are semantically similar, they merge via Kalman update rather than duplicating. The merged uncertainty is the optimal combination of both, preserving information from each version.

---

## Architecture

| Component | Role |
|---|---|
| Cloudflare Workers | MCP server (HTTP/JSON-RPC 2.0) |
| D1 (SQLite) | Memory store with σ values, access metadata, and σ history |
| Vectorize | Dense vector search (768D BGE embeddings) |
| FTS5 | Keyword search, fused with vector results via RRF |
| Workers AI | Embeddings, LLM-based fact extraction, domain classification |
| KV | Identity profile cache, hot tier (recently accessed IDs) |
| Cron (6am UTC) | Nightly decay, dedup, domain cleanup, entity processing |

---

## Cloudflare plan

The free tier works for normal daily use. The paid plan ($5/month) removes Workers AI rate limits and is recommended once your memory corpus exceeds ~2,000 entries or you want reliable nightly maintenance jobs.

---

## Hook setup (other editors)

**Claude Code** is configured automatically by `npx gaussian-memory init`.

**OpenCode:** copy the config from `hooks/opencode-command-hooks.jsonc` to `~/.config/opencode/command-hooks.jsonc` and copy the hook scripts to `~/.config/opencode/hooks/`. See `hooks/README.md` for details.

**PiDev and others:** add the worker as an MCP server. The worker URL and auth token are in `~/.gaussian-memory-env` after running init. You can use the MCP tools directly (`memory_retrieve`, `memory_store`) even without automatic hook capture.

---

## MCP tools

The system exposes an MCP server. Key tools:

| Tool | What it does |
|---|---|
| `memory_retrieve` | Retrieve relevant memories for a query |
| `memory_store` | Store a memory explicitly |
| `memory_auto_store` | Store with automatic domain and type inference |
| `memory_extract_and_store` | Extract facts from a session log |
| `memory_capture_passive` | Parse structured notes (Key Learnings / Decisions sections) |
| `memory_belief_drift` | Show how confidence in a belief has changed over time |
| `memory_stats` | Counts, σ distribution, domain breakdown |
| `memory_bulk_delete` | Delete memories by text pattern |
| `memory_judge` | Compare two memories: supersedes / conflicts / extends |
| `identity_profile_get/set` | Cross-device identity profile via KV |

Full tool list in `src/index.ts`.

---

## Belief drift

Every memory has a σ history. You can see how your confidence in a belief changed over time:

```
memory_belief_drift(query="deploy architecture decision")
```

```
● Chose Cloudflare Workers — zero maintenance, edge-native
σ: 0.500 → 0.190 (Δ+0.310) — strongly reinforced
2026-05-20  σ=0.500  [stored]
2026-05-28  σ=0.350  [reinforced]
2026-06-04  σ=0.190  [reinforced]
```

---

## File structure

```
src/index.ts            MCP server and retrieval pipeline
src/gaussian.ts         Bhattacharyya, Kalman merge, σ math
bin/gaussian-memory.js  CLI (init + ingest)
hooks/                  Hook scripts for Claude Code and OpenCode
schema.sql              D1 schema
wrangler.example.toml   Template for manual setup
```

---

## Status

Single-user BYOC, working end-to-end. Ship target: July 1 2026.
