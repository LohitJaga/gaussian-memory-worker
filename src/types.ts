export interface Env {
  AI: Ai;
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  KV: KVNamespace;
  R2: R2Bucket;
  AUTH_TOKEN?: string;
}
