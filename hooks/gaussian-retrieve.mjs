#!/usr/bin/env node
// UserPromptSubmit hook — parallel multi-query contextual retrieval + CLAUDE.md bootstrap.
// Identity/working-style is handled by CLAUDE.md; this injects dynamic episodic context only.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { HOME, loadEnv, readStdin, detectProject, callTool } from './gaussian-lib.mjs';

const input = await readStdin();
let prompt = '';
let transcriptPath = '';
try { const j = JSON.parse(input); prompt = String(j.prompt || ''); transcriptPath = String(j.transcript_path || ''); } catch { /* not JSON */ }
if (!prompt) process.exit(0);

// End of the previous assistant reply, so vague prompts ("this", "that thing") resolve against the
// conversation. Reads only the transcript's tail. Handles Claude Code (type: assistant) and Codex
// rollout (response_item / message / role: assistant) lines; any failure just means no context.
function previousAssistantTurn(file) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      const blocks = o?.type === 'assistant' ? o.message?.content
        : o?.type === 'response_item' && o.payload?.role === 'assistant' ? o.payload.content : null;
      if (!Array.isArray(blocks)) continue;
      const text = blocks.filter(b => b?.type === 'text' || b?.type === 'output_text').map(b => b.text || '').join('\n').trim();
      if (text) return text.slice(-600);
    }
  } catch { /* no transcript */ }
  return '';
}
const prevTurn = transcriptPath ? previousAssistantTurn(transcriptPath) : '';

const { worker, token } = loadEnv();
if (!worker) process.exit(0);

// --codex: same retrieval for Codex. Receipts go under ~/.codex, and the CLAUDE.md
// bootstrap is skipped since Codex reads AGENTS.md instead.
const codex = process.argv.includes('--codex');
const claudeMd = path.join(HOME, '.claude', 'CLAUDE.md');
const project = detectProject();

// Bootstrap CLAUDE.md from KV if missing/empty on this device (runs once per new device).
// A "null", error, or implausibly short payload is rejected so a bad fetch can't clobber it.
try {
  const size = fs.existsSync(claudeMd) ? fs.statSync(claudeMd).size : 0;
  if (!codex && size === 0) {
    const profile = await callTool(worker, token, 'identity_profile_get', {}, 10000);
    if (profile && profile !== 'null' && profile.length >= 50) {
      fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
      fs.writeFileSync(claudeMd, profile);
    }
  }
} catch { /* bootstrap is best-effort */ }

function queryMemory(query, context, top_k = 10, rerank = true) {
  const args = { query, top_k, project, ...(context ? { context } : {}), ...(rerank ? {} : { rerank: false }) };
  // 8 s: the reranked retrieval runs ~3.3 s warm; 5 s lost every result on a cold start. Claude Code
  // sets no hook timeout and Codex allows 15 s, so this stays inside both.
  return callTool(worker, token, 'memory_retrieve', args, 8000);
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
  queryMemory(q1, prevTurn, 10),
  // Ambient queries keep the rerank stage: skipping it (rerank:false) saved a third of the Jev cost but
  // measurably hurt the injected set (real-prompt sim 2026-10-09: nDCG -0.024 strict), since their one
  // line each is then picked by score alone.
  queryMemory(q2, '', 6),
  queryMemory(q3, '', 6),
]);
const latencyMs = Date.now() - start;

const scoreOf = (l) => { const m = l.match(/^\[([0-9.]+)\]/); return m ? parseFloat(m[1]) : 0; };
// A result line starts with its score and project, e.g. "[1.23] (project ...". The looser /^\[[0-9]/
// also admitted continuation lines of multi-line memories that happen to start "[22] ...".
// Identity-domain lines are dropped (CLAUDE.md owns identity); score gate 0.70.
const isResult = (l) => /^\[[0-9]+\.[0-9]+\] \(/.test(l) && !/\(identity[ /]/.test(l) && scoreOf(l) >= 0.70;
// The tool groups its output by domain; the score carries the rank, so sort by it.
const linesOf = (r) => (r || '').split('\n').filter(isResult).sort((a, b) => scoreOf(b) - scoreOf(a));
// Near-dup key: memory text after the confidence marker (● ◑ ○), first 80 chars.
const textKey = (l) => { const m = l.match(/[●◑○]\s(.*)/); return m ? m[1].slice(0, 80) : l; };
const seenText = new Set();
const take = (l) => { const k = textKey(l); if (seenText.has(k)) return false; seenText.add(k); return true; };

// The prompt's own matches first, in rank order, then one line from each ambient query (Q2 recent
// decisions, Q3 conventions). Merging all three by score put ambient lines above the prompt's best
// match: on 250 real prompts (2026-10-09 simulation) the first injected memory was useful 62% of the
// time score-merged vs 70% prompt-first, with the same coverage.
let merged = linesOf(r1).filter(take);
for (const r of [r2, r3]) { const pick = linesOf(r).find(take); if (pick) merged.push(pick); }

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
  const receiptFile = path.join(HOME, codex ? '.codex' : '.claude', 'gaussian-receipts.jsonl');
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

} catch { /* receipts are best-effort */ }

process.exit(0);
