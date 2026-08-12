#!/usr/bin/env node
// Cursor sessionEnd hook — extract facts from the session and store in Gaussian Memory.
// Cursor's transcript puts role at the top level; parseTranscript handles both shapes.
import path from 'path';
import { HOME, loadEnv, readStdin, sessionStore } from './gaussian-lib.mjs';

const input = await readStdin();
const { worker, token } = loadEnv();
if (!worker) process.exit(0);

await sessionStore({
  input,
  worker,
  token,
  stateDir: path.join(HOME, '.cursor', 'gaussian-state'),
  sessionKeys: ['session_id', 'conversation_id'],
  syncClaudeMd: false,
});

process.exit(0);
