#!/usr/bin/env node
// Stop hook — extracts facts from this session's transcript into Gaussian memory,
// and pushes CLAUDE.md to KV for cross-device sync.
import path from 'path';
import { HOME, loadEnv, readStdin, sessionStore } from './gaussian-lib.mjs';

const input = await readStdin();
const { worker, token } = loadEnv();
if (!worker) process.exit(0);

await sessionStore({
  input,
  worker,
  token,
  stateDir: path.join(HOME, '.claude', 'gaussian-state'),
  sessionKeys: ['session_id'],
  syncClaudeMd: true,
});

process.exit(0);
