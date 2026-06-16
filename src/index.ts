import type { Env } from './types';
import { TOOLS, handleToolCall } from './tools';
import { embed } from './embed';
import {
  pruneJunkMemories, updateDecay, deduplicateRecentMemories,
  deduplicateColdMemories, cleanupSingletons, refreshStaleDomainSummaries,
  cronRebuildBatch, synthesizeIdentityProfile, consolidateColdMemories,
} from './cron';
import { processPendingEntityQueue } from './storage';

export type { Env };

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/viz') {
      return handleViz(env);
    }

    if (request.method === 'GET' && url.pathname === '/viz/data') {
      const apiKey = url.searchParams.get('key') ?? '';
      if (apiKey !== (env.AUTH_TOKEN ?? '')) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: JSON_HEADERS });
      }
      return handleVizData(env);
    }

    if (request.method === 'POST' && url.pathname === '/admin/seed-domains') {
      const apiKey = (request.headers.get('Authorization') ?? '').replace('Bearer ', '');
      if (apiKey !== (env.AUTH_TOKEN ?? '')) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: JSON_HEADERS });
      }
      const body: { clear?: boolean; seeds: { name: string; text: string }[] } = await request.json();
      if (body.clear) await env.DB.prepare('DELETE FROM domain_anchors').run();
      const results: string[] = [];
      for (const seed of body.seeds) {
        try {
          const mu = await embed(seed.text, env);
          await env.DB.prepare(
            'INSERT OR REPLACE INTO domain_anchors (name, embedding, memory_count, last_summarized_count) VALUES (?, ?, 0, 0)'
          ).bind(seed.name, JSON.stringify(Array.from(mu))).run();
          results.push(`seeded: ${seed.name}`);
        } catch (e: any) {
          results.push(`failed: ${seed.name} — ${e?.message}`);
        }
      }
      return new Response(JSON.stringify({ results }), { headers: JSON_HEADERS });
    }

    if (request.method !== 'POST') {
      return new Response('Gaussian Memory MCP Server', { status: 200 });
    }

    // API key auth — required. Bearer header only; query param auth removed (logs in server access logs).
    // Deploy must set AUTH_TOKEN secret via: wrangler secret put AUTH_TOKEN
    if (!env.AUTH_TOKEN) {
      return new Response(JSON.stringify({ error: 'Server misconfigured: AUTH_TOKEN not set. Run: wrangler secret put AUTH_TOKEN' }), {
        status: 500, headers: JSON_HEADERS,
      });
    }
    const authHeader = request.headers.get('Authorization') ?? '';
    const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (headerToken !== env.AUTH_TOKEN) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: JSON_HEADERS,
      });
    }

    const contentType = request.headers.get('Content-Type') ?? '';
    if (!contentType.includes('application/json')) {
      return new Response(JSON.stringify({ error: 'Content-Type must be application/json' }), {
        status: 415, headers: JSON_HEADERS,
      });
    }
    const rawBody = await request.text();
    if (rawBody.length > 1_048_576) { // 1MB max
      return new Response(JSON.stringify({ error: 'Request body too large (max 1MB)' }), {
        status: 413, headers: JSON_HEADERS,
      });
    }
    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), {
        status: 400, headers: JSON_HEADERS,
      });
    }
    const { method, params, id } = body;

    // MCP notifications have no id — must return 202 with no body
    if (id === undefined) {
      return new Response(null, {
        status: 202,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    let result: any;

    if (method === 'initialize') {
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'gaussian-memory', version: '1.0.0' },
      };
    } else if (method === 'tools/list') {
      result = { tools: TOOLS };
    } else if (method === 'tools/call') {
      let content: string;
      try {
        content = await handleToolCall(params.name, params.arguments ?? {}, env, ctx);
      } catch (e: any) {
        content = `ERROR: ${e?.message ?? String(e)}\nStack: ${e?.stack ?? 'none'}`;
      }
      result = { content: [{ type: 'text', text: content }] };
    } else {
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id,
        error: { code: -32601, message: 'Method not found' },
      }), { headers: JSON_HEADERS });
    }

    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
      headers: JSON_HEADERS,
    });
  },

  // Daily decay + domain cleanup + identity synthesis via cron
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await pruneJunkMemories(env).catch(() => {});
    await consolidateColdMemories(env).catch(() => {});
    await updateDecay(env).catch(() => {});
    await deduplicateRecentMemories(env).catch(() => {});
    await deduplicateColdMemories(env).catch(() => {});
    await cleanupSingletons(env, 3).catch(() => {});
    await refreshStaleDomainSummaries(env).catch(() => {});
    await cronRebuildBatch(env, 2000, 10 * 60 * 1000).catch(() => {});
    await synthesizeIdentityProfile(env).catch(() => {});
    await handleToolCall('memory_judge', {}, env).catch(() => {});
    await processPendingEntityQueue(env).catch(() => {});
  },
};

async function handleVizData(env: Env): Promise<Response> {
  const [nodesRes, edgesRes] = await Promise.all([
    env.DB.prepare(`
      SELECT domain,
             COUNT(*) AS memory_count,
             AVG(access_count) AS avg_activation,
             memory_type
      FROM memories
      WHERE domain IS NOT NULL AND domain != ''
      GROUP BY domain, memory_type
      ORDER BY memory_count DESC
      LIMIT 60
    `).all(),
    env.DB.prepare(`
      SELECT mr.relation_type, mr.confidence,
             m1.domain AS from_domain,
             m2.domain AS to_domain
      FROM memory_relations mr
      JOIN memories m1 ON mr.from_id = m1.id
      JOIN memories m2 ON mr.to_id = m2.id
      WHERE m1.domain IS NOT NULL AND m2.domain IS NOT NULL
        AND m1.domain != m2.domain
      LIMIT 200
    `).all(),
  ]);

  // Aggregate edges by domain pair
  const edgeMap = new Map<string, { source: string; target: string; weight: number; count: number }>();
  for (const row of (edgesRes.results as any[])) {
    const key = [row.from_domain, row.to_domain].sort().join('||');
    const existing = edgeMap.get(key);
    if (existing) {
      existing.weight += row.confidence ?? 0.5;
      existing.count++;
    } else {
      edgeMap.set(key, { source: row.from_domain, target: row.to_domain, weight: row.confidence ?? 0.5, count: 1 });
    }
  }

  return new Response(JSON.stringify({
    nodes: nodesRes.results,
    edges: Array.from(edgeMap.values()),
  }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}

function handleViz(env: Env): Response {
  const workerUrl = (env as any).WORKER_URL ?? '';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gaussian Memory — Domain Graph</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a0f; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; overflow: hidden; }
  #canvas { width: 100vw; height: 100vh; }
  #tooltip {
    position: fixed; background: rgba(15,15,25,0.95); border: 1px solid #334155;
    border-radius: 8px; padding: 10px 14px; font-size: 13px; pointer-events: none;
    opacity: 0; transition: opacity 0.15s; max-width: 220px; z-index: 10;
  }
  #tooltip .domain { font-weight: 600; color: #a78bfa; margin-bottom: 4px; }
  #tooltip .stat { color: #94a3b8; font-size: 12px; line-height: 1.6; white-space: pre-line; }
  #header {
    position: fixed; top: 20px; left: 24px; z-index: 5;
  }
  #header h1 { font-size: 15px; font-weight: 600; color: #e2e8f0; letter-spacing: -0.3px; }
  #header p { font-size: 12px; color: #64748b; margin-top: 2px; }
  #legend {
    position: fixed; bottom: 24px; left: 24px; font-size: 11px; color: #475569; z-index: 5;
  }
  #legend span { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
</style>
</head>
<body>
<div id="header">
  <h1>Gaussian Memory</h1>
  <p>Domain activation graph — live from D1</p>
</div>
<div id="tooltip"><div class="domain"></div><div class="stat"></div></div>
<div id="legend">
  Node size = memory count &nbsp;·&nbsp; Edge weight = cross-domain relation confidence
</div>
<canvas id="canvas"></canvas>
<script>
const WORKER = ${JSON.stringify(workerUrl)};
const KEY = new URLSearchParams(location.search).get('key') ?? '';

const DOMAIN_COLORS = {
  'data-preprocessing': '#818cf8',
  'data-debugging': '#f472b6',
  'data-analysis': '#34d399',
  'career-goals': '#fbbf24',
  'gaussian-memory-dev': '#a78bfa',
  'sprint-presentation': '#f87171',
  'loreal-internship': '#60a5fa',
  'data-security': '#fb923c',
  'data-visualization': '#2dd4bf',
  'data-manipulation': '#c084fc',
};
function colorFor(domain) {
  if (DOMAIN_COLORS[domain]) return DOMAIN_COLORS[domain];
  let h = 0;
  for (let i = 0; i < domain.length; i++) h = (h * 31 + domain.charCodeAt(i)) >>> 0;
  return \`hsl(\${h % 360}, 65%, 62%)\`;
}

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
let nodes = [], edges = [], sim = null;
let W, H, dpr;

function resize() {
  dpr = window.devicePixelRatio || 1;
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);
}
resize();
window.addEventListener('resize', () => { resize(); draw(); });

async function load() {
  const url = WORKER + '/viz/data?key=' + encodeURIComponent(KEY);
  let data;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const txt = await res.text();
      showError('Fetch failed: ' + res.status + ' — ' + txt.slice(0, 120));
      return;
    }
    data = await res.json();
  } catch(e) {
    showError('Network error: ' + e.message);
    return;
  }
  if (!data.nodes?.length) {
    showError('No memory data found in D1. Store some memories first.');
    return;
  }

  // Aggregate nodes by domain
  const domainMap = new Map();
  for (const r of data.nodes) {
    const d = domainMap.get(r.domain) ?? { domain: r.domain, count: 0, activation: 0, types: new Set() };
    d.count += r.memory_count;
    d.activation += r.avg_activation * r.memory_count;
    d.types.add(r.memory_type);
    domainMap.set(r.domain, d);
  }
  const nodeList = Array.from(domainMap.values());
  // Spread initial positions evenly around a circle so sim has room to work
  nodes = nodeList.map((d, i) => {
    const angle = (i / nodeList.length) * Math.PI * 2;
    const radius = Math.min(W, H) * 0.32;
    return {
      ...d,
      activation: d.activation / d.count,
      x: W/2 + Math.cos(angle) * radius,
      y: H/2 + Math.sin(angle) * radius,
      vx: 0, vy: 0,
      r: Math.max(18, Math.min(48, 12 + d.count * 3)),
      color: colorFor(d.domain),
    };
  });

  // Only keep top edges to avoid everything collapsing to center
  edges = data.edges
    .filter(e => e.source !== e.target)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 30)
    .map(e => ({ ...e, opacity: Math.min(0.5, 0.08 + e.weight * 0.3) }));

  simulate();
}

function simulate() {
  let iter = 0;
  function step() {
    const alpha = Math.max(0.001, 0.3 * Math.pow(0.97, iter++));
    // Repulsion — strong enough to keep nodes separated
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i+1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x || 0.1, dy = nodes[j].y - nodes[i].y || 0.1;
        const d = Math.sqrt(dx*dx + dy*dy) || 1;
        const minDist = nodes[i].r + nodes[j].r + 80;
        if (d < minDist) {
          const force = (minDist - d) / d * 0.6 * alpha;
          nodes[i].vx -= dx * force; nodes[i].vy -= dy * force;
          nodes[j].vx += dx * force; nodes[j].vy += dy * force;
        }
      }
    }
    // Weak attraction along edges only
    for (const e of edges) {
      const a = nodes.find(n => n.domain === e.source);
      const b = nodes.find(n => n.domain === e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx*dx+dy*dy) || 1;
      const target = (a.r + b.r) * 4;
      if (d > target) {
        const f = (d - target) / d * 0.02 * alpha;
        a.vx += dx*f; a.vy += dy*f;
        b.vx -= dx*f; b.vy -= dy*f;
      }
    }
    // Center gravity
    for (const n of nodes) {
      n.vx += (W/2 - n.x) * 0.003 * alpha;
      n.vy += (H/2 - n.y) * 0.003 * alpha;
      n.vx *= 0.82; n.vy *= 0.82;
      n.x = Math.max(n.r+20, Math.min(W-n.r-20, n.x + n.vx));
      n.y = Math.max(n.r+20, Math.min(H-n.r-20, n.y + n.vy));
    }
    draw();
    if (alpha > 0.001) requestAnimationFrame(step);
    else setInterval(() => draw(), 2000);
  }
  requestAnimationFrame(step);
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  // Edges
  for (const e of edges) {
    const a = nodes.find(n => n.domain === e.source);
    const b = nodes.find(n => n.domain === e.target);
    if (!a || !b) continue;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = \`rgba(148,163,184,\${e.opacity})\`;
    ctx.lineWidth = Math.max(0.5, e.count * 0.3);
    ctx.stroke();
  }
  // Nodes
  for (const n of nodes) {
    // Outer glow
    ctx.globalAlpha = 0.25;
    const glow = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r * 2.2);
    glow.addColorStop(0, n.color);
    glow.addColorStop(1, 'transparent');
    ctx.beginPath(); ctx.arc(n.x, n.y, n.r * 2.2, 0, Math.PI * 2);
    ctx.fillStyle = glow; ctx.fill();
    // Node fill
    ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fillStyle = n.color;
    ctx.fill();
    // Node border
    ctx.globalAlpha = 1;
    ctx.strokeStyle = n.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    // Label
    ctx.fillStyle = '#f1f5f9';
    ctx.font = \`bold \${Math.max(9, Math.min(11, n.r * 0.45))}px -apple-system, sans-serif\`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const words = n.domain.replace(/-/g,' ').split(' ');
    if (words.length > 2) {
      ctx.fillText(words.slice(0,2).join(' '), n.x, n.y - 6);
      ctx.fillText(words.slice(2).join(' '), n.x, n.y + 6);
    } else {
      ctx.fillText(words.join(' '), n.x, n.y);
    }
    // Count badge
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = n.color;
    ctx.font = '10px sans-serif';
    ctx.fillText(n.count + ' mem', n.x, n.y + n.r + 13);
    ctx.globalAlpha = 1;
  }
}

// Tooltip
canvas.addEventListener('mousemove', e => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const hit = nodes.find(n => Math.hypot(n.x-mx, n.y-my) < n.r);
  if (hit) {
    tooltip.style.opacity = '1';
    tooltip.style.left = (e.clientX + 14) + 'px';
    tooltip.style.top = (e.clientY - 10) + 'px';
    tooltip.querySelector('.domain').textContent = hit.domain;
    tooltip.querySelector('.stat').textContent =
      \`Memories: \${hit.count}\\nAvg activation: \${hit.activation.toFixed(1)}\\nTypes: \${[...hit.types].join(', ')}\`;
  } else {
    tooltip.style.opacity = '0';
  }
});
canvas.addEventListener('mouseleave', () => { tooltip.style.opacity = '0'; });

function showError(msg) {
  ctx.fillStyle = '#475569';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, W/2, H/2);
}

load();
</script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
