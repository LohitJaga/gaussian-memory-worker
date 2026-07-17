import { describe, it, expect } from 'vitest';
import {
  callAI, isQuotaExceededError, cooldownTtlSeconds, secondsUntilNextMidnightUTC,
  QuotaExceededError, QUOTA_COOLDOWN_KV_KEY, KV_MIN_TTL_SECONDS,
} from './ai';

// ── Fake Env ─────────────────────────────────────────────────────────────
// This codebase's existing test files (storage.test.ts, domain.test.ts, ...) only test pure
// functions and never mock Env — callAI() is the first function here whose whole job is env-
// dependent (KV cooldown + AI binding interplay), so there's no pure-function-only way to cover
// it. No mocking library is used (matches the rest of this repo) — just a plain object literal
// implementing the slice of Env callAI() actually touches (AI.run, KV.get, KV.put).

interface FakeKV {
  store: Map<string, { value: string; expirationTtl?: number }>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

function makeFakeKV(): FakeKV {
  const store = new Map<string, { value: string; expirationTtl?: number }>();
  return {
    store,
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, { value, expirationTtl: opts?.expirationTtl });
    },
  };
}

function makeFakeEnv(runImpl: (model: string, input: any) => Promise<any>, kv?: FakeKV) {
  const KV = kv ?? makeFakeKV();
  return {
    env: { AI: { run: runImpl }, KV } as any,
    kv: KV,
  };
}

const QUOTA_ERR = new Error(
  'Error: 3036: You have used up your daily free allocation of 10,000 neurons',
);
const CAPACITY_ERR = new Error('3040: Capacity Exceeded — No more data centers to forward the request to');
const GENERIC_ERR = new Error('network timeout');

// ── isQuotaExceededError ─────────────────────────────────────────────────

describe('isQuotaExceededError', () => {
  it('matches on the "3036" substring alone', () => {
    expect(isQuotaExceededError(new Error('code 3036 occurred'))).toBe(true);
  });

  it('matches on the "daily free allocation" substring alone', () => {
    expect(isQuotaExceededError(new Error('you have used up your daily free allocation'))).toBe(true);
  });

  it('matches the real confirmed message (both substrings present)', () => {
    expect(isQuotaExceededError(QUOTA_ERR)).toBe(true);
  });

  it('does NOT match error code 3040 (Capacity Exceeded — a different, transient 429)', () => {
    expect(isQuotaExceededError(CAPACITY_ERR)).toBe(false);
  });

  it('does not match an unrelated error', () => {
    expect(isQuotaExceededError(GENERIC_ERR)).toBe(false);
  });

  it('does not throw on a non-Error thrown value', () => {
    expect(isQuotaExceededError('a plain string error')).toBe(false);
    expect(isQuotaExceededError({ weird: 'shape' })).toBe(false);
  });
});

// ── cooldownTtlSeconds / secondsUntilNextMidnightUTC ────────────────────

describe('secondsUntilNextMidnightUTC', () => {
  it('computes exactly 3600s when one hour before midnight UTC', () => {
    const now = new Date('2026-07-15T23:00:00.000Z');
    expect(secondsUntilNextMidnightUTC(now)).toBe(3600);
  });

  it('computes a small remainder just before midnight UTC', () => {
    const now = new Date('2026-07-15T23:59:30.000Z');
    expect(secondsUntilNextMidnightUTC(now)).toBe(30);
  });

  it('computes ~a full day right at midnight UTC', () => {
    const now = new Date('2026-07-15T00:00:00.000Z');
    expect(secondsUntilNextMidnightUTC(now)).toBe(86400);
  });
});

describe('cooldownTtlSeconds', () => {
  it('clamps to the 60s KV floor when less than 60s remain before midnight UTC', () => {
    const now = new Date('2026-07-15T23:59:45.000Z'); // 15s to midnight
    expect(cooldownTtlSeconds(now)).toBe(KV_MIN_TTL_SECONDS);
  });

  it('clamps exactly at the boundary (59s remaining -> still clamped to 60)', () => {
    const now = new Date('2026-07-15T23:59:01.000Z'); // 59s to midnight
    expect(cooldownTtlSeconds(now)).toBe(60);
  });

  it('does NOT clamp when more than 60s remain before midnight UTC', () => {
    const now = new Date('2026-07-15T23:58:00.000Z'); // 120s to midnight
    expect(cooldownTtlSeconds(now)).toBe(120);
  });

  it('returns the real remaining time mid-day, far above the floor', () => {
    const now = new Date('2026-07-15T12:00:00.000Z'); // 12h to midnight
    expect(cooldownTtlSeconds(now)).toBe(12 * 3600);
  });
});

// ── callAI: cooldown short-circuit ───────────────────────────────────────

describe('callAI — cooldown short-circuit', () => {
  it('does not call env.AI.run at all when a cooldown is already set in KV', async () => {
    let callCount = 0;
    const kv = makeFakeKV();
    await kv.put(QUOTA_COOLDOWN_KV_KEY, '1', { expirationTtl: 3600 });
    const { env } = makeFakeEnv(async () => { callCount++; return { response: 'should not happen' }; }, kv);

    await expect(callAI(env, '@cf/meta/llama-3.2-3b-instruct', {})).rejects.toBeInstanceOf(QuotaExceededError);
    expect(callCount).toBe(0);
  });

  it('proceeds normally when no cooldown is set', async () => {
    const { env } = makeFakeEnv(async () => ({ response: 'ok' }));
    const result = await callAI(env, '@cf/meta/llama-3.2-3b-instruct', {});
    expect(result).toEqual({ response: 'ok' });
  });
});

// ── callAI: quota-error detection ────────────────────────────────────────

describe('callAI — quota-error detection', () => {
  it('on a quota error: writes the cooldown key to KV, does not retry, and throws QuotaExceededError', async () => {
    let callCount = 0;
    const { env, kv } = makeFakeEnv(async () => { callCount++; throw QUOTA_ERR; });

    await expect(callAI(env, '@cf/meta/llama-3.3-70b-instruct-fp8-fast', {}, { retries: 2 }))
      .rejects.toBeInstanceOf(QuotaExceededError);

    expect(callCount).toBe(1); // no retry attempts despite retries:2
    expect(kv.store.has(QUOTA_COOLDOWN_KV_KEY)).toBe(true);
  });

  it('sets a KV TTL of at least the 60s floor', async () => {
    const { env, kv } = makeFakeEnv(async () => { throw QUOTA_ERR; });
    await expect(callAI(env, 'model', {})).rejects.toBeInstanceOf(QuotaExceededError);
    const written = kv.store.get(QUOTA_COOLDOWN_KV_KEY);
    expect(written?.expirationTtl).toBeGreaterThanOrEqual(KV_MIN_TTL_SECONDS);
  });

  it('matches on error code 3040 (Capacity Exceeded) as NOT a quota error — retries as normal', async () => {
    let callCount = 0;
    const { env, kv } = makeFakeEnv(async () => {
      callCount++;
      if (callCount < 2) throw CAPACITY_ERR;
      return { response: 'recovered' };
    });
    const result = await callAI(env, 'model', {}, { retries: 2 });
    expect(result).toEqual({ response: 'recovered' });
    expect(callCount).toBe(2);
    expect(kv.store.has(QUOTA_COOLDOWN_KV_KEY)).toBe(false); // never treated as quota exhaustion
  });
});

// ── callAI: retry behavior (opt-in only) ─────────────────────────────────

describe('callAI — non-quota errors retry unchanged when retries is set', () => {
  it('retries up to `retries` times on a non-quota error, then succeeds', async () => {
    let callCount = 0;
    const { env } = makeFakeEnv(async () => {
      callCount++;
      if (callCount < 3) throw GENERIC_ERR;
      return { response: 'third time lucky' };
    });
    const result = await callAI(env, 'model', {}, { retries: 2 });
    expect(result).toEqual({ response: 'third time lucky' });
    expect(callCount).toBe(3); // 1 initial + 2 retries
  });

  it('throws the last non-quota error after exhausting all retries', async () => {
    let callCount = 0;
    const { env } = makeFakeEnv(async () => { callCount++; throw GENERIC_ERR; });
    await expect(callAI(env, 'model', {}, { retries: 2 })).rejects.toBe(GENERIC_ERR);
    expect(callCount).toBe(3); // 1 initial + 2 retries
  });

  it('does NOT retry on a non-quota error when retries is omitted (defaults to 0)', async () => {
    let callCount = 0;
    const { env } = makeFakeEnv(async () => { callCount++; throw GENERIC_ERR; });
    await expect(callAI(env, 'model', {})).rejects.toBe(GENERIC_ERR);
    expect(callCount).toBe(1); // no retry — matches the 15 LLM-generation call sites' behavior
  });
});

// ── callAI: unmatched-429 logging path ───────────────────────────────────
// console.error is this codebase's existing pattern for surfacing infra-level failures without
// throwing (e.g. storage.ts's processPendingEntityQueue catch, tools.ts's memory_judge JSON-parse
// failure) — asserting the log fires (not swallowing it) is what verifies a future Cloudflare
// wording change on the quota message won't silently stop being visible.

describe('callAI — unmatched 429-shaped errors are logged, not silently folded into quota handling', () => {
  it('logs via console.error when a 429-shaped-but-unmatched error occurs, and does not set cooldown', async () => {
    const originalError = console.error;
    const logs: unknown[][] = [];
    console.error = (...args: unknown[]) => { logs.push(args); };
    try {
      const { env, kv } = makeFakeEnv(async () => { throw CAPACITY_ERR; });
      await expect(callAI(env, 'model', {})).rejects.toBe(CAPACITY_ERR);
      expect(kv.store.has(QUOTA_COOLDOWN_KV_KEY)).toBe(false);
      const matched = logs.some(args =>
        args.some(a => typeof a === 'string' && a.includes('[callAI]') && a.includes('unmatched 429')));
      expect(matched).toBe(true);
    } finally {
      console.error = originalError;
    }
  });

  it('does not log for a plain non-429 error', async () => {
    const originalError = console.error;
    const logs: unknown[][] = [];
    console.error = (...args: unknown[]) => { logs.push(args); };
    try {
      const { env } = makeFakeEnv(async () => { throw GENERIC_ERR; });
      await expect(callAI(env, 'model', {})).rejects.toBe(GENERIC_ERR);
      const matched = logs.some(args =>
        args.some(a => typeof a === 'string' && a.includes('[callAI]')));
      expect(matched).toBe(false);
    } finally {
      console.error = originalError;
    }
  });

  it('does not log for the confirmed quota error (handled as quota, not an "unmatched" 429)', async () => {
    const originalError = console.error;
    const logs: unknown[][] = [];
    console.error = (...args: unknown[]) => { logs.push(args); };
    try {
      const { env } = makeFakeEnv(async () => { throw QUOTA_ERR; });
      await expect(callAI(env, 'model', {})).rejects.toBeInstanceOf(QuotaExceededError);
      const matched = logs.some(args =>
        args.some(a => typeof a === 'string' && a.includes('[callAI]')));
      expect(matched).toBe(false);
    } finally {
      console.error = originalError;
    }
  });
});

// ── QuotaExceededError ───────────────────────────────────────────────────

describe('QuotaExceededError', () => {
  it('is a distinguishable Error subclass', () => {
    const e = new QuotaExceededError('test message');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(QuotaExceededError);
    expect(e.name).toBe('QuotaExceededError');
    expect(e.message).toBe('test message');
  });

  it('has a sensible default message', () => {
    const e = new QuotaExceededError();
    expect(e.message.length).toBeGreaterThan(0);
  });
});
