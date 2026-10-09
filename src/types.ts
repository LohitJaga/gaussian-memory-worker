export interface Env {
  AI: Ai;
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  MICRO_VECTORIZE: VectorizeIndex;
  KV: KVNamespace;
  R2?: R2Bucket;
  AUTH_TOKEN?: string;
  WORKER_URL?: string;
  // "on" enables the Jev decision model (rerank, store-time merge decision, contradiction judge) and
  // the write-time expansions it relies on. Jev bills through prepaid AI Gateway credits, so it is opt-in.
  JEV_RERANK?: string;
}
