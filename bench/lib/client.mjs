// Gaussian Memory benchmark harness — Worker client (Phase 0)
//
// Talks to a live deployment over the same JSON-RPC 2.0 path the agent uses
// (POST tools/call), so latency measured here is the real end-to-end number a
// user experiences, not an internal shortcut. No redeploy required.
//
// Credentials come from ~/.gaussian-memory-env (written by `gaussian-memory init`):
//   export GAUSSIAN_WORKER_URL="https://...workers.dev"
//   export GAUSSIAN_AUTH_TOKEN="..."
// or from process.env if already sourced into the shell.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function loadEnv() {
  let url = process.env.GAUSSIAN_WORKER_URL;
  let token = process.env.GAUSSIAN_AUTH_TOKEN;
  if (!url || !token) {
    try {
      const raw = readFileSync(join(homedir(), '.gaussian-memory-env'), 'utf8');
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*export\s+(GAUSSIAN_WORKER_URL|GAUSSIAN_AUTH_TOKEN)\s*=\s*"?([^"\n]+)"?/);
        if (!m) continue;
        if (m[1] === 'GAUSSIAN_WORKER_URL') url ??= m[2].trim();
        if (m[1] === 'GAUSSIAN_AUTH_TOKEN') token ??= m[2].trim();
      }
    } catch { /* fall through to the error below */ }
  }
  if (!url || !token) {
    throw new Error('Missing GAUSSIAN_WORKER_URL / GAUSSIAN_AUTH_TOKEN (set them or ensure ~/.gaussian-memory-env exists).');
  }
  return { url, token };
}

let _rpcId = 0;

// Raw JSON-RPC tools/call. Returns { text, latencyMs, ok, error }.
// latencyMs is wall-clock around the fetch — the honest over-the-wire number.
export async function callTool(name, args, { url, token }) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++_rpcId, method: 'tools/call', params: { name, arguments: args } });
  const t0 = performance.now();
  let resp, json;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
    });
    json = await resp.json();
  } catch (e) {
    return { text: '', latencyMs: performance.now() - t0, ok: false, error: String(e) };
  }
  const latencyMs = performance.now() - t0;
  if (json.error) return { text: '', latencyMs, ok: false, error: JSON.stringify(json.error) };
  // MCP result shape: { content: [{ type:'text', text:'...' }], ... } OR a bare string
  const content = json.result?.content;
  const text = Array.isArray(content) ? content.map(c => c.text ?? '').join('\n') : (typeof json.result === 'string' ? json.result : JSON.stringify(json.result));
  return { text, latencyMs, ok: true };
}

// Parse a memory_retrieve text block (tools.ts fmt: "[score] (domain/type)[ ~] conf text")
// into structured rows. `~` = spreading-activation hit; conf glyph ●/◑/○ maps to a sigma band.
// [DOMAIN: x] / Summary: headers are skipped. No IDs are available on this path — callers
// that need ID-level matching should switch to the optional /bench/retrieve endpoint.
const LINE_RE = /^\[(\d+\.\d+)\]\s+\(([^/]+)\/([^)]+)\)(\s+~)?\s*([●◑○])?\s*(.*)$/;

export function parseRetrieval(text) {
  if (!text || text === 'No memories found.') return [];
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('[DOMAIN:') || t.startsWith('Summary:') || t.startsWith('[SYNTHESIS]')) continue;
    const m = t.match(LINE_RE);
    if (!m) continue;
    rows.push({
      score: parseFloat(m[1]),
      domain: m[2].trim(),
      type: m[3].trim(),
      activated: Boolean(m[4]),
      confBand: m[5] ?? '',              // ● <0.3, ◑ <0.5, ○ >=0.5
      text: m[6].trim(),
      rank: rows.length + 1,
    });
  }
  return rows;
}

// Convenience: retrieve + parse in one call. baseline:true hits the Stage B naive
// top-k cosine path (memory_retrieve's baseline flag) instead of full hybrid scoring.
export async function retrieve(query, { top_k = 8, domain, project, strict_project, baseline } = {}, env) {
  const args = { query, top_k };
  if (domain) args.domain = domain;
  if (project) args.project = project;
  if (strict_project) args.strict_project = true;
  if (baseline) args.baseline = true;
  const res = await callTool('memory_retrieve', args, env);
  return { ...res, rows: res.ok ? parseRetrieval(res.text) : [] };
}
