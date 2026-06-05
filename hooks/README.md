# Gaussian Memory — Hook Setup

## Environment variables (required)

```bash
export GAUSSIAN_WORKER_URL="https://your-worker.workers.dev"
export GAUSSIAN_AUTH_TOKEN="your-token-here"
```

The `npx gaussian-memory init` command writes these to `~/.gaussian-memory-env` (chmod 600) and sources it from your shell rc file automatically.

---

## Claude Code

Copy the three hook scripts to `~/.claude/hooks/`:

```bash
cp gaussian-retrieve.sh gaussian-posttool.sh gaussian-store.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/*.sh
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

---

## OpenCode

OpenCode integrates via MCP (it has no shell hook system). Merge the contents of `opencode-mcp-config.json` into your global OpenCode config at `~/.config/opencode/opencode.json`:

```bash
# If opencode.json doesn't exist yet:
mkdir -p ~/.config/opencode
cp opencode-mcp-config.json ~/.config/opencode/opencode.json

# If you already have opencode.json, add the "mcp" block from opencode-mcp-config.json into it.
```

OpenCode reads `{env:VAR}` syntax for environment variables, so `GAUSSIAN_WORKER_URL` and `GAUSSIAN_AUTH_TOKEN` must be set in your shell environment before starting OpenCode.

---

## Other MCP-compatible editors (Cursor, Zed, Continue.dev, etc.)

Any editor that supports remote MCP servers can use Gaussian Memory. The worker is a plain JSON-RPC 2.0 HTTP endpoint — no SSE, no OAuth flow required. Point the MCP config at `$GAUSSIAN_WORKER_URL` with `Authorization: Bearer $GAUSSIAN_AUTH_TOKEN`.

---

## Testing it works

After setup, start a session and ask:

> "what have I been working on recently?"

If memories surface in the response, retrieval is working.

Check `~/.claude/gaussian-receipts.jsonl` for injection logs — each line is one prompt with latency, results count, and score breakdown.
