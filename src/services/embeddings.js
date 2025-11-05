/**
 * EmbeddingService - Generates semantic embeddings using google/embeddinggemma-300m
 *
 * This service uses the ONNX-converted EmbeddingGemma model via Transformers.js.
 * Model: onnx-community/embeddinggemma-300m-ONNX
 * Embedding dimension: 768 (supports Matryoshka truncation to 512, 256, 128)
 */
class EmbeddingService {
  constructor() {
    this.model = null;
    this.pipeline = null;
    this.env = null;
    // Using EmbeddingGemma-300m - state-of-the-art lightweight embedding model
    this.modelName = 'onnx-community/embeddinggemma-300m-ONNX';
    this.embeddingDim = 768;
    this.isLoading = false;
    this.loadPromise = null;
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

      // Configure Transformers.js - use WASM backend with Electron-safe settings
      this.env.allowLocalModels = false;
      this.env.useBrowserCache = false;

      // IMPORTANT: Use single thread for Electron compatibility
      // Multi-threading can cause SIGTRAP crashes in Electron's sandboxed environment
      this.env.backends.onnx.wasm.numThreads = 1;

      // Disable WASM SIMD if available (can cause crashes in some Electron versions)
      this.env.backends.onnx.wasm.simd = false;

      // Create feature extraction pipeline
      // NOTE: EmbeddingGemma activations don't support fp16 - use fp32, q8, or q4
      // Using fp32 for maximum stability in Electron (larger but more reliable)
      this.model = await this.pipeline('feature-extraction', this.modelName, {
        dtype: 'fp32', // Use full precision for Electron stability
      });

      const loadTime = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`✓ Embedding model loaded in ${loadTime}s`);
      console.log(`  Model: ${this.modelName}`);
      console.log(`  Embedding dimension: ${this.embeddingDim}\n`);
    } catch (error) {
      console.error('❌ Failed to load embedding model:', error);
      throw new Error(`Failed to load embedding model: ${error.message}`);
    }
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
      // Format input with task-specific prefix for EmbeddingGemma
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

      // Truncate to max context length (EmbeddingGemma supports 2048 tokens)
      const maxChars = 2048 * 4; // Approximate chars per token
      const truncatedText = formattedText.length > maxChars
        ? formattedText.substring(0, maxChars)
        : formattedText;

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

    const embeddings = [];
    const { onProgress, showProgress = true } = options;
    const startTime = Date.now();

    if (showProgress) {
      console.log(`\n🔄 Generating embeddings for ${texts.length} chunks...`);
    }

    for (let i = 0; i < texts.length; i++) {
      const embedding = await this.embed(texts[i], options);
      embeddings.push(embedding);

      if (onProgress) {
        onProgress(i + 1, texts.length);
      }

      if (showProgress && (i + 1) % 10 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`   Progress: ${i + 1}/${texts.length} (${elapsed}s)`);
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
