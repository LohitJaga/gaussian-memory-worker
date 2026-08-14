// Shared helpers for the Gaussian Memory Claude Code / Cursor hooks.
// Node port of the logic previously spread across the bash hooks — one codebase,
// no jq/curl/awk/sed/perl/python dependencies, runs the same on
// zsh/bash/WSL/PowerShell/cmd because the harness invokes `node <path>`.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

export const HOME = os.homedir();

// Capture runs over raw shell commands, file writes and transcript text, so a credential
// typed inline would otherwise be persisted verbatim. Every branch keeps the surrounding
// text so the memory stays useful — only the secret itself is replaced. Ordered
// most-specific first; the generic KEY=value rule is last so named providers win.
const SECRET_PATTERNS = [
  [/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [/\b(Authorization|X-Api-Key|X-Auth-Token)(\s*[:=]\s*)["']?[^"'\s]{8,}/gi, '$1$2[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[REDACTED]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED]'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, '[REDACTED]'],
  [/\bhf_[A-Za-z0-9]{16,}/g, '[REDACTED]'],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s:@]+@/gi, '$1[REDACTED]@'],
  [/(--(?:password|token|secret|api-?key|access-?key)[=\s]+)["']?[^"'\s]+/gi, '$1[REDACTED]'],
  [/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Za-z0-9_]*)(\s*=\s*)["']?[^"'\s]+/gi, '$1$2[REDACTED]'],
];

export function redact(text) {
  let out = String(text ?? '');
  for (const [re, sub] of SECRET_PATTERNS) out = out.replace(re, sub);
  return out;
}

// Env resolution: prefer real environment (set by a sourced ~/.gaussian-memory-env
// or by Windows user env vars), else read the file directly. Hooks are spawned in a
// non-login shell that does not source profile rc files, and on Windows nothing
// sources it at all — so reading the file ourselves is what makes hooks portable.
export function loadEnv() {
  let worker = process.env.GAUSSIAN_WORKER_URL || '';
  let token = process.env.GAUSSIAN_AUTH_TOKEN || '';
  if (!worker || !token) {
    try {
      const txt = fs.readFileSync(path.join(HOME, '.gaussian-memory-env'), 'utf8');
      for (const line of txt.split('\n')) {
        const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        const val = m[2].replace(/^["']|["']$/g, '');
        if (m[1] === 'GAUSSIAN_WORKER_URL' && !worker) worker = val;
        if (m[1] === 'GAUSSIAN_AUTH_TOKEN' && !token) token = val;
      }
    } catch { /* no env file — caller handles empty worker */ }
  }
  return { worker, token };
}

export async function readStdin() {
  const chunks = [];
  try { for await (const c of process.stdin) chunks.push(c); } catch { /* no stdin */ }
  return Buffer.concat(chunks).toString('utf8');
}

// Project = git-root basename, lowercased, spaces/underscores → hyphens. git returns
// forward-slash paths on every platform, so posix basename is correct on Windows too.
export function detectProject(cwd = process.cwd()) {
  try {
    const root = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (root) return path.posix.basename(root).toLowerCase().replace(/[ _]/g, '-');
  } catch { /* not a git repo */ }
  return 'default';
}

// One MCP tools/call over HTTP. Returns { ok, text }: ok is false on any error
// (network, non-2xx, JSON-RPC error) — mirrors the bash `curl -sf` success check.
export async function callToolStatus(worker, token, name, args, timeoutMs = 5000, id = 1) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(worker, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
      signal: ac.signal,
    });
    if (!res.ok) return { ok: false, text: '' };
    const json = await res.json();
    if (json.error) return { ok: false, text: '' };
    return { ok: true, text: json?.result?.content?.[0]?.text || '' };
  } catch {
    return { ok: false, text: '' };
  } finally {
    clearTimeout(timer);
  }
}

// Convenience wrapper for callers that only want the content text ('' on any error).
export async function callTool(worker, token, name, args, timeoutMs = 5000, id = 1) {
  return (await callToolStatus(worker, token, name, args, timeoutMs, id)).text;
}

// Session-end extraction shared by the Claude Code Stop hook and the Cursor sessionEnd
// hook. Per-session atomic mkdir lock (with 2-min stale recovery), byte-offset delta so
// only newly-appended transcript content is sent, and the offset is committed only after
// a successful POST so a failed batch is retried next run.
export async function sessionStore({ input, stateDir, worker, token, sessionKeys, syncClaudeMd }) {
  let data = {};
  try { data = JSON.parse(input); } catch { return; }
  let sessionId = '';
  for (const k of sessionKeys) { if (data[k]) { sessionId = data[k]; break; } }
  if (!sessionId) return;

  try { fs.mkdirSync(stateDir, { recursive: true }); } catch { return; }

  const lockDir = path.join(stateDir, `lock_${sessionId}`);
  let acquired = false;
  try { fs.mkdirSync(lockDir); acquired = true; } catch {
    // Stale-lock recovery: a killed run can strand the lock; reclaim after 2 minutes.
    try {
      if (Date.now() - fs.statSync(lockDir).mtimeMs > 120000) {
        try { fs.rmdirSync(lockDir); } catch { /* raced */ }
        try { fs.mkdirSync(lockDir); acquired = true; } catch { /* raced */ }
      }
    } catch { /* lock vanished */ }
  }
  if (!acquired) return;

  try {
    const project = detectProject();
    const transcriptPath = data.transcript_path || '';
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

    const offsetFile = path.join(stateDir, `offset_${sessionId}`);
    const fileSize = fs.statSync(transcriptPath).size;
    let lastOffset = 0;
    try { const v = parseInt(String(fs.readFileSync(offsetFile, 'utf8')).trim(), 10); if (Number.isFinite(v)) lastOffset = v; } catch { /* no offset yet */ }
    if (lastOffset > fileSize) lastOffset = 0; // transcript rotated/shrank
    if (fileSize < lastOffset + 8000) return;  // not enough new content

    const fullLog = parseTranscript(transcriptPath, lastOffset);
    if (!fullLog || fullLog.length < 2000) return;
    const log = fullLog.slice(-30000);

    const { ok } = await callToolStatus(worker, token, 'memory_extract_and_store', { log_text: log, project }, 10000, 99);
    if (ok) fs.writeFileSync(offsetFile, String(fileSize));

    if (syncClaudeMd) {
      const claudeMd = path.join(HOME, '.claude', 'CLAUDE.md');
      try {
        if (fs.existsSync(claudeMd) && fs.statSync(claudeMd).size > 0) {
          await callToolStatus(worker, token, 'identity_profile_set',
            { content: fs.readFileSync(claudeMd, 'utf8') }, 10000, 100);
        }
      } catch { /* CLAUDE.md sync is best-effort */ }
    }
  } finally {
    try { fs.rmdirSync(lockDir); } catch { /* already removed */ }
  }
}

// Byte-offset delta parse of a JSONL transcript. Returns ' | '-joined turns of
// meaningful text, filtering agent bookkeeping, long code blocks, and bare paths.
// Handles both Claude Code (role under .message) and Cursor (role at top level).
export function parseTranscript(transcriptPath, offset) {
  let slice;
  try {
    const buf = fs.readFileSync(transcriptPath);
    slice = buf.subarray(Math.min(offset, buf.length)).toString('utf8');
  } catch {
    return '';
  }
  const out = [];
  const skipHead = /^(SPAWNED|MERGED|SKIP|ERROR|Extracted \d)/;
  const barePath = /^\/(?:Users|home)\/\S*$/;
  const bareFile = /^\S+\.(csv|jsonl|pdf|png|ts|py|sh|json)$/;
  for (const line of slice.split('\n')) {
    if (out.length >= 300) break;
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const role = e.role || (e.message && e.message.role) || '';
    const label = role === 'user' ? 'User' : 'Assistant';
    const content = (e.message && e.message.content) ?? '';
    if (typeof content === 'string') {
      if (content.length > 25 && content !== '[REDACTED]') out.push(`[${label}]: ${redact(content).slice(0, 300)}`);
    } else if (Array.isArray(content)) {
      for (const c of content) {
        if (!c || typeof c !== 'object' || c.type !== 'text') continue;
        const text = (c.text || '').trim();
        if (text.length < 25 || text === '[REDACTED]') continue;
        if (skipHead.test(text)) continue;
        if (text.startsWith('```') && (text.split('\n').length - 1) > 3) continue;
        if (barePath.test(text)) continue;
        if (bareFile.test(text)) continue;
        out.push(`[${label}]: ${redact(text).slice(0, 400)}`);
      }
    }
  }
  return out.join(' | ');
}
