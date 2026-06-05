import type { Env } from './types';

export async function embed(text: string, env: Env): Promise<Float32Array> {
  const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] }) as any;
  const vec = result.data[0] as number[];
  const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
  return new Float32Array(vec.map((v: number) => v / norm));
}

export async function batchEmbed(texts: string[], env: Env): Promise<Float32Array[]> {
  const CHUNK = 100; // Workers AI bge-base-en-v1.5 hard limit
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += CHUNK) {
    const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: texts.slice(i, i + CHUNK) }) as any;
    for (const vec of result.data as number[][]) {
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      out.push(new Float32Array(vec.map(v => v / norm)));
    }
  }
  return out;
}

export function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) sum += a[i] * b[i];
  return sum;
}
