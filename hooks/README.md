# Gaussian Memory — Hook Setup

## Environment variables (required)

```bash
export GAUSSIAN_WORKER_URL="https://your-worker.workers.dev"
export GAUSSIAN_AUTH_TOKEN="your-token-here"
```

Add these to `~/.zshrc` or `~/.bashrc` so they persist.

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

Copy scripts to `~/.config/opencode/hooks/` and the config to `~/.config/opencode/`:

```bash
mkdir -p ~/.config/opencode/hooks
cp gaussian-retrieve.sh gaussian-posttool.sh gaussian-store.sh ~/.config/opencode/hooks/
chmod +x ~/.config/opencode/hooks/*.sh
cp opencode-command-hooks.jsonc ~/.config/opencode/command-hooks.jsonc
```

---

## Testing it works

After setup, start a session and ask:

> "what have I been working on recently?"

If memories surface in the response, retrieval is working.

Check `~/.claude/gaussian-receipts.jsonl` for injection logs — each line is one prompt with latency, results count, and score breakdown.
