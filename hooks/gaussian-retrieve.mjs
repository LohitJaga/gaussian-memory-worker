#!/usr/bin/env node
// UserPromptSubmit hook — parallel multi-query contextual retrieval + CLAUDE.md bootstrap.
// Identity/working-style is handled by CLAUDE.md; this injects dynamic episodic context only.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { HOME, loadEnv, readStdin, detectProject, callTool } from './gaussian-lib.mjs';

const input = await readStdin();
let prompt = '';
try { prompt = String(JSON.parse(input).prompt || ''); } catch { /* not JSON */ }
if (!prompt) process.exit(0);

const { worker, token } = loadEnv();
if (!worker) process.exit(0);

const claudeMd = path.join(HOME, '.claude', 'CLAUDE.md');
const project = detectProject();

// Bootstrap CLAUDE.md from KV if missing/empty on this device (runs once per new device).
// A "null", error, or implausibly short payload is rejected so a bad fetch can't clobber it.
try {
  const size = fs.existsSync(claudeMd) ? fs.statSync(claudeMd).size : 0;
  if (size === 0) {
    const profile = await callTool(worker, token, 'identity_profile_get', {}, 10000);
    if (profile && profile !== 'null' && profile.length >= 50) {
      fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
      fs.writeFileSync(claudeMd, profile);
    }
  }
} catch { /* bootstrap is best-effort */ }

function queryMemory(query, context, top_k = 10) {
  const args = context ? { query, top_k, project, context } : { query, top_k, project };
  return callTool(worker, token, 'memory_retrieve', args, 5000);
}

// Query routing: project-anchored in a git repo, prompt-word-based otherwise.
const words = prompt.split(/\s+/).filter(w => w.length > 3).slice(-6);
const promptWords = words.join(' ');
const topic = project;

let q2, q3;
if (project === 'default') {
  q2 = `${promptWords} recent context decisions`.trim();
  q3 = `${promptWords} outcomes preferences`.trim();
} else {
  q2 = `${project} recent decisions outcomes`;
  q3 = `${project} conventions preferences procedural how to work`;
}

// Q1: raw prompt when meaningful; short prompts anchor on their real content words
// (plus project when available), never a synthetic query that drops the user's topic.
let q1;
if (prompt.length < 25) {
  if (promptWords) {
    q1 = project === 'default' ? promptWords : `${project} ${promptWords}`;
  } else {
    q1 = project === 'default' ? 'recent context decisions' : `${project} recent work decisions`;
  }
} else {
  q1 = prompt;
}

// Q2/Q3 are ambient signal (recent-decisions / conventions), not the primary match —
// the final merge below caps at 12 results total across all 3 queries with a 0.70 score
// floor, so top_k:10 on these two was routinely over-fetching results that never survive
// to output. top_k:6 measured ~10% faster (avg 1602ms -> 1433ms, 8-trial A/B against the
// live worker). This can occasionally swap the last 1-2 items in the final top-12 for a
// similarly-scored alternative (checked directly: it did once in a live A/B, likely partly
// call-to-call score drift from reinforcement on read, not purely the lower top_k) — an
// acceptable tradeoff since it only ever touches the tail of an already-score-floored list,
// not what makes the cut in the first place. Q1 stays at 10 since it's the actual prompt
// match and more likely to have several distinct relevant hits worth keeping room for.
const start = Date.now();
const [r1, r2, r3] = await Promise.all([
  queryMemory(q1, prompt, 10),
  queryMemory(q2, '', 6),
  queryMemory(q3, '', 6),
]);
const latencyMs = Date.now() - start;

const scoreOf = (l) => { const m = l.match(/^\[([0-9.]+)\]/); return m ? parseFloat(m[1]) : 0; };

// Merge → drop identity domain (CLAUDE.md owns it) → keep scored lines → score gate 0.70
// → sort high→low → exact-line dedup → near-dup dedup on memory text (first 80 chars after
// '● ') → cap session-type lines at 3 → top 12.
let merged = [r1, r2, r3].filter(Boolean).join('\n').split('\n')
  .filter(l => !l.includes('(identity/'))
  .filter(l => /^\[[0-9]/.test(l))
  .filter(l => scoreOf(l) >= 0.70);
merged.sort((a, b) => scoreOf(b) - scoreOf(a));

const seenLine = new Set();
merged = merged.filter(l => {
  if (seenLine.has(l)) return false;
  seenLine.add(l);
  return true;
});

const seenText = new Set();
merged = merged.filter(l => {
  const i = l.indexOf('● ');
  const key = i >= 0 ? l.slice(i + 2, i + 82) : '';
  if (seenText.has(key)) return false;
  seenText.add(key);
  return true;
});

let sessionCount = 0;
merged = merged.filter(l => {
  if (/\/session\)/.test(l)) { sessionCount++; if (sessionCount > 3) return false; }
  return true;
});
merged = merged.slice(0, 12);
const mergedText = merged.join('\n');

// Current local time — the model otherwise only gets the date, so it can't reason about
// time of day or resolve the relative ages on retrieved memories. Injected unconditionally,
// including when nothing was retrieved.
const nowLine = `Current time: ${new Date().toLocaleString('en-US', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
})}`;

// Inject first so receipt I/O never delays the prompt.
const ctx = mergedText
  ? `${nowLine}\n\nRelevant session context (use as ground truth for recent work and decisions):\n${mergedText}`
  : nowLine;
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx },
}));

// Receipt logging — metadata + 200-char memory snippets for debugging.
try {
  const receiptFile = path.join(HOME, '.claude', 'gaussian-receipts.jsonl');
  const queryHash = crypto.createHash('md5').update(prompt).digest('hex').slice(0, 8);
  const memories = merged.filter(l => l.startsWith('[')).map(l => {
    const s = l.match(/^\[([0-9.]+)\]/); const d = l.match(/\(([^)]+)\)/);
    const text = l.replace(/^\[[0-9.]*\] \([^)]*\) . /, '')
      .replace(/[^\x20-\x7E]/g, '').replace(/\\/g, '/').slice(0, 200);
    return { score: s ? s[1] : '', domain: d ? d[1] : '', text };
  });
  const receipt = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    project,
    query_hash: queryHash,
    topic,
    latency_ms: latencyMs,
    injected: Boolean(mergedText),
    results: memories.length,
    score_buckets: {
      high: merged.filter(l => scoreOf(l) >= 1.10).length,
      mid: merged.filter(l => scoreOf(l) >= 0.95 && scoreOf(l) < 1.10).length,
      low: merged.filter(l => scoreOf(l) >= 0.70 && scoreOf(l) < 0.95).length,
    },
    memories,
  };
  fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
  fs.appendFileSync(receiptFile, JSON.stringify(receipt) + '\n');

  // Rotate under an atomic mkdir lock — keep last 500. If the lock is held, skip.
  const lock = receiptFile + '.lock';
  let locked = false;
  try { fs.mkdirSync(lock); locked = true; } catch { /* held by another hook */ }
  if (locked) {
    try {
      const lines = fs.readFileSync(receiptFile, 'utf8').split('\n').filter(Boolean);
      if (lines.length > 500) fs.writeFileSync(receiptFile, lines.slice(-500).join('\n') + '\n');
    } catch { /* nothing to rotate */ }
    try { fs.rmdirSync(lock); } catch { /* already gone */ }
  }
} catch { /* receipts are best-effort */ }

process.exit(0);
