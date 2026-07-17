import type { Env } from './types';
import { callAI } from './ai';

// retries: 2 — preserves the old aiRunWithRetry default exactly. embed()/batchEmbed() are the
// only callAI() callers that opt into blind retry-with-backoff on non-quota errors (see ai.ts's
// CallAIOptions comment for why the other ~15 call sites don't).
export async function embed(text: string, env: Env): Promise<Float32Array> {
  const result = await callAI(env, '@cf/baai/bge-base-en-v1.5', { text: [text] }, { retries: 2 }) as any;
  const vec = result?.data?.[0] as number[] | undefined;
  if (!vec?.length) throw new Error(`Embedding failed: model returned no vector for text (${text.length} chars)`);
  const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0)) || 1;
  return new Float32Array(vec.map((v: number) => v / norm));
}

export async function batchEmbed(texts: string[], env: Env): Promise<Float32Array[]> {
  const CHUNK = 100; // Workers AI bge-base-en-v1.5 hard limit
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += CHUNK) {
    const result = await callAI(env, '@cf/baai/bge-base-en-v1.5', { text: texts.slice(i, i + CHUNK) }, { retries: 2 }) as any;
    const data = (result?.data ?? []) as number[][];
    if (data.length !== Math.min(CHUNK, texts.length - i)) {
      throw new Error(`Batch embedding failed: expected ${Math.min(CHUNK, texts.length - i)} vectors, got ${data.length}`);
    }
    for (const vec of data) {
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      out.push(new Float32Array(vec.map(v => v / norm)));
    }
  }
  return out;
}

export function dotProduct(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) sum += a[i] * b[i];
  return sum;
}
