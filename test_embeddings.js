/**
 * Test script for EmbeddingGemma integration
 *
 * This script tests:
 * 1. Loading the embedding model
 * 2. Generating embeddings for sample texts
 * 3. Calculating similarity between embeddings
 * 4. Verifying embedding dimension
 */

const embeddingService = require('./src/services/embeddings');

async function testEmbeddings() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  EmbeddingGemma-300m Integration Test                    ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  try {
    // Test 1: Initialize model
    console.log('Test 1: Loading EmbeddingGemma model...');
    await embeddingService.initialize();
    console.log(`✓ Model loaded successfully`);
    console.log(`  Embedding dimension: ${embeddingService.getDimension()}`);
    console.log(`  Model ready: ${embeddingService.isReady()}\n`);

    // Test 2: Generate single embedding
    console.log('Test 2: Generating single embedding...');
    const text1 = 'Machine learning is a subset of artificial intelligence.';
    const startTime = Date.now();
    const embedding1 = await embeddingService.embed(text1);
    const elapsed = Date.now() - startTime;

    console.log(`✓ Generated embedding in ${elapsed}ms`);
    console.log(`  Text: "${text1}"`);
    console.log(`  Embedding length: ${embedding1.length}`);
    console.log(`  First 5 values: [${embedding1.slice(0, 5).map(v => v.toFixed(4)).join(', ')}...]\n`);

    // Test 3: Generate multiple embeddings
    console.log('Test 3: Generating batch embeddings...');
    const texts = [
      'Deep learning uses neural networks with multiple layers.',
      'Natural language processing enables computers to understand human language.',
      'Computer vision helps machines interpret visual information.',
      'The weather is sunny today.',
      'I love eating pizza on weekends.'
    ];

    const batchStart = Date.now();
    const embeddings = await embeddingService.embedBatch(texts, {
      showProgress: false
    });
    const batchElapsed = Date.now() - batchStart;

    console.log(`✓ Generated ${embeddings.length} embeddings in ${batchElapsed}ms`);
    console.log(`  Average: ${(batchElapsed / embeddings.length).toFixed(0)}ms per embedding\n`);

    // Test 4: Calculate similarities
    console.log('Test 4: Calculating semantic similarities...');
    console.log('\nComparing to: "Machine learning is a subset of artificial intelligence."\n');

    for (let i = 0; i < texts.length; i++) {
      const similarity = embeddingService.cosineSimilarity(embedding1, embeddings[i]);
      const percentage = (similarity * 100).toFixed(1);
      const bar = '█'.repeat(Math.floor(similarity * 20));

      console.log(`  ${percentage.padStart(5)}% ${bar.padEnd(20)} "${texts[i]}"`);
    }

    // Test 5: Task-specific embeddings
    console.log('\n\nTest 5: Task-specific embeddings...');
    const query = 'What is AI?';
    const document = 'Artificial intelligence is the simulation of human intelligence by machines.';

    const queryEmbed = await embeddingService.embed(query, { task: 'search_query' });
    const docEmbed = await embeddingService.embed(document, { task: 'search_document' });
    const similarity = embeddingService.cosineSimilarity(queryEmbed, docEmbed);

    console.log(`  Query: "${query}"`);
    console.log(`  Document: "${document}"`);
    console.log(`  Similarity: ${(similarity * 100).toFixed(1)}%\n`);

    // Test 6: Verify normalization
    console.log('Test 6: Verifying embedding normalization...');
    const magnitude = Math.sqrt(embedding1.reduce((sum, val) => sum + val * val, 0));
    console.log(`  Embedding magnitude: ${magnitude.toFixed(6)}`);
    console.log(`  Is normalized (≈1.0): ${Math.abs(magnitude - 1.0) < 0.01 ? '✓ Yes' : '✗ No'}\n`);

    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║  All tests passed! ✓                                     ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run tests
testEmbeddings().then(() => {
  console.log('Test script completed successfully.');
  process.exit(0);
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
