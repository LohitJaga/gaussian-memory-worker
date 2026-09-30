#!/usr/bin/env node
// Codex Stop hook — extract facts from the session and store in Gaussian Memory.
// Codex's rollout transcript uses response_item payloads; parseTranscript handles that shape.
// Codex drops async hooks still running when it exits (always the case for `codex exec`,
// and the last turn of an interactive session), so the hook re-launches itself as a
// detached process and returns immediately; the child does the slow extraction call.
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { HOME, loadEnv, readStdin, sessionStore } from './gaussian-lib.mjs';

const input = await readStdin();

if (!process.argv.includes('--detached')) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--detached'], {
    cwd: process.cwd(), detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.stdin.end(input);
  child.unref();
} else {
  const { worker, token } = loadEnv();
  if (worker) {
    await sessionStore({
      input,
      worker,
      token,
      stateDir: path.join(HOME, '.codex', 'gaussian-state'),
      sessionKeys: ['session_id'],
      syncClaudeMd: false,
    });
  }
}
