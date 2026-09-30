#!/usr/bin/env node
// Codex hooks — Stop stores the current session; SessionStart (--sweep) catches up on earlier ones.
// Codex drops async hooks still running when it exits (every `codex exec`, and the last turn of an
// interactive session), and on Windows a child that tries to outlive Codex is killed with it, so
// the final turn can't be stored at exit. The sweep extracts whatever earlier sessions left behind
// at the next start, from the same per-session offsets, so nothing is sent twice.
import fs from 'fs';
import path from 'path';
import { HOME, loadEnv, readStdin, sessionStore, parseTranscript } from './gaussian-lib.mjs';

const input = await readStdin();
const { worker, token } = loadEnv();
if (!worker) process.exit(0);

const stateDir = path.join(HOME, '.codex', 'gaussian-state');
const store = (payload) => sessionStore({
  input: payload,
  worker,
  token,
  stateDir,
  sessionKeys: ['session_id'],
  syncClaudeMd: false,
});

if (!process.argv.includes('--sweep')) {
  await store(input);
  process.exit(0);
}

let current = '';
try { current = JSON.parse(input).session_id || ''; } catch { /* no payload */ }

// Rollouts from the last week, newest first, at most 5 per start to bound the hook's runtime.
const cutoff = Date.now() - 7 * 86400 * 1000;
const files = [];
const walk = (dir) => {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) {
      try { const m = fs.statSync(p).mtimeMs; if (m > cutoff) files.push({ p, m }); } catch { /* vanished */ }
    }
  }
};
walk(path.join(HOME, '.codex', 'sessions'));
files.sort((a, b) => b.m - a.m);

// The first line is session_meta (~25KB, mostly base instructions). Only user threads are
// extracted: guardian approval reviews and other sub-agent threads carry a parent_thread_id.
const meta = (p) => {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(128 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const first = buf.subarray(0, n).toString('utf8').split('\n')[0];
    return JSON.parse(first).payload || {};
  } catch { return {}; }
};

// Only sessions sessionStore would actually extract count toward the cap (same 8KB / 2000-char
// floors). Rollouts are ~45KB of instructions before the first turn, so bytes alone can't tell a
// one-line `codex exec` apart, and those would otherwise take every slot on every start.
const hasNew = (p, sid) => {
  let offset = 0;
  try { offset = parseInt(fs.readFileSync(path.join(stateDir, `offset_${sid}`), 'utf8'), 10) || 0; } catch { /* none yet */ }
  try { if (fs.statSync(p).size < offset + 8000) return false; } catch { return false; }
  return parseTranscript(p, offset).length >= 2000;
};

let done = 0;
for (const { p } of files) {
  if (done >= 5) break;
  const m = meta(p);
  const sid = m.session_id || m.id;
  if (!sid || sid === current || m.thread_source !== 'user' || m.parent_thread_id || !hasNew(p, sid)) continue;
  await store(JSON.stringify({ session_id: sid, transcript_path: p, cwd: m.cwd }));
  done++;
}
