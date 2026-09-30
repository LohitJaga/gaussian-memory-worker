# Gaussian Memory

Each prompt arrives with a "Relevant session context" block injected by the Gaussian Memory hook. It is retrieved from the user's persistent memory across Claude Code and Codex sessions.

- Treat that block as ground truth for the user's past work, decisions, people, and preferences. When it answers the question, answer from it directly, without searching files or tools first.
- When it doesn't cover the question, call the gaussian-memory MCP tool `memory_retrieve` with a focused query before looking elsewhere.
- Store durable facts (decisions, preferences, project context, corrections) with `memory_auto_store`. Don't announce it.
