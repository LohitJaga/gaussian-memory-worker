// Gaussian math — port of gaussian.py

export function bhattacharyyaDistance(
  muA: Float32Array, sigmaA: Float32Array,
  muB: Float32Array, sigmaB: Float32Array
): number {
  const dim = muA.length;
  let term1 = 0;
  let term2 = 0;

  for (let i = 0; i < dim; i++) {
    const sigmaAvg = (sigmaA[i] + sigmaB[i]) / 2;
    const diff = muA[i] - muB[i];
    term1 += (diff * diff) / sigmaAvg;
    term2 += Math.log(sigmaAvg / Math.sqrt(sigmaA[i] * sigmaB[i]));
  }

  return 0.125 * term1 + 0.5 * term2;
}

export function kalmanMerge(
  muA: Float32Array, sigmaA: Float32Array,
  muB: Float32Array, sigmaB: Float32Array
): [Float32Array, Float32Array] {
  const dim = muA.length;
  const muNew = new Float32Array(dim);
  const sigmaNew = new Float32Array(dim);

  for (let i = 0; i < dim; i++) {
    sigmaNew[i] = 1.0 / (1.0 / sigmaA[i] + 1.0 / sigmaB[i]);
    muNew[i] = sigmaNew[i] * (muA[i] / sigmaA[i] + muB[i] / sigmaB[i]);
  }

  return [muNew, sigmaNew];
}

export function shouldMerge(
  muA: Float32Array, sigmaA: Float32Array,
  muB: Float32Array, sigmaB: Float32Array,
  threshold = 0.15
): boolean {
  return bhattacharyyaDistance(muA, sigmaA, muB, sigmaB) < threshold;
}

// contradicted=true: memory conflicts with others — increase uncertainty instead of sharpen
// domainSize: sparse domains (low count) get a higher floor, keeping memories fuzzier longer
export function sharpenSigma(
  sigma: Float32Array,
  factor = 0.85,
  floor = 0.15,
  contradicted = false,
  domainSize = 10
): Float32Array {
  if (contradicted) {
    // Widen sigma on contradiction — opposite of sharpening
    return sigma.map(s => Math.min(s * 1.2, 1.5)) as Float32Array;
  }
  // Sparse domains keep a higher floor so memories don't collapse prematurely
  const adaptiveFloor = domainSize < 5 ? 0.35 : domainSize < 15 ? 0.25 : floor;
  return sigma.map(s => Math.max(s * factor, adaptiveFloor)) as Float32Array;
}

export function decaySigma(sigma: Float32Array, delta = 0.02): Float32Array {
  return sigma.map(s => s + delta) as Float32Array;
}

export function initialSigma(_domain: string, emotionalIntensity = 0.0, dim: number): Float32Array {
  let base = 0.5;
  if (emotionalIntensity > 0.7) base *= 0.5;
  else if (emotionalIntensity > 0.4) base *= 0.75;
  return new Float32Array(dim).fill(base);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function meanSigma(sigma: Float32Array): number {
  return sigma.reduce((a, b) => a + b, 0) / sigma.length;
}

export function serializeSigma(sigma: Float32Array): string {
  const bytes = new Uint8Array(sigma.buffer, sigma.byteOffset, sigma.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function deserializeSigma(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

// Bhattacharyya-based retrieval score in [0,1]. High when query and memory are
// distributionally similar (low cosine distance + matched uncertainty levels).
export function distributionalScore(cosineSim: number, querySigma: number, memorySigma: number): number {
  if (!Number.isFinite(querySigma) || querySigma <= 0 || !Number.isFinite(memorySigma) || memorySigma <= 0) return 0.5;
  const muDistSq = 2 * (1 - Math.max(0, cosineSim));
  const sigmaAvg = (querySigma + memorySigma) / 2;
  const term1 = 0.125 * muDistSq / sigmaAvg;
  const term2 = 0.5 * Math.log(sigmaAvg / Math.sqrt(querySigma * memorySigma));
  return Math.exp(-(term1 + term2));
}
