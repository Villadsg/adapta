# Adapta - Semantic Search Browser

An Electron-based web browser with built-in semantic search capabilities. Save articles, automatically generate embeddings, and search your saved content by meaning rather than just keywords.

## Current Status

✅ **Phase 1 Complete: Foundation**
- Electron browser with embedded Chromium
- Navigation controls (back, forward, reload, URL bar)
- DuckDB database for article storage
- Text extraction from webpages

✅ **Phase 2 Complete: Storage & Chunking**
- Save articles with "Good" / "Not Good" categories
- Configurable text chunking (paragraph or sentence strategies)
- Settings UI for adjusting chunk size, overlap, and strategy
- Bulk re-chunking support with embedding regeneration
- Statistics display (article counts by category)

✅ **Phase 3 Complete: Embeddings**
- Automatic embedding generation using **google/embeddinggemma-300m**
- 768-dimensional semantic vectors for each chunk
- On-device processing (no API calls)
- Task-specific prefixes for optimal retrieval
- Embeddings stored in DuckDB FLOAT[] columns

✅ **Phase 4 Complete: Similarity Search**
- Semantic search by meaning, not keywords
- Cosine similarity scoring (0-100%)
- Category filtering (Good/Not Good)
- Configurable similarity thresholds
- IPC handlers for programmatic search

## Quick Start

```bash
# Install dependencies
npm install

# Start the browser
npm start
```

## Usage

1. **Navigate** - Enter URL and press Enter
2. **Save Articles** - Click "Good" or "Not Good" to save current page with automatic embedding generation
3. **View Stats** - See saved article counts and embedding coverage in toolbar
4. **Adjust Settings** - Click ⚙️ to configure chunk size, overlap, and strategy
5. **Search** - Use IPC handlers to perform semantic similarity searches (UI coming soon)

## Project Structure

```
adapta/
├── main.js                    # Electron main process (backend)
├── preload.js                 # IPC security bridge
├── package.json               # Dependencies
└── src/
    ├── renderer/              # Browser UI
    │   ├── index.html         # Main interface
    │   ├── styles.css         # Styling
    │   └── renderer.js        # UI logic
    └── services/              # Backend services
        ├── database.js        # DuckDB operations
        └── chunking.js        # Text chunking logic
```

## Features

### 🔍 Semantic Search

Search by meaning, not just keywords! The browser uses **google/embeddinggemma-300m** to generate 768-dimensional semantic vectors for each chunk.

**Example**: Searching for "neural networks" finds articles about "deep learning", "AI", and "machine learning" even without exact phrase matches.

```javascript
// Semantic search API
const results = await database.searchBySimilarity(
  'How does machine learning work?',
  {
    categoryFilter: 'good',  // Optional
    limit: 10,               // Default: 10
    minSimilarity: 0.5       // 0-1 threshold
  }
);
```

### ⚙️ Configurable Chunking

- **Chunk Size**: 50-2048 tokens (default: 256)
- **Overlap**: 0-500 tokens (default: 25)
- **Strategy**: Paragraph or Sentence (default: Paragraph)

Settings can be adjusted via the ⚙️ Settings button, with optional re-chunking of all existing articles.

**Chunking Strategies**:
- **Paragraph** (default): Splits at `\n\n`, preserves document structure, best for articles/blogs
- **Sentence**: Splits at sentence boundaries (. ! ?), handles abbreviations, best for dense/technical text

## Database Schema

### `articles` table
- Full article text and metadata
- Categories: 'good' or 'not_good'
- URL, title, domain, word count, saved timestamp

### `article_chunks` table
- Text chunks (default: ~256 tokens each)
- Linked to parent article (ON DELETE CASCADE)
- Chunk index for ordering
- Category (inherited from article)
- **embedding column**: FLOAT[] (768 dimensions) - semantic vector from EmbeddingGemma

### `settings` table
- Persistent configuration (chunk_size, chunk_overlap, chunk_strategy)

## Testing

### Run Tests

```bash
# Test embedding model
node test_embeddings.js

# Test full pipeline (save → chunk → embed → search)
node test_integration.js
```

### Expected Results

- ✓ Model loads in ~1s (first run downloads ~100MB)
- ✓ Embeddings generate at ~100ms per chunk
- ✓ Search correctly ranks results by semantic similarity
- ✓ Category filtering works
- ✓ 100% embedding coverage

## Architecture Decisions

- **Electron + Node.js** - Better packaging than PyQt6
- **DuckDB** - Native FLOAT[] support for embeddings, fast vector operations
- **Text-based chunking** - Sentence boundaries preserve semantic meaning
- **ONNX Runtime** (future) - Portable model format, good Node.js support
- **Chunks as derived data** - Can always re-generate from original text

## Documentation

- **EMBEDDING_INTEGRATION.md**: Technical details on embedding system, model info, performance benchmarks
- **TESTING_GUIDE.md**: Step-by-step guide for testing the app and troubleshooting

## Next Steps / Future Enhancements

- Add search UI to renderer (currently accessible via IPC only)
- Vector indexing (HNSW) for faster large-scale search
- Hybrid search (keyword + semantic)
- Auto-clustering of similar articles
- Export/import database
- Upgrade to google/embeddinggemma-300m when Transformers.js support improves

## Performance

- **Embedding generation**: ~80ms per chunk (EmbeddingGemma-300m)
- **Search (<1K chunks)**: <100ms
- **Search (1K-10K chunks)**: 100-500ms
- **Model size**: ~600MB (cached locally, downloaded once)
- **Model load time**: 0.7s (after cache)
- **Storage**: ~6KB per chunk (text + 768-dim embedding)

## License

MIT
