#!/usr/bin/env tsx

/**
 * Migration script to convert existing user data to the new tree structure
 * 
 * This script:
 * 1. Reads existing user profiles and interests
 * 2. Creates corresponding interest nodes in the tree structure
 * 3. Migrates existing key sentences to tree nodes where applicable
 * 4. Preserves all existing performance metrics
 * 
 * Usage: npx tsx migrate_to_tree_structure.ts
 */

import { createClient } from '@supabase/supabase-js';
import { TreeManager } from './src/lib/tree';

// Configuration
const SUPABASE_URL = process.env.PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || ''; // Use service key for migration
const DRY_RUN = process.env.DRY_RUN === 'true'; // Set to true to preview changes without applying them

interface UserProfile {
  id: number;
  user_id: string;
  interests: {
    custom: string[];
  };
  created_at: string;
}

interface KeySentence {
  id: string;
  user_id: string;
  sentence_id: string;
  text: string;
  source: 'user' | 'feedback' | 'llm';
  positive_reactions: number;
  negative_reactions: number;
  times_used: number;
  keywords: string[];
  created_at: string;
  updated_at: string;
}

async function main() {
  console.log('🚀 Starting migration to tree structure...');
  console.log(`📋 DRY RUN: ${DRY_RUN ? 'YES - No changes will be made' : 'NO - Changes will be applied'}`);
  
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('❌ Missing Supabase configuration. Please set PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_KEY');
    process.exit(1);
  }

  // Create Supabase client with service key for admin access
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // Step 1: Get all user profiles with interests
    console.log('📊 Fetching user profiles...');
    const { data: profiles, error: profilesError } = await supabase
      .from('user_profiles')
      .select('*');

    if (profilesError) {
      console.error('❌ Failed to fetch user profiles:', profilesError);
      process.exit(1);
    }

    console.log(`✅ Found ${profiles?.length || 0} user profiles`);

    // Step 2: Get all existing key sentences
    console.log('📊 Fetching existing key sentences...');
    const { data: sentences, error: sentencesError } = await supabase
      .from('user_key_sentences')
      .select('*');

    if (sentencesError) {
      console.error('❌ Failed to fetch key sentences:', sentencesError);
      process.exit(1);
    }

    console.log(`✅ Found ${sentences?.length || 0} existing key sentences`);

    // Step 3: Process each user
    let totalInterestNodes = 0;
    let totalMigratedSentences = 0;
    let processedUsers = 0;

    for (const profile of profiles || []) {
      console.log(`\n👤 Processing user: ${profile.user_id}`);
      
      const customInterests = profile.interests?.custom || [];
      if (customInterests.length === 0) {
        console.log('⏭️ No custom interests found, skipping...');
        continue;
      }

      console.log(`🎯 Found ${customInterests.length} interests: ${customInterests.join(', ')}`);

      if (!DRY_RUN) {
        // Create tree manager for this user
        const treeManager = new TreeManager(supabase, profile.user_id);

        // Create interest nodes
        for (const interest of customInterests) {
          console.log(`  ➕ Creating interest node: "${interest}"`);
          
          const result = await treeManager.createInterestNode(interest, [interest]);
          
          if (result.success) {
            console.log(`    ✅ Created: ${result.nodeId}`);
            totalInterestNodes++;
          } else if (result.error?.includes('duplicate') || result.error?.includes('unique')) {
            console.log(`    ℹ️ Already exists: ${interest}`);
          } else {
            console.error(`    ❌ Failed: ${result.error}`);
          }
        }

        // Migrate existing key sentences for this user
        const userSentences = sentences?.filter(s => s.user_id === profile.user_id) || [];
        console.log(`  📝 Migrating ${userSentences.length} existing key sentences...`);

        for (const sentence of userSentences) {
          // Skip initial sentences (they'll be recreated as interest nodes)
          if (sentence.sentence_id.startsWith('init_')) {
            console.log(`    ⏭️ Skipping initial sentence: ${sentence.text}`);
            continue;
          }

          // Try to find a matching interest node as parent
          let parentNodeId: string | null = null;
          
          // Look for keyword overlap with interests
          for (const interest of customInterests) {
            const interestLower = interest.toLowerCase();
            const sentenceKeywords = sentence.keywords.map((k: string) => k.toLowerCase());
            const sentenceText = sentence.text.toLowerCase();
            
            if (sentenceKeywords.includes(interestLower) || sentenceText.includes(interestLower)) {
              parentNodeId = `interest_${interest.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`;
              break;
            }
          }

          // If no clear parent, use the first interest as fallback
          if (!parentNodeId && customInterests.length > 0) {
            const firstInterest = customInterests[0];
            parentNodeId = `interest_${firstInterest.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`;
          }

          if (parentNodeId && sentence.source === 'feedback') {
            console.log(`    🔗 Migrating feedback sentence to tree: "${sentence.text.substring(0, 50)}..."`);
            
            // Create as news node (since it came from feedback)
            const newsResult = await treeManager.createNewsNode(
              parentNodeId,
              sentence.text,
              '', // No URL available from legacy sentences
              sentence.text, // Use text as snippet
              sentence.keywords,
              {
                migratedFrom: 'key_sentence',
                originalSentenceId: sentence.sentence_id,
                legacyMetrics: {
                  positiveReactions: sentence.positive_reactions,
                  negativeReactions: sentence.negative_reactions,
                  timesUsed: sentence.times_used
                }
              }
            );

            if (newsResult.success) {
              // Update the metrics to match legacy data
              await supabase
                .from('news_interest_tree')
                .update({
                  positive_reactions: sentence.positive_reactions,
                  negative_reactions: sentence.negative_reactions,
                  times_selected: sentence.times_used
                })
                .eq('user_id', profile.user_id)
                .eq('node_id', newsResult.nodeId);

              console.log(`      ✅ Migrated as news node: ${newsResult.nodeId}`);
              totalMigratedSentences++;
            } else {
              console.error(`      ❌ Failed to migrate: ${newsResult.error}`);
            }
          }
        }
      } else {
        console.log(`  📋 DRY RUN: Would create ${customInterests.length} interest nodes`);
        totalInterestNodes += customInterests.length;
        
        const userSentences = sentences?.filter(s => s.user_id === profile.user_id) || [];
        const feedbackSentences = userSentences.filter(s => s.source === 'feedback' && !s.sentence_id.startsWith('init_'));
        console.log(`  📋 DRY RUN: Would migrate ${feedbackSentences.length} feedback sentences`);
        totalMigratedSentences += feedbackSentences.length;
      }

      processedUsers++;
    }

    // Summary
    console.log('\n📊 Migration Summary:');
    console.log(`👥 Users processed: ${processedUsers}`);
    console.log(`🎯 Interest nodes ${DRY_RUN ? 'would be created' : 'created'}: ${totalInterestNodes}`);
    console.log(`📝 Key sentences ${DRY_RUN ? 'would be migrated' : 'migrated'}: ${totalMigratedSentences}`);

    if (!DRY_RUN) {
      console.log('\n✅ Migration completed successfully!');
      console.log('\n📋 Next steps:');
      console.log('1. Test the new tree-based content discovery');
      console.log('2. Monitor user feedback to ensure the tree structure is working correctly');
      console.log('3. Consider archiving old key sentences after confirming tree structure works well');
    } else {
      console.log('\n📋 DRY RUN completed - no changes were made');
      console.log('To apply changes, run: DRY_RUN=false npx tsx migrate_to_tree_structure.ts');
    }

  } catch (error) {
    console.error('💥 Migration failed:', error);
    process.exit(1);
  }
}

// Helper function to validate environment
function validateEnvironment() {
  const required = ['PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    console.error('Please set them in your .env file or environment');
    process.exit(1);
  }
}

// Run migration if called directly
if (require.main === module) {
  validateEnvironment();
  main().catch(console.error);
}

export { main as runMigration };