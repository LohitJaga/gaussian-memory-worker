import type { Env } from './types';
import { TOOLS, handleToolCall } from './tools';
import { embed } from './embed';
import {
  pruneJunkMemories, updateDecay, deduplicateRecentMemories,
  deduplicateColdMemories, cleanupSingletons, refreshStaleDomainSummaries,
  cronRebuildBatch, synthesizeIdentityProfile, consolidateColdMemories,
} from './cron';
import { processPendingEntityQueue } from './storage';
import { retrieve, baselineRetrieve } from './retrieval';

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
    // Bench-only structured retrieval endpoint (referenced by bench/lib/client.mjs).
    // Returns raw JSON rows WITH memory ids so the harness can score by gold_ids instead
    // of substring-matching the agent-facing text (which mis-scored correct dedup
    // survivors — BENCHMARKING.md 2026-07-08 audit finding #2). The agent-facing
    // tools/call text format is deliberately untouched. frozen defaults to TRUE here:
    // benchmark trials must not sharpen sigma / bump access_count (audit finding #5);
    // pass frozen:false explicitly to opt back into live-mutating behavior.
    if (url.pathname === '/bench/retrieve') {
      const q = body ?? {};
      if (typeof q.query !== 'string' || !q.query.trim()) {
        return new Response(JSON.stringify({ error: 'query (string) is required' }), { status: 400, headers: JSON_HEADERS });
      }
      const topK = Number(q.top_k) || 8;
      const frozen = q.frozen !== false;
      try {
        const rows = q.baseline === true
          ? await baselineRetrieve(q.query, topK, env, q.project ?? 'default', q.strict_project === true)
          : await retrieve(q.query, q.domain ?? null, topK, env, q.project ?? 'default', q.strict_project === true, { frozen });
        return new Response(JSON.stringify({
          mode: q.baseline === true ? 'baseline' : 'gaussian',
          frozen: q.baseline === true ? true : frozen, // baseline path never mutates regardless
          top_k: topK,
          rows,
        }), { headers: JSON_HEADERS });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e?.message ?? String(e) }), { status: 500, headers: JSON_HEADERS });
      }
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
    const run = async (name: string, fn: () => Promise<unknown>) => {
      try { await fn(); } catch (e) { console.error(`[cron] ${name} failed:`, e); }
    };
    await run('pruneJunk', () => pruneJunkMemories(env));
    await run('consolidateCold', () => consolidateColdMemories(env));
    await run('updateDecay', () => updateDecay(env));
    await run('dedupeRecent', () => deduplicateRecentMemories(env));
    await run('dedupeCold', () => deduplicateColdMemories(env));
    await run('cleanupSingletons', () => cleanupSingletons(env, 3));
    await run('refreshDomains', () => refreshStaleDomainSummaries(env));
    await run('cronRebuild', () => cronRebuildBatch(env, 2000, 10 * 60 * 1000));
    await run('synthesizeIdentity', () => synthesizeIdentityProfile(env));
    await run('memoryJudge', () => handleToolCall('memory_judge', {}, env));
    await run('entityQueue', () => processPendingEntityQueue(env));
  },
};

async function handleVizData(env: Env): Promise<Response> {
  // Grouped by cluster_id (the raw, unnamed micro-cluster tag), not the capped/
  // named `domain` field — clusters are the internal, always-consistent signal,
  // so the galaxy reflects the real shape of the corpus rather than a lossy
  // 50-name summary of it. No LIMIT: cluster_id has no cap, unlike domain.
  const nodesRes = await env.DB.prepare(`
    SELECT cluster_id,
           COUNT(*) AS memory_count,
           AVG(access_count) AS avg_activation,
           memory_type
    FROM memories
    WHERE cluster_id IS NOT NULL AND cluster_id != ''
    GROUP BY cluster_id, memory_type
    ORDER BY memory_count DESC
  `).all();

  return new Response(JSON.stringify({
    nodes: nodesRes.results,
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
  <p>Every memory, as a point — clustered by similarity · live from D1</p>
</div>
<div id="tooltip"><div class="cluster"></div><div class="stat"></div></div>
<div id="legend">
  Each point = one memory &nbsp;·&nbsp; Each cloud = a cluster of near-duplicate/related memories (2D Gaussian, spread ∝ √memories)
</div>
<canvas id="canvas"></canvas>
<script>
const WORKER = ${JSON.stringify(workerUrl)};
const KEY = new URLSearchParams(location.search).get('key') ?? '';

// Clusters are unnamed (raw micro-cluster ids, not the human-facing named
// domains) — color is a deterministic hash of the id, no name-based lookup.
// Hue restricted to a cosmic band (blues/purples/cyans/pinks/ambers) instead of
// the full 0-360 wheel — avoids muddy yellow-greens, reads as one coherent
// nebula palette instead of a random rainbow.
const HUE_BANDS = [[195, 260], [260, 320], [320, 345], [15, 45]]; // cyan-blue, purple, pink, amber
function colorFor(clusterId) {
  let h = 0;
  for (let i = 0; i < clusterId.length; i++) h = (h * 31 + clusterId.charCodeAt(i)) >>> 0;
  const band = HUE_BANDS[h % HUE_BANDS.length];
  const hue = band[0] + (h >> 8) % (band[1] - band[0]);
  const light = 58 + (h >> 16) % 18;
  return \`hsl(\${hue}, 72%, \${light}%)\`;
}

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
let nodes = [], points = [], dust = [];
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
    const d = domainMap.get(r.cluster_id) ?? { cluster: r.cluster_id, count: 0, activation: 0, types: new Set() };
    d.count += r.memory_count;
    d.activation += r.avg_activation * r.memory_count;
    d.types.add(r.memory_type);
    domainMap.set(r.cluster_id, d);
  }
  const allClusters = Array.from(domainMap.values())
    .sort((a, b) => b.count - a.count)
    .map(d => ({ ...d, activation: d.activation / Math.max(1, d.count),
                 spread: 10 + Math.sqrt(d.count) * 2.2, color: colorFor(d.cluster) }));

  // Collision-avoidance placement is O(n²) per relax iteration — fine for ~50
  // named domains, not for ~thousands of raw clusters (most singletons/pairs,
  // per this corpus's own distribution). Only the biggest clusters get a
  // placed-and-labeled cloud; the long tail scatters as unlabeled background
  // points — visually this reads as a bright core of real topic clusters in a
  // diffuse starfield, which suits a galaxy better than 50 discrete blobs anyway.
  // Size-based cutoff, not an arbitrary top-N: most clusters in a real corpus are
  // tiny (near-duplicate pairs/triples) and look identical to background dust at
  // any placement — only clusters big enough to read as an actual "cloud" earn
  // the collision-avoided placement + label. Also caps the O(n²) relax cost.
  // allClusters is sorted descending, so the qualifying set is always a clean
  // prefix — everything after it (whether too small or just past the cap) scatters.
  const MIN_CLOUD_SIZE = 15;
  const placedCount = Math.min(80, allClusters.filter(n => n.count >= MIN_CLOUD_SIZE).length);
  nodes = allClusters.slice(0, placedCount);
  const scattered = allClusters.slice(placedCount);

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

  // Sample each placed cluster's real memory_count as points from a 2D Gaussian
  function gauss() { let u=0,v=0; while(!u)u=Math.random(); while(!v)v=Math.random();
    return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); }
  points = [];
  for (const n of nodes) {
    const m = Math.min(n.count, 1500);
    for (let k = 0; k < m; k++)
      points.push({ x: n.x + gauss()*n.spread, y: n.y + gauss()*n.spread, color: n.color, bright: true });
  }
  // Scattered long tail: one dim point per small cluster (not per memory) —
  // rendering every individual memory here (there can be 4000+) drowns the real
  // clusters in a uniform wall of dots with no contrast. One dot per cluster,
  // hard-capped total, keeps this a quiet backdrop instead of the main event.
  dust = [];
  const MAX_DUST = 900;
  const dustPool = scattered.length > MAX_DUST
    ? scattered.slice().sort(() => Math.random() - 0.5).slice(0, MAX_DUST)
    : scattered;
  for (const n of dustPool) {
    dust.push({ x: Math.random() * W, y: Math.random() * H, color: n.color });
  }

  draw();
}

function draw() {
  // Radial vignette instead of flat black — a little atmosphere/depth instead
  // of a void, subtle dark-navy-to-black falloff from center.
  const bg = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, Math.max(W, H) * 0.75);
  bg.addColorStop(0, '#0d0d1c');
  bg.addColorStop(1, '#050508');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Dust first (dim, small, drawn underneath) so it reads as a quiet backdrop;
  // real cluster points drawn on top, bigger and brighter, with a soft glow
  // (shadowBlur) so they visually bloom against it — flat solid dots read as
  // a spreadsheet, glow reads as a nebula.
  ctx.globalCompositeOperation = 'lighter';
  ctx.shadowBlur = 0;
  for (const p of dust) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.1, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.globalAlpha = 0.28;
    ctx.fill();
  }
  for (const p of points) {
    ctx.shadowBlur = 8;
    ctx.shadowColor = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.1, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.globalAlpha = 0.85;
    ctx.fill();
  }
  ctx.shadowBlur = 0;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  // 3. member-count label floating over each placed cloud — clusters are
  // unnamed (raw ids, not human-facing domain names), so no title text, just size.
  // Every node here already cleared MIN_CLOUD_SIZE, so no additional skip needed.
  for (const n of nodes) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const ly = n.y - n.spread - 12;
    ctx.font = '10px sans-serif';
    ctx.fillStyle = n.color;
    ctx.globalAlpha = 0.8;
    ctx.fillText(n.count.toLocaleString() + ' memories', n.x, ly);
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
    tooltip.querySelector('.cluster').textContent = hit.cluster.slice(0, 8);
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
