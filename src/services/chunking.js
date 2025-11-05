/**
 * Text chunking module for splitting articles into semantic chunks
 * Ported from embeddings.py
 */

/**
 * Approximate token count (rough estimate: 1 token ≈ 0.75 words)
 * For more accuracy, use a proper tokenizer, but this is sufficient for chunking
 *
 * @param {string} text - Text to count tokens for
 * @returns {number} Approximate token count
 */
function countTokensApprox(text) {
  const words = text.split(/\s+/).length;
  return Math.floor(words * 1.33); // Convert words to approximate tokens
}

/**
 * Split text into sentences using simple regex
 * Handles common sentence endings: . ! ?
 *
 * @param {string} text - Text to split into sentences
 * @returns {string[]} Array of sentences
 */
function splitIntoSentences(text) {
  // Replace common abbreviations to avoid false splits
  text = text.replace(/\bDr\./g, 'Dr');
  text = text.replace(/\bMr\./g, 'Mr');
  text = text.replace(/\bMrs\./g, 'Mrs');
  text = text.replace(/\bMs\./g, 'Ms');
  text = text.replace(/\be\.g\./g, 'eg');
  text = text.replace(/\bi\.e\./g, 'ie');

  // Split on sentence boundaries
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Split text into paragraphs (by double newlines)
 *
 * @param {string} text - Text to split into paragraphs
 * @returns {string[]} Array of paragraphs
 */
function splitIntoParagraphs(text) {
  // Split by double newlines (or more)
  const paragraphs = text.split(/\n\s*\n+/);
  return paragraphs.map(p => p.trim()).filter(p => p.length > 0);
}

/**
 * Split text into overlapping chunks at sentence boundaries
 *
 * @param {string} text - The main text content to chunk
 * @param {string} title - Optional title to prepend to each chunk for context
 * @param {number} chunkSize - Target chunk size in tokens (default: 512)
 * @param {number} overlap - Number of tokens to overlap between chunks (default: 50)
 * @returns {string[]} Array of text chunks, each prepended with title if provided
 */
function chunkText(text, title = '', chunkSize = 512, overlap = 50) {
  if (!text || !text.trim()) {
    return [];
  }

  // Prepare title prefix
  let titlePrefix = title && title.trim() ? `${title}\n\n` : '';
  let titleTokens = countTokensApprox(titlePrefix);

  // Adjust chunk size to account for title
  let effectiveChunkSize = chunkSize - titleTokens;
  if (effectiveChunkSize < 100) {
    // Title is too long, truncate it
    titlePrefix = titlePrefix.substring(0, 200) + '...\n\n';
    titleTokens = countTokensApprox(titlePrefix);
    effectiveChunkSize = chunkSize - titleTokens;
  }

  // Split into sentences
  const sentences = splitIntoSentences(text);

  if (sentences.length === 0) {
    // If sentence splitting fails, return the whole text as one chunk
    return [titlePrefix + text.substring(0, 3000)]; // Limit to reasonable length
  }

  const chunks = [];
  let currentChunk = [];
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentenceTokens = countTokensApprox(sentence);

    // If adding this sentence would exceed chunk size
    if (currentTokens + sentenceTokens > effectiveChunkSize && currentChunk.length > 0) {
      // Save current chunk
      const chunkText = titlePrefix + currentChunk.join(' ');
      chunks.push(chunkText);

      // Start new chunk with overlap
      // Keep last few sentences for overlap
      const overlapText = [];
      let overlapTokens = 0;
      for (let i = currentChunk.length - 1; i >= 0; i--) {
        const prevSentence = currentChunk[i];
        const prevTokens = countTokensApprox(prevSentence);
        if (overlapTokens + prevTokens <= overlap) {
          overlapText.unshift(prevSentence);
          overlapTokens += prevTokens;
        } else {
          break;
        }
      }

      currentChunk = overlapText;
      currentTokens = overlapTokens;
    }

    // Add sentence to current chunk
    currentChunk.push(sentence);
    currentTokens += sentenceTokens;
  }

  // Add final chunk if there's content
  if (currentChunk.length > 0) {
    const chunkText = titlePrefix + currentChunk.join(' ');
    chunks.push(chunkText);
  }

  return chunks;
}

/**
 * Split text into overlapping chunks at paragraph boundaries
 * Falls back to sentence-based chunking if paragraphs are too large
 *
 * @param {string} text - The main text content to chunk
 * @param {string} title - Optional title to prepend to each chunk for context
 * @param {number} chunkSize - Target chunk size in tokens (default: 512)
 * @param {number} overlap - Number of tokens to overlap between chunks (default: 50)
 * @returns {string[]} Array of text chunks, each prepended with title if provided
 */
function chunkTextByParagraph(text, title = '', chunkSize = 512, overlap = 50) {
  if (!text || !text.trim()) {
    return [];
  }

  // Prepare title prefix
  let titlePrefix = title && title.trim() ? `${title}\n\n` : '';
  let titleTokens = countTokensApprox(titlePrefix);

  // Adjust chunk size to account for title
  let effectiveChunkSize = chunkSize - titleTokens;
  if (effectiveChunkSize < 100) {
    // Title is too long, truncate it
    titlePrefix = titlePrefix.substring(0, 200) + '...\n\n';
    titleTokens = countTokensApprox(titlePrefix);
    effectiveChunkSize = chunkSize - titleTokens;
  }

  // Split into paragraphs
  const paragraphs = splitIntoParagraphs(text);

  if (paragraphs.length === 0) {
    // If paragraph splitting fails, fall back to sentence-based
    return chunkText(text, title, chunkSize, overlap);
  }

  const chunks = [];
  let currentChunk = [];
  let currentTokens = 0;

  for (const paragraph of paragraphs) {
    const paragraphTokens = countTokensApprox(paragraph);

    // If a single paragraph is too large, chunk it by sentences
    if (paragraphTokens > effectiveChunkSize) {
      // Save current chunk if it has content
      if (currentChunk.length > 0) {
        chunks.push(titlePrefix + currentChunk.join('\n\n'));
        currentChunk = [];
        currentTokens = 0;
      }

      // Chunk the large paragraph by sentences
      const sentenceChunks = chunkText(paragraph, '', chunkSize - titleTokens, overlap);
      for (const sentenceChunk of sentenceChunks) {
        chunks.push(titlePrefix + sentenceChunk);
      }
      continue;
    }

    // If adding this paragraph would exceed chunk size
    if (currentTokens + paragraphTokens > effectiveChunkSize && currentChunk.length > 0) {
      // Save current chunk
      chunks.push(titlePrefix + currentChunk.join('\n\n'));

      // Start new chunk with overlap
      // Keep last few paragraphs for overlap
      const overlapText = [];
      let overlapTokens = 0;
      for (let i = currentChunk.length - 1; i >= 0; i--) {
        const prevParagraph = currentChunk[i];
        const prevTokens = countTokensApprox(prevParagraph);
        if (overlapTokens + prevTokens <= overlap) {
          overlapText.unshift(prevParagraph);
          overlapTokens += prevTokens;
        } else {
          break;
        }
      }

      currentChunk = overlapText;
      currentTokens = overlapTokens;
    }

    // Add paragraph to current chunk
    currentChunk.push(paragraph);
    currentTokens += paragraphTokens;
  }

  // Add final chunk if there's content
  if (currentChunk.length > 0) {
    chunks.push(titlePrefix + currentChunk.join('\n\n'));
  }

  return chunks;
}

module.exports = {
  countTokensApprox,
  splitIntoSentences,
  splitIntoParagraphs,
  chunkText,
  chunkTextByParagraph
};
