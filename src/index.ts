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
  <p>Every memory, as a point — clustered into Gaussian domains · live from D1</p>
</div>
<div id="tooltip"><div class="domain"></div><div class="stat"></div></div>
<div id="legend">
  Each point = one memory &nbsp;·&nbsp; Each cloud = a domain (2D Gaussian, spread ∝ √memories)
</div>
<canvas id="canvas"></canvas>
<script>
const WORKER = ${JSON.stringify(workerUrl)};
const KEY = new URLSearchParams(location.search).get('key') ?? '';

const DOMAIN_COLORS = {
  // grouped by theme so related domains share a hue family
  'gaussian-memory-dev': '#a78bfa', 'cloudflare-infra': '#c4b5fd', 'git-workflow': '#8b5cf6',
  'loreal-internship': '#60a5fa', 'color-wow-agents': '#38bdf8', 'gchat-bot-dev': '#22d3ee', 'sql-analytics': '#2dd4bf',
  'career-job-search': '#fbbf24', 'sprint-planning': '#f59e0b', 'pico-trading': '#fb923c',
  'purdue-coursework': '#f472b6', 'stat-416': '#ec4899', 'leetcode-practice': '#e879f9',
  'ml-pytorch': '#34d399', 'python-data-work': '#4ade80', 'bayer-datamine': '#f87171',
  'personal-life': '#94a3b8',
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
let nodes = [], points = [];
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
  nodes = Array.from(domainMap.values())
    .sort((a, b) => b.count - a.count)
    .map(d => ({ ...d, activation: d.activation / Math.max(1, d.count),
                 spread: 10 + Math.sqrt(d.count) * 2.2, color: colorFor(d.domain) }));

  // Place cluster centers: biggest first, phyllotaxis spiral, then relax so
  // clouds don't overlap (spacing ∝ each cloud's spread).
  const GA = Math.PI * (3 - Math.sqrt(5));
  const scale = Math.min(W, H) * 0.085;
  nodes.forEach((n, i) => {
    const rad = scale * Math.sqrt(i);
    n.x = W/2 + Math.cos(i * GA) * rad;
    n.y = H/2 + Math.sin(i * GA) * rad;
  });
  for (let it = 0; it < 140; it++) {
    for (let i = 0; i < nodes.length; i++) for (let j = i+1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = b.x-a.x, dy = b.y-a.y; const d = Math.hypot(dx,dy) || 1;
      const want = (a.spread + b.spread) * 1.25 + 40;   // gap between cloud edges
      if (d < want) { const f = (want-d)/d*0.5; dx*=f; dy*=f; a.x-=dx; a.y-=dy; b.x+=dx; b.y+=dy; }
    }
    for (const n of nodes) {
      n.x = Math.max(n.spread+30, Math.min(W-n.spread-30, n.x));
      n.y = Math.max(n.spread+60, Math.min(H-n.spread-30, n.y));
    }
  }

  // Sample each domain's real memory_count as points from a 2D Gaussian
  function gauss() { let u=0,v=0; while(!u)u=Math.random(); while(!v)v=Math.random();
    return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); }
  points = [];
  for (const n of nodes) {
    const m = Math.min(n.count, 1500);
    for (let k = 0; k < m; k++)
      points.push({ x: n.x + gauss()*n.spread, y: n.y + gauss()*n.spread, color: n.color });
  }

  draw();
}

function draw() {
  ctx.clearRect(0, 0, W, H);

  // the galaxy — every memory as a glowing point, additive blending so dense
  // cluster cores bloom bright. (no cross-domain lines — they read as clutter)
  ctx.globalCompositeOperation = 'lighter';
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.globalAlpha = 0.7;
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  // 3. domain labels floating over each cloud
  for (const n of nodes) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const label = n.domain.replace(/-/g, ' ');
    const ly = n.y - n.spread - 12;
    ctx.font = 'bold 12px -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(241,245,249,0.92)';
    ctx.fillText(label, n.x, ly);
    ctx.font = '10px sans-serif';
    ctx.fillStyle = n.color;
    ctx.globalAlpha = 0.8;
    ctx.fillText(n.count.toLocaleString() + ' memories', n.x, ly + 14);
    ctx.globalAlpha = 1;
  }
}

// Tooltip — hit by distance to a cloud center
canvas.addEventListener('mousemove', e => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const hit = nodes.find(n => Math.hypot(n.x-mx, n.y-my) < n.spread + 12);
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
