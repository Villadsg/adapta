/**
 * AIDetectorService - Estimates whether text is AI-generated using token surprisal.
 *
 * Approach: run text through a small causal LM (GPT-2) and compute the per-token
 * surprisal (-log p of the actual token under the model). AI-generated text tends
 * to have:
 *   - Lower mean surprisal (model finds it more predictable)
 *   - Lower variance / "burstiness" (uniformly fluent rather than human-uneven)
 *
 * Output is a probabilistic signal, not a verdict. Reliability climbs with length;
 * recommend at least ~250 tokens of input. Not effective on headlines alone.
 */
class AIDetectorService {
  constructor() {
    this.model = null;
    this.tokenizer = null;
    this.modelName = 'Xenova/gpt2';
    this.maxTokens = 1024; // GPT-2 context limit
    this.isLoading = false;
    this.loadPromise = null;
  }

  async initialize() {
    if (this.model) return;
    if (this.isLoading) return this.loadPromise;

    this.isLoading = true;
    this.loadPromise = this._loadModel();
    try {
      await this.loadPromise;
    } finally {
      this.isLoading = false;
    }
  }

  async _loadModel() {
    console.log(`\n📥 Loading AI-detector model: ${this.modelName}...`);
    const startTime = Date.now();

    const transformers = await import('@huggingface/transformers');
    const { AutoTokenizer, AutoModelForCausalLM, env } = transformers;

    env.allowLocalModels = false;
    env.useBrowserCache = false;
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.simd = false;

    this.tokenizer = await AutoTokenizer.from_pretrained(this.modelName);
    this.model = await AutoModelForCausalLM.from_pretrained(this.modelName, {
      dtype: 'fp32',
    });

    const loadTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✓ AI-detector loaded in ${loadTime}s (${this.modelName})\n`);
  }

  /**
   * Score a piece of text for AI-likeness via surprisal statistics.
   * @param {string} text
   * @returns {Promise<{
   *   tokenCount: number,
   *   meanSurprisal: number,
   *   perplexity: number,
   *   surprisalStdDev: number,
   *   burstiness: number,
   *   aiLikelihood: number,
   *   confidence: 'low'|'medium'|'high',
   *   note?: string
   * }>}
   */
  async score(text) {
    await this.initialize();

    if (!text || text.trim().length === 0) {
      throw new Error('Cannot score empty text');
    }

    const encoded = await this.tokenizer(text, {
      return_tensors: 'js',
      truncation: true,
      max_length: this.maxTokens,
    });

    const inputIds = encoded.input_ids;
    const seqLen = inputIds.dims[1];

    if (seqLen < 2) {
      throw new Error('Text too short to score (need ≥2 tokens)');
    }

    const output = await this.model(encoded);
    const logits = output.logits; // [1, seqLen, vocabSize]
    const vocabSize = logits.dims[2];
    const logitsData = logits.data;
    const idsData = inputIds.data;

    // For each position i in [0, seqLen-2], predict token at i+1.
    const surprisals = [];
    for (let i = 0; i < seqLen - 1; i++) {
      const offset = i * vocabSize;
      const targetId = Number(idsData[i + 1]);

      // log-softmax via max-subtraction for numerical stability
      let maxLogit = -Infinity;
      for (let v = 0; v < vocabSize; v++) {
        const l = logitsData[offset + v];
        if (l > maxLogit) maxLogit = l;
      }
      let sumExp = 0;
      for (let v = 0; v < vocabSize; v++) {
        sumExp += Math.exp(logitsData[offset + v] - maxLogit);
      }
      const logZ = maxLogit + Math.log(sumExp);
      const targetLogit = logitsData[offset + targetId];
      const logProb = targetLogit - logZ;
      surprisals.push(-logProb);
    }

    const n = surprisals.length;
    const mean = surprisals.reduce((a, b) => a + b, 0) / n;
    const variance = surprisals.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);
    const perplexity = Math.exp(mean);

    // Heuristic AI-likelihood score in [0,1]. Calibration is approximate —
    // GPT-2 finds AI text more predictable (lower mean) and more uniform (lower stdDev).
    // These thresholds are empirical rules-of-thumb from the DetectGPT/GPTZero literature
    // and should be re-tuned against your own labelled data when available.
    const meanScore = clamp01((4.5 - mean) / 2.5);     // 1 if mean≤2, 0 if mean≥4.5
    const burstScore = clamp01((2.0 - stdDev) / 1.5);  // 1 if stdDev≤0.5, 0 if stdDev≥2
    const aiLikelihood = clamp01(0.6 * meanScore + 0.4 * burstScore);

    let confidence = 'high';
    let note;
    if (n < 50) {
      confidence = 'low';
      note = 'Text is too short for reliable detection (<50 tokens).';
    } else if (n < 200) {
      confidence = 'medium';
      note = 'Limited tokens; treat result as a weak signal.';
    }

    return {
      tokenCount: n + 1,
      meanSurprisal: round(mean, 3),
      perplexity: round(perplexity, 2),
      surprisalStdDev: round(stdDev, 3),
      burstiness: round(variance, 3),
      aiLikelihood: round(aiLikelihood, 3),
      confidence,
      ...(note ? { note } : {}),
    };
  }

  isReady() {
    return this.model !== null;
  }
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function round(x, digits) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

const aiDetectorService = new AIDetectorService();
module.exports = aiDetectorService;
