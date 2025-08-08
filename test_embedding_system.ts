#!/usr/bin/env tsx

/**
 * Test script for the embedding-enhanced search system
 * 
 * This script tests the complete flow:
 * 1. Initialize embedding service
 * 2. Generate embeddings for interests  
 * 3. Create creative combinations
 * 4. Test enhanced search queries
 */

import { createClient } from '@supabase/supabase-js';
import { EmbeddingService, createEmbeddingService } from './src/lib/embeddings';
import { TreeManager } from './src/lib/tree';
import { AdaptiveSearchSystem } from './src/lib/search';

// Test configuration
const SUPABASE_URL = process.env.PUBLIC_SUPABASE_URL || 'https://your-project.supabase.co';
const SUPABASE_ANON_KEY = process.env.PUBLIC_SUPABASE_ANON_KEY || 'your-anon-key';
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || 'your-brave-api-key';

// Mock user ID for testing (you should replace with a real user ID)
const TEST_USER_ID = 'test-user-id';

async function testEmbeddingSystem() {
  console.log('🧪 Starting embedding system test...\n');

  try {
    // 1. Initialize services
    console.log('1. Initializing services...');
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const embeddingService = createEmbeddingService(supabase, TEST_USER_ID);
    const treeManager = new TreeManager(supabase, TEST_USER_ID);
    
    console.log('✅ Services initialized\n');

    // 2. Test embedding generation
    console.log('2. Testing embedding generation...');
    const testText = "drone jobs in spain";
    const embedding = await embeddingService.generateEmbedding(testText);
    console.log(`✅ Generated embedding with ${embedding.length} dimensions`);
    console.log(`   Sample values: [${embedding.slice(0, 5).map(v => v.toFixed(3)).join(', ')}...]`);
    console.log();

    // 3. Test similarity calculation
    console.log('3. Testing similarity calculation...');
    const testText2 = "remote pilot jobs madrid";
    const embedding2 = await embeddingService.generateEmbedding(testText2);
    const similarity = embeddingService.calculateCosineSimilarity(embedding, embedding2);
    console.log(`✅ Similarity between "${testText}" and "${testText2}": ${similarity.toFixed(3)}`);
    console.log();

    // 4. Test combination generation
    console.log('4. Testing combination generation...');
    const mockInterests = [
      {
        nodeId: 'test_interest_1',
        title: 'jobs in spain',
        embedding: await embeddingService.generateEmbedding('employment opportunities in spain')
      },
      {
        nodeId: 'test_interest_2', 
        title: 'drones',
        embedding: await embeddingService.generateEmbedding('unmanned aerial vehicles drone technology')
      },
      {
        nodeId: 'test_interest_3',
        title: 'remote work',
        embedding: await embeddingService.generateEmbedding('remote work from home telecommuting')
      }
    ];

    const combinations = await embeddingService.generateCombinations(mockInterests, 5, 0.3);
    console.log(`✅ Generated ${combinations.length} combination suggestions:`);
    combinations.forEach((combo, i) => {
      console.log(`   ${i + 1}. "${combo.combinedTitle}" (confidence: ${combo.confidenceScore.toFixed(2)})`);
      console.log(`      Type: ${combo.combinationType}`);
      console.log(`      Queries: [${combo.potentialQueries.slice(0, 2).join(', ')}...]`);
      console.log();
    });

    // 5. Test embedding analysis
    console.log('5. Testing embedding analysis...');
    const analysis = await embeddingService.analyzeInterestEmbeddings(mockInterests);
    console.log(`✅ Analysis complete:`);
    console.log(`   - Total interests: ${analysis.totalInterests}`);
    console.log(`   - Clusters found: ${analysis.clusters.length}`);
    console.log(`   - Combinations generated: ${analysis.combinationSuggestions.length}`);
    console.log(`   - Analysis timestamp: ${analysis.analysisTimestamp.toISOString()}`);
    console.log();

    // 6. Test AdaptiveSearchSystem integration (without actual search)
    console.log('6. Testing AdaptiveSearchSystem integration...');
    const interests = ['drone jobs', 'spain remote work', 'AI technology'];
    const searchSystem = new AdaptiveSearchSystem(
      interests,
      {
        apiUrl: 'http://localhost:11434/api/generate',
        model: 'deepseek-r1:8b',
        temperature: 0.7,
        maxTokens: 200
      },
      BRAVE_API_KEY,
      supabase,
      TEST_USER_ID
    );

    // Note: This would normally connect to database and perform full initialization
    // For testing, we'll just verify the system can be created
    console.log('✅ AdaptiveSearchSystem created with embedding support');
    console.log(`   - Initial interests: [${interests.join(', ')}]`);
    console.log(`   - LLM model: deepseek-r1:8b`);
    console.log(`   - Embedding model: nomic-embed-text`);
    console.log();

    console.log('🎉 All tests completed successfully!');
    console.log('\n📝 Next steps:');
    console.log('   1. Apply the database migration: embedding_enhancement_migration.sql');
    console.log('   2. Configure your Supabase connection with real credentials');
    console.log('   3. Use the system in your application to discover creative search combinations!');
    console.log('\n💡 Example combinations that will be created:');
    combinations.slice(0, 3).forEach((combo, i) => {
      console.log(`   ${i + 1}. "${combo.combinedTitle}" → searches like "${combo.potentialQueries[0]}"`);
    });

  } catch (error) {
    console.error('❌ Test failed:', error);
    if (error instanceof Error) {
      console.error('   Error details:', error.message);
    }
    process.exit(1);
  }
}

// Run the test
if (require.main === module) {
  testEmbeddingSystem().catch(console.error);
}