// Browser stub for src/services/embeddings.js.
//
// The desktop embeddings service loads a Transformers.js ONNX model to GENERATE
// embeddings — far too heavy for a mobile webview, and v1 defers article-corpus
// news-uniqueness enrichment. The screening engine only calls cosineSimilarity()
// on already-stored vectors, which is trivial pure math, so we implement that for
// real and stub the model-backed generation to a no-op.

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function generateEmbedding() {
  // Not supported on mobile v1 — article embeddings are produced desktop-side.
  return null;
}

module.exports = {
  cosineSimilarity,
  generateEmbedding,
  isReady: () => false,
};
