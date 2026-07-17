import type { Env } from './types';

// Shared quota-aware wrapper around env.AI.run(), used by every Workers AI call site in this
// codebase (see embed.ts, domain.ts, cron.ts, storage.ts, tools.ts, index.ts). Centralizes two
// concerns that used to be handled independently (or not at all) at each of the ~17 raw
// env.AI.run() call sites:
//
//  1. Detecting the Workers AI free-tier daily neuron budget being exhausted (Cloudflare error
//     code 3036, message containing "You have used up your daily free allocation of 10,000
//     neurons" — confirmed live against a real outage 2026-07-13/14) and short-circuiting further
//     calls until the next 00:00 UTC reset (the fixed boundary the free tier resets on), instead
//     of every call site independently retrying into (and wasting requests against) an outage
//     that won't clear for hours.
//  2. NOT conflating 3036 with Cloudflare's *other* 429 — error code 3040 "Capacity Exceeded"
//     ("No more data centers to forward the request to") is also a bare HTTP 429, but it's a
//     transient regional routing issue, unrelated to the daily budget. Detection here is a
//     message-substring match on 3036's specific, confirmed wording — not on HTTP status — so it
//     won't misfire on 3040 or on a future unrelated 429 class.
export const QUOTA_COOLDOWN_KV_KEY = 'quota:cooldown';

// Cloudflare KV's expirationTtl has a hard floor of 60s — env.KV.put rejects a smaller TTL
// outright rather than silently rounding up, so this file owns the clamp (see cooldownTtlSeconds).
export const KV_MIN_TTL_SECONDS = 60;

export class QuotaExceededError extends Error {
  constructor(message: string = 'Workers AI daily free quota exceeded') {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The one confirmed, specific signature of a 3036 quota-exhaustion error. Matches on EITHER
// substring (not both required) deliberately — the exact shape of a thrown Workers AI binding
// error (whether `.message` carries the numeric code, the prose, or both) isn't confirmed by
// Cloudflare's docs, so this hedges against either half going missing independently rather than
// depending on a `.code`/`.status` property whose shape is also unconfirmed.
export function isQuotaExceededError(e: unknown): boolean {
  const msg = errMessage(e);
  return msg.includes('3036') || msg.includes('daily free allocation');
}

// Anything else that smells like a 429 gets logged loudly here (never silently folded into the
// quota path) — so a future wording change on Cloudflare's side, or a genuinely new 429 class,
// doesn't silently stop being visible. 3040 (Capacity Exceeded) deliberately lands here, not in
// isQuotaExceededError above — it's transient/regional, not a daily-budget signal, and matching
// it as quota-exhaustion would incorrectly cool down every call site for the rest of the day over
// what's often a single retryable blip.
function logIfUnmatched429(e: unknown): void {
  const msg = errMessage(e);
  const looks429 = /\b429\b/.test(msg) || /rate.?limit/i.test(msg) || /capacity exceeded/i.test(msg) || msg.includes('3040');
  if (looks429) {
    console.error('[callAI] unmatched 429-shaped error (does not match the known 3036 quota signature):', msg);
  }
}

// Exported for tests. Real callers only ever use the current-time default via cooldownTtlSeconds().
export function secondsUntilNextMidnightUTC(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  return Math.ceil((next - now.getTime()) / 1000);
}

// Clamped to KV's 60s floor — in the minute before midnight this would otherwise compute a TTL
// under 60s, which env.KV.put rejects outright rather than rounding up for us.
export function cooldownTtlSeconds(now: Date = new Date()): number {
  return Math.max(KV_MIN_TTL_SECONDS, secondsUntilNextMidnightUTC(now));
}

export interface CallAIOptions {
  // Blind retry-with-backoff (200ms * attempt) on non-quota errors — opt-in only, matching
  // aiRunWithRetry's old default of 2. embed()/batchEmbed() are the only callers that set this
  // (preserving their existing behavior exactly). The 15 LLM-generation call sites default to 0
  // (no retry): retrying a ~30s llama call on an arbitrary transient error is a latency and
  // neuron-budget amplifier those sites shouldn't pay silently — they already have their own
  // per-call-site fallback/timeout handling (Promise.race guards, try/catch-to-default, etc.).
  retries?: number;
}

// Every env.AI.run() call in this codebase should go through this wrapper instead of calling the
// binding directly — see the module comment above for why.
export async function callAI(env: Env, model: string, input: any, opts: CallAIOptions = {}): Promise<any> {
  const retries = opts.retries ?? 0;

  // Skip the call entirely if a prior call already confirmed quota is exhausted for today —
  // avoids spending a request (and a network round-trip) on a call already known to fail.
  // KV read failure fails open (treated as no cooldown) — matches this codebase's existing
  // tolerance for KV being best-effort elsewhere (e.g. storage.ts's recentEmbeddingsGet).
  const cooldown = await env.KV.get(QUOTA_COOLDOWN_KV_KEY).catch(() => null);
  if (cooldown) {
    throw new QuotaExceededError('Workers AI daily free quota exceeded (cooldown active — resets at next 00:00 UTC)');
  }

  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await env.AI.run(model as any, input);
    } catch (e) {
      lastErr = e;
      if (isQuotaExceededError(e)) {
        // Don't retry into a known-exhausted quota — write the cooldown and fail fast instead of
        // burning the remaining `retries` attempts on a call that cannot succeed today.
        await env.KV.put(QUOTA_COOLDOWN_KV_KEY, '1', { expirationTtl: cooldownTtlSeconds() }).catch(() => {});
        throw new QuotaExceededError(errMessage(e));
      }
      logIfUnmatched429(e);
      if (i < retries) await new Promise(r => setTimeout(r, 200 * (i + 1)));
    }
  }
  throw lastErr;
}
