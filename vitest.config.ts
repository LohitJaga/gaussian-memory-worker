import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // Stale agent git worktrees live under .claude/worktrees/ inside the project, each a
    // full checkout. Without this, vitest's default **/*.test.ts discovery collects every
    // test file 3x (once per worktree) and reports phantom failures from their copies.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
