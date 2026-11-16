/**
 * EmbeddingService - Generates semantic embeddings using google/embeddinggemma-2
 *
 * This service uses the ONNX-converted EmbeddingGemma 2 model via Transformers.js.
 * Model: onnx-community/embeddinggemma-2-ONNX (text-only backbone, 270M params)
 * Embedding dimension: 768 (supports Matryoshka truncation to 512, 256, 128)
 * Context window: 8192 tokens
 */
class EmbeddingService {
  constructor() {
    this.model = null;
    this.pipeline = null;
    this.env = null;
    // EmbeddingGemma 2 text-only backbone (270M) — same 768-dim space conventions
    // as the previous embeddinggemma-300m. Override via env for A/B testing.
    this.modelName = process.env.EMBEDDING_MODEL || 'onnx-community/embeddinggemma-2-ONNX';
    // q8 (~270MB) is quality-equivalent to fp32 on the classifier calibration
    // set and 4x lighter. Never fp16 — EmbeddingGemma activations produce
    // NaNs (both generations).
    this.dtype = process.env.EMBEDDING_DTYPE || 'q8';
    this.embeddingDim = 768;
    // embeddinggemma-2 supports 8K context; the 300m model only 2K, so respect
    // the limit when the model is overridden back to it.
    this.maxContextTokens = /embeddinggemma-300m/.test(this.modelName) ? 2048 : 8192;
    // Batch inference bounds: headlines batch 16-at-a-time while long article
    // bodies embed alone, keeping WASM memory usage predictable.
    this.maxBatchSize = 16;
    this.maxBatchChars = 12000;
    this.isLoading = false;
    this.loadPromise = null;
  }

  /**
   * Stable identity of the loaded embedding space — used to key caches
   * (anchor embeddings on disk, model version in the database).
   * @returns {string}
   */
  getCacheKey() {
    return `${this.modelName}|${this.dtype}`;
  }

  /**
   * Initialize the embedding model (lazy loading)
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.model) {
      return; // Already loaded
    }

    if (this.isLoading) {
      // Wait for existing load to complete
      return this.loadPromise;
    }

    this.isLoading = true;
    this.loadPromise = this._loadModel();

    try {
      await this.loadPromise;
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Internal method to load the model
   * @private
   */
  async _loadModel() {
    console.log(`\n📥 Loading embedding model: ${this.modelName}...`);
    console.log('   (First run will download model, subsequent runs use cache)');
    const startTime = Date.now();

    try {
      // Dynamic import for ES Module compatibility with Electron
      const transformers = await import('@huggingface/transformers');
      this.pipeline = transformers.pipeline;
      this.env = transformers.env;

      // Configure Transformers.js - conservative settings for Electron compatibility.
      // (v4 no longer exposes numThreads/simd on the wasm env; guard so these
      // still apply if running under v3.)
      this.env.allowLocalModels = false;
      this.env.useBrowserCache = false;
      const wasm = this.env.backends?.onnx?.wasm;
      if (wasm) {
        if ('numThreads' in wasm) wasm.numThreads = 1;
        if ('simd' in wasm) wasm.simd = false;
      }

      // Create feature extraction pipeline
      // NOTE: EmbeddingGemma activations don't support fp16 or derivatives — use fp32 or q8
      this.model = await this.pipeline('feature-extraction', this.modelName, {
        dtype: this.dtype,
      });

      const loadTime = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`✓ Embedding model loaded in ${loadTime}s`);
      console.log(`  Model: ${this.modelName} (dtype: ${this.dtype})`);
      console.log(`  Embedding dimension: ${this.embeddingDim}\n`);
    } catch (error) {
      console.error('❌ Failed to load embedding model:', error);
      throw new Error(`Failed to load embedding model: ${error.message}`);
    }
  }

  /**
   * Format raw text into EmbeddingGemma's task-specific input format with truncation.
   * @param {string} text - Raw input text
   * @param {Object} options - Embedding options ({ task, title })
   * @returns {string} Formatted and truncated input string
   * @private
   */
  _formatInput(text, options = {}) {
    let formattedText;
    const { task, title } = options;

    if (task === 'search_query') {
      // Query format: "task: search result | query: {text}"
      formattedText = `task: search result | query: ${text}`;
    } else {
      // Document format: "title: {title} | text: {text}"
      const titleText = title || 'none';
      formattedText = `title: ${titleText} | text: ${text}`;
    }

    const maxChars = this.maxContextTokens * 4; // Approximate chars per token
    return formattedText.length > maxChars
      ? formattedText.substring(0, maxChars)
      : formattedText;
  }

  /**
   * Generate embedding for a single text
   * @param {string} text - Input text to embed
   * @param {Object} options - Embedding options
   * @param {string} options.task - Task type for prefix (e.g., 'search_document', 'search_query')
   * @param {string} options.title - Document title (optional, for documents)
   * @returns {Promise<number[]>} Embedding vector (768-dim)
   */
  async embed(text, options = {}) {
    await this.initialize();

    if (!text || text.trim().length === 0) {
      throw new Error('Cannot generate embedding for empty text');
    }

    try {
      const truncatedText = this._formatInput(text, options);

      // Generate embedding with mean pooling and normalization
      const output = await this.model(truncatedText, {
        pooling: 'mean',
        normalize: true,
      });

      // Convert to regular array
      const embedding = Array.from(output.data);

      return embedding;
    } catch (error) {
      console.error('❌ Error generating embedding:', error);
      throw new Error(`Failed to generate embedding: ${error.message}`);
    }
  }

  /**
   * Generate embeddings for multiple texts in batch
   *
   * Texts are formatted up front, then grouped into inference batches bounded
   * by both count and total length (short headlines run 16-at-a-time through
   * a single tokenized session run; long article bodies run alone).
   *
   * @param {string[]} texts - Array of texts to embed
   * @param {Object} options - Batch processing options
   * @param {string} options.task - Task type prefix
   * @param {Function} options.onProgress - Progress callback (current, total)
   * @param {boolean} options.showProgress - Show progress in console (default: true)
   * @returns {Promise<number[][]>} Array of embedding vectors
   */
  async embedBatch(texts, options = {}) {
    await this.initialize();

    if (!texts || texts.length === 0) {
      return [];
    }

    const { onProgress, showProgress = true } = options;
    const startTime = Date.now();

    if (showProgress) {
      console.log(`\n🔄 Generating embeddings for ${texts.length} chunks...`);
    }

    const formatted = texts.map(t => {
      if (!t || t.trim().length === 0) {
        throw new Error('Cannot generate embedding for empty text');
      }
      return this._formatInput(t, options);
    });
    const embeddings = new Array(formatted.length);

    let i = 0;
    while (i < formatted.length) {
      // Grow the batch until either bound is hit
      const batch = [formatted[i]];
      let batchChars = formatted[i].length;
      let j = i + 1;
      while (j < formatted.length && batch.length < this.maxBatchSize) {
        const nextChars = batchChars + formatted[j].length;
        if (nextChars > this.maxBatchChars) break;
        batch.push(formatted[j]);
        batchChars = nextChars;
        j++;
      }

      const output = await this.model(batch, {
        pooling: 'mean',
        normalize: true,
      });
      const rows = output.tolist();
      for (let b = 0; b < batch.length; b++) {
        embeddings[i + b] = rows[b];
        if (onProgress) {
          onProgress(i + b + 1, texts.length);
        }
      }

      i = j;

      if (showProgress && i % 10 === 0 && i < formatted.length) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`   Progress: ${i}/${texts.length} (${elapsed}s)`);
      }
    }

    if (showProgress) {
      const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
      const avgTime = (parseFloat(totalTime) / texts.length * 1000).toFixed(0);
      console.log(`✓ Generated ${texts.length} embeddings in ${totalTime}s (avg ${avgTime}ms/chunk)\n`);
    }

    return embeddings;
  }

  /**
   * Calculate cosine similarity between two embeddings
   * @param {number[]} embedding1 - First embedding vector
   * @param {number[]} embedding2 - Second embedding vector
   * @returns {number} Cosine similarity score (-1 to 1, typically 0 to 1 for normalized vectors)
   */
  cosineSimilarity(embedding1, embedding2) {
    if (embedding1.length !== embedding2.length) {
      throw new Error('Embeddings must have the same dimension');
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < embedding1.length; i++) {
      dotProduct += embedding1[i] * embedding2[i];
      norm1 += embedding1[i] * embedding1[i];
      norm2 += embedding2[i] * embedding2[i];
    }

    const similarity = dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));

    // Clamp to [-1, 1] to handle floating point errors
    return Math.max(-1, Math.min(1, similarity));
  }

  /**
   * Get the embedding dimension size
   * @returns {number} Embedding dimension (768 for EmbeddingGemma)
   */
  getDimension() {
    return this.embeddingDim;
  }

  /**
   * Check if model is loaded
   * @returns {boolean} True if model is ready
   */
  isReady() {
    return this.model !== null;
  }
}

// Export singleton instance
const embeddingService = new EmbeddingService();
module.exports = embeddingService;
