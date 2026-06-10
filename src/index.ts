import type { Env } from './types';
import { TOOLS, handleToolCall } from './tools';
import {
  pruneJunkMemories, updateDecay, deduplicateRecentMemories,
  deduplicateColdMemories, cleanupSingletons, refreshStaleDomainSummaries,
  cronRebuildBatch, synthesizeIdentityProfile, consolidateColdMemories,
} from './cron';
import { processPendingEntityQueue } from './storage';

export type { Env };

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

    if (request.method !== 'POST') {
      return new Response('Gaussian Memory MCP Server', { status: 200 });
    }

    // API key auth — required. Bearer header only; query param auth removed (logs in server access logs).
    // Deploy must set AUTH_TOKEN secret via: wrangler secret put AUTH_TOKEN
    if (!env.AUTH_TOKEN) {
      return new Response(JSON.stringify({ error: 'Server misconfigured: AUTH_TOKEN not set. Run: wrangler secret put AUTH_TOKEN' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }
    const authHeader = request.headers.get('Authorization') ?? '';
    const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (headerToken !== env.AUTH_TOKEN) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      });
    }

    const contentType = request.headers.get('Content-Type') ?? '';
    if (!contentType.includes('application/json')) {
      return new Response(JSON.stringify({ error: 'Content-Type must be application/json' }), {
        status: 415, headers: { 'Content-Type': 'application/json' },
      });
    }
    const rawBody = await request.text();
    if (rawBody.length > 1_048_576) { // 1MB max
      return new Response(JSON.stringify({ error: 'Request body too large (max 1MB)' }), {
        status: 413, headers: { 'Content-Type': 'application/json' },
      });
    }
    const body = JSON.parse(rawBody) as any;
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
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  },

  // Daily decay + domain cleanup + identity synthesis via cron
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await pruneJunkMemories(env);
    await consolidateColdMemories(env).catch(() => {});
    await updateDecay(env);
    await deduplicateRecentMemories(env);
    await deduplicateColdMemories(env);
    await cleanupSingletons(env, 3);
    await refreshStaleDomainSummaries(env);
    await cronRebuildBatch(env, 2000, 10 * 60 * 1000);
    await synthesizeIdentityProfile(env);
    // Process up to 20 pending_judge pairs nightly — feeds memory_relations with verdicts
    await handleToolCall('memory_judge', {}, env).catch(() => {});
    // Process pending entity extraction queue (new memories queued during day)
    await processPendingEntityQueue(env);
  },
};
