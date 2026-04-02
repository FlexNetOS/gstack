// Ark Home — N-gram Feature Hashing Embedder
//
// Produces deterministic 384-dim embeddings using multi-level n-gram feature
// hashing. Unlike a pure random-hash approach, this method makes texts that
// share words and subwords produce *similar* vectors — which is critical for
// semantic routing and nearest-neighbor search.
//
// Three feature levels, each allocated a band of the 384-dim vector:
//   [0..127]   — word unigrams  (bag-of-words signal)
//   [128..255] — word bigrams   (word-order / phrase signal)
//   [256..383] — character 3-grams (subword / typo-tolerance signal)
//
// Each n-gram is hashed to a bucket within its band and contributes a signed
// weight (+1 or -1, determined by a second hash). The result is a sparse-ish
// signed count vector that is then L2-normalized. This is essentially a
// "hashing trick" (Weinberger et al. 2009) applied at multiple granularities.
//
// When ONNX model files become available, swap in WasmEmbedder from
// ruvector-onnx-embeddings-wasm for real transformer embeddings.

const EMBEDDING_DIM = 384;

// Band boundaries
const WORD_UNI_START = 0;
const WORD_UNI_END = 128;     // 128 dims for word unigrams
const WORD_BI_START = 128;
const WORD_BI_END = 256;      // 128 dims for word bigrams
const CHAR_TRI_START = 256;
const CHAR_TRI_END = 384;     // 128 dims for char trigrams

// Weights for each band (controls relative importance)
const WORD_UNI_WEIGHT = 1.0;
const WORD_BI_WEIGHT = 0.7;
const CHAR_TRI_WEIGHT = 0.4;

/**
 * FNV-1a hash for a string. Returns a 32-bit unsigned integer.
 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Tokenize text into words (lowercase, trimmed, split on non-alphanumeric).
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .trim()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 0);
}

/**
 * Extract character trigrams from normalized text (with boundary markers).
 */
function charTrigrams(text: string): string[] {
  const s = `^${text.toLowerCase().trim()}$`;
  const grams: string[] = [];
  for (let i = 0; i <= s.length - 3; i++) {
    grams.push(s.slice(i, i + 3));
  }
  return grams;
}

/**
 * Hash an n-gram into a band of the embedding vector with a signed contribution.
 */
function hashIntoBand(
  vec: Float32Array,
  gram: string,
  bandStart: number,
  bandSize: number,
  weight: number,
): void {
  const h1 = fnv1a(gram);
  const bucket = (h1 % bandSize);
  // Second hash determines sign: spread contributions to reduce collision damage
  const h2 = fnv1a(gram + '\x00');
  const sign = (h2 & 1) ? 1.0 : -1.0;
  vec[bandStart + bucket] += sign * weight;
}

/**
 * Generate a deterministic embedding vector from text.
 *
 * Uses multi-level n-gram feature hashing across three bands:
 * word unigrams, word bigrams, and character trigrams. Texts that share
 * vocabulary produce similar vectors, enabling meaningful cosine similarity.
 *
 * Deterministic: same input always yields the same output.
 * No external model files required.
 */
export function embedText(text: string): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIM);

  const words = tokenize(text);
  const charGrams = charTrigrams(text);
  const wordBandSize = WORD_UNI_END - WORD_UNI_START;
  const biBandSize = WORD_BI_END - WORD_BI_START;
  const charBandSize = CHAR_TRI_END - CHAR_TRI_START;

  // Word unigrams — IDF-like weighting: shorter words are more common, weight less
  for (const w of words) {
    const idfApprox = Math.min(1.0 + Math.log(1 + w.length) * 0.3, 2.0);
    hashIntoBand(vec, w, WORD_UNI_START, wordBandSize, WORD_UNI_WEIGHT * idfApprox);
  }

  // Word bigrams — capture phrase-level structure
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = `${words[i]} ${words[i + 1]}`;
    hashIntoBand(vec, bigram, WORD_BI_START, biBandSize, WORD_BI_WEIGHT);
  }

  // Character trigrams — subword signal, helps with typos and morphology
  for (const g of charGrams) {
    hashIntoBand(vec, g, CHAR_TRI_START, charBandSize, CHAR_TRI_WEIGHT);
  }

  // L2 normalize to unit vector
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBEDDING_DIM; i++) vec[i] /= norm;

  return vec;
}

/**
 * Compute cosine similarity between two embeddings.
 * Both vectors should already be L2-normalized (embedText guarantees this).
 */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Async embedder function compatible with SemanticRouter.setEmbedder()
 */
export async function embedAsync(text: string): Promise<Float32Array> {
  return embedText(text);
}

export { EMBEDDING_DIM };
