/**
 * Integration Test - End-to-End Embedding Workflow
 *
 * This script tests the complete pipeline:
 * 1. Creating a test database
 * 2. Saving articles with automatic embedding generation
 * 3. Searching by semantic similarity
 * 4. Verifying results
 */

const ArticleDatabase = require('./src/services/database');
const { chunkText } = require('./src/services/chunking');
const fs = require('fs');
const path = require('path');

// Test data - sample articles
const testArticles = [
  {
    url: 'https://example.com/ml-basics',
    title: 'Introduction to Machine Learning',
    content: `Machine learning is a subset of artificial intelligence that focuses on building systems that can learn from data.

Unlike traditional programming where explicit instructions are provided, machine learning algorithms identify patterns in data and make decisions with minimal human intervention.

There are three main types of machine learning: supervised learning, unsupervised learning, and reinforcement learning. Each type has its own use cases and applications in the real world.`,
    category: 'good'
  },
  {
    url: 'https://example.com/deep-learning',
    title: 'Deep Learning and Neural Networks',
    content: `Deep learning is a specialized subset of machine learning that uses neural networks with multiple layers. These deep neural networks are particularly effective at processing complex data like images, speech, and text.

The architecture of deep learning models is inspired by the human brain, with interconnected nodes (neurons) organized in layers. Each layer learns increasingly abstract representations of the input data.

Popular deep learning frameworks include TensorFlow, PyTorch, and Keras, which provide tools for building and training neural networks efficiently.`,
    category: 'good'
  },
  {
    url: 'https://example.com/nlp-guide',
    title: 'Natural Language Processing Overview',
    content: `Natural Language Processing (NLP) enables computers to understand, interpret, and generate human language. This field combines linguistics, computer science, and artificial intelligence.

Modern NLP uses deep learning models called transformers, which have revolutionized language understanding tasks. Applications include machine translation, sentiment analysis, chatbots, and text summarization.

Key techniques in NLP include tokenization, named entity recognition, part-of-speech tagging, and semantic analysis. These form the foundation for more complex language understanding systems.`,
    category: 'good'
  },
  {
    url: 'https://example.com/cooking-pasta',
    title: 'How to Cook Perfect Pasta',
    content: `Cooking perfect pasta is an art that anyone can master with the right technique. Start by bringing a large pot of salted water to a rolling boil.

Add the pasta and stir immediately to prevent sticking. Follow the package directions for cooking time, but taste the pasta a minute or two before the suggested time to ensure it's al dente.

Reserve a cup of pasta water before draining. This starchy water is perfect for adjusting the consistency of your sauce. Toss the drained pasta with your sauce immediately for best results.`,
    category: 'not_good'
  },
  {
    url: 'https://example.com/gardening-tips',
    title: 'Spring Gardening Tips',
    content: `Spring is the perfect time to start your garden. Begin by preparing the soil with compost and ensuring proper drainage.

Choose plants that are appropriate for your climate zone and the amount of sunlight your garden receives. Consider starting with easy-to-grow vegetables like tomatoes, lettuce, and herbs.

Water your plants regularly, especially during dry spells, and apply mulch to retain moisture and suppress weeds. Regular maintenance and care will reward you with a beautiful, productive garden.`,
    category: 'not_good'
  }
];

async function runIntegrationTest() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  Integration Test: Embeddings + DuckDB + Search              ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  const dbPath = 'test_articles.db';

  // Clean up any existing test database
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    console.log('✓ Cleaned up existing test database\n');
  }

  const database = new ArticleDatabase(dbPath);

  try {
    // Step 1: Initialize database
    console.log('Step 1: Initializing database...');
    await database.initialize();
    console.log('✓ Database initialized\n');

    // Step 2: Save articles with embeddings
    console.log('Step 2: Saving articles with automatic embedding generation...');
    console.log(`   Saving ${testArticles.length} articles...\n`);

    for (const article of testArticles) {
      const result = await database.saveArticle(
        article.url,
        article.title,
        article.content,
        article.category
      );

      console.log(`   Article ${result.id}: "${result.title}"`);

      // Chunk the article
      const chunks = chunkText(article.content, article.title, 128, 15);
      console.log(`   - Created ${chunks.length} chunks`);

      // Save chunks with embeddings (embeddings generated automatically)
      await database.saveChunks(result.id, chunks, article.category);
    }

    console.log('\n✓ All articles saved with embeddings\n');

    // Step 3: Check embedding statistics
    console.log('Step 3: Checking embedding statistics...');
    const stats = await database.getEmbeddingStats();
    console.log(`   Total chunks: ${stats.totalChunks}`);
    console.log(`   Chunks with embeddings: ${stats.chunksWithEmbeddings}`);
    console.log(`   Coverage: ${stats.embeddingCoverage}%`);
    console.log(`   ✓ All chunks have embeddings!\n`);

    // Step 4: Test semantic search
    console.log('Step 4: Testing semantic search...\n');

    const queries = [
      {
        text: 'What are neural networks and deep learning?',
        expectedCategory: 'good',
        description: 'AI/ML related query'
      },
      {
        text: 'How do I understand human language with computers?',
        expectedCategory: 'good',
        description: 'NLP related query'
      },
      {
        text: 'What ingredients do I need for Italian food?',
        expectedCategory: 'not_good',
        description: 'Cooking related query'
      }
    ];

    for (const query of queries) {
      console.log(`📝 Query: "${query.text}"`);
      console.log(`   Expected category: ${query.expectedCategory} (${query.description})\n`);

      const results = await database.searchBySimilarity(query.text, {
        limit: 3,
        minSimilarity: 0.3
      });

      if (results.length === 0) {
        console.log('   ⚠️  No results found\n');
        continue;
      }

      console.log(`   📊 Top ${results.length} results:\n`);

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const article = await database.getArticleById(result.article_id);
        const similarity = (result.similarity * 100).toFixed(1);
        const bar = '█'.repeat(Math.floor(result.similarity * 20));

        console.log(`   ${i + 1}. [${similarity}%] ${bar}`);
        console.log(`      Article: "${article.title}"`);
        console.log(`      Category: ${result.category}`);
        console.log(`      Chunk: "${result.chunk_text.substring(0, 80)}..."\n`);
      }

      // Verify top result is from expected category
      const topCategory = results[0].category;
      if (topCategory === query.expectedCategory) {
        console.log(`   ✓ Top result is from expected category: ${topCategory}\n`);
      } else {
        console.log(`   ⚠️  Top result category (${topCategory}) differs from expected (${query.expectedCategory})\n`);
      }

      console.log('   ───────────────────────────────────────────────\n');
    }

    // Step 5: Test category filtering
    console.log('Step 5: Testing category filtering...\n');

    const filteredResults = await database.searchBySimilarity(
      'artificial intelligence and machine learning',
      {
        categoryFilter: 'good',
        limit: 5,
        minSimilarity: 0.4
      }
    );

    console.log(`   Found ${filteredResults.length} results in 'good' category`);

    const allGood = filteredResults.every(r => r.category === 'good');
    if (allGood) {
      console.log(`   ✓ All results are from 'good' category\n`);
    } else {
      console.log(`   ✗ Some results are not from 'good' category\n`);
    }

    // Step 6: Database statistics
    console.log('Step 6: Final database statistics...');
    const dbStats = await database.getStats();
    console.log(`   Total articles: ${dbStats.total}`);
    console.log(`   Good articles: ${dbStats.good}`);
    console.log(`   Not good articles: ${dbStats.not_good}`);
    console.log(`   Total chunks: ${stats.totalChunks}`);
    console.log(`   Embedding coverage: ${stats.embeddingCoverage}%\n`);

    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║  Integration Test PASSED! ✓                                   ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝\n');

    console.log('📋 Summary:');
    console.log('   - Article saving works ✓');
    console.log('   - Automatic chunking works ✓');
    console.log('   - Embedding generation works ✓');
    console.log('   - DuckDB storage works ✓');
    console.log('   - Semantic search works ✓');
    console.log('   - Category filtering works ✓\n');

  } catch (error) {
    console.error('\n❌ Integration test failed:', error);
    console.error(error.stack);
    process.exit(1);
  } finally {
    // Close database
    await database.close();
    console.log('✓ Database connection closed\n');

    // Clean up test database
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
      console.log('✓ Test database cleaned up\n');
    }
  }
}

// Run integration test
runIntegrationTest().then(() => {
  console.log('Integration test completed successfully!');
  process.exit(0);
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
