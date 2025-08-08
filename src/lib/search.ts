import { BraveSearch } from 'brave-search';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { TreeManager, type TreeNode, type TreeFeedback, type NodeSelectionResult } from './tree';
import { EmbeddingService, createEmbeddingService, type CombinationSuggestion, type EmbeddingAnalysis } from './embeddings';

export interface LLMConfig {
  apiUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  relevanceScore?: number;
  contributingNodeIds?: string[]; // Track which tree nodes led to this result
  qualityScore?: number; // Content quality score based on negative keyword matching
  searchQuery?: string; // The query that found this result
}


export interface UserFeedback {
  resultId: string;
  reaction: 'positive' | 'negative';
  timestamp: Date;
  extractedKeywords?: string[];
}

export interface SearchSession {
  results: SearchResult[];
  feedback: UserFeedback[];
  timestamp: Date;
}

/**
 * Enhanced search system with key sentences, feedback learning, and LLM integration
 */
export class AdaptiveSearchSystem {
  private searchHistory: SearchSession[] = [];
  private totalSearches = 0;
  private llmConfig: LLMConfig;
  private braveSearch: BraveSearch;
  private supabase: SupabaseClient | null = null;
  private userId: string | null = null;
  private initialInterests: string[] = [];
  private treeManager: TreeManager | null = null;
  private embeddingService: EmbeddingService | null = null;

  /**
   * Initialize with user's initial interests and LLM configuration
   */
  constructor(
    initialInterests: string[], 
    llmConfig: LLMConfig = {
      apiUrl: 'http://localhost:11434/api/generate',
      model: 'deepseek-r1:8b',
      temperature: 0.7,
      maxTokens: 200
    },
    braveApiKey: string,
    supabase?: SupabaseClient,
    userId?: string
  ) {
    this.llmConfig = llmConfig;
    this.braveSearch = new BraveSearch(braveApiKey);
    this.supabase = supabase || null;
    this.userId = userId || null;
    this.initialInterests = initialInterests;
  }




  /**
   * Communicate with local DeepSeek LLM via Ollama API
   */
  private async callLocalLLM(prompt: string): Promise<string> {
    try {
      console.log('🤖 Calling DeepSeek LLM...');
      
      const response = await fetch(this.llmConfig.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.llmConfig.model,
          prompt: prompt,
          stream: false,
          think: false, // Disable reasoning output for DeepSeek-R1
          options: {
            temperature: this.llmConfig.temperature || 0.7,
            num_predict: this.llmConfig.maxTokens || 200,
          }
        })
      });

      if (!response.ok) {
        throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      console.log('✅ LLM response received');
      return data.response || '';
    } catch (error) {
      console.error('Error calling LLM:', error);
      return ''; // Return empty string on error
    }
  }

  /**
   * Generate enhanced key sentences using LLM
   */
  private async generateLLMKeySentences(
    currentInterests: string[], 
    recentFeedback: string[] = [],
    maxSentences: number = 3
  ): Promise<string[]> {
    const feedbackContext = recentFeedback.length > 0 
      ? `\nRecent topics the user found interesting: ${recentFeedback.join(', ')}`
      : '';

    const prompt = `Based on these interests: ${currentInterests.join(', ')}${feedbackContext}

Generate ${maxSentences} specific, search-friendly sentences that would help find current news and developments. Focus on:
- Recent trends and developments
- Current events and breaking news
- Emerging technologies and market movements
- Industry updates and analysis

Format: One sentence per line, no numbering or bullets.
Keep sentences concise and keyword-rich for effective news searching.

Examples:
- "Latest artificial intelligence breakthrough announcements and product launches"
- "Stock market analysis focusing on technology and semiconductor companies"
- "Robotics simulation software updates and industry partnerships"

Your sentences:`;

    const llmResponse = await this.callLocalLLM(prompt);
    
    if (!llmResponse) {
      // Fallback to simple template-based generation
      return currentInterests.map(interest => 
        `Latest ${interest} news and recent developments`
      );
    }

    // Parse LLM response into sentences
    const sentences = llmResponse
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 10 && !line.startsWith('-') && !line.match(/^\d+\./))
      .slice(0, maxSentences);

    return sentences.length > 0 ? sentences : [`Latest ${currentInterests[0]} developments`];
  }

  /**
   * Extract keywords from content (public method for feedback processing)
   */
  async extractKeywordsFromContent(text: string): Promise<string[]> {
    return this.extractKeywordsWithLLM(text);
  }

  /**
   * Extract and enhance keywords using LLM
   */
  private async extractKeywordsWithLLM(text: string): Promise<string[]> {
    const prompt = `Extract the most important keywords and phrases from this text for news searching. Focus on:
- Specific technologies, companies, products
- Industry terms and jargon
- Current events and trends
- Market-relevant terms

Text: "${text}"

Return 5-8 keywords/phrases, comma-separated, no explanations:`;

    const llmResponse = await this.callLocalLLM(prompt);
    
    if (!llmResponse) {
      // Fallback to simple extraction
      return text.toLowerCase()
        .split(/\s+/)
        .filter(word => word.length > 3)
        .slice(0, 5);
    }

    const keywords = llmResponse
      .split(',')
      .map(kw => kw.trim())
      .filter(kw => kw.length > 2)
      .slice(0, 8);

    return keywords;
  }





  /**
   * Search with Brave Search API
   */
  private async searchWithBrave(query: string, maxResults: number = 3): Promise<SearchResult[]> {
    try {
      console.log(`🔍 Searching with Brave API for: "${query}"`);
      
      const response = await this.braveSearch.webSearch(query, {
        count: maxResults,
        freshness: 'pw', // Past week
        search_lang: 'en',
        country: 'US'
      });
      
      const results: SearchResult[] = response.web?.results?.map((result: any) => ({
        title: result.title,
        snippet: result.description,
        url: result.url,
        relevanceScore: result.rank || 0
      })) || [];
      
      console.log(`✅ Found ${results.length} results from Brave API`);
      return results;
    } catch (error) {
      console.error('Brave Search error:', error);
      return [];
    }
  }

  /**
   * Main search function with tree-based content discovery and LLM integration
   */
  async searchBasedOnKeySentences(useLLM: boolean = true): Promise<{ results: SearchResult[], selectedNodes: TreeNode[] }> {
    this.totalSearches++;
    
    if (!this.treeManager) {
      throw new Error('Tree manager not initialized. Tree-based search is required.');
    }
    
    return this.searchWithTreeStructure(useLLM);
  }

  /**
   * Tree-based search implementation
   */
  private async searchWithTreeStructure(useLLM: boolean = true): Promise<{ results: SearchResult[], selectedNodes: TreeNode[] }> {
    console.log('🌳 Using tree-based content discovery');
    
    // Load negative keywords for quality scoring
    const negativeKeywords = await this.loadNegativeKeywords();
    
    // Select nodes using Thompson Sampling - prioritize approved nodes
    const nodeSelection = await this.treeManager!.selectNodesForDiscovery({
      approvalStatuses: ['approved'],
      statuses: ['active'],
      minQualityScore: 0.3,
      sortBy: 'quality'
    }, 3);

    const selectedNodes = nodeSelection.selectedNodes;
    console.log(`🎯 Selected ${selectedNodes.length} tree nodes for content discovery`);
    
    if (selectedNodes.length === 0) {
      console.log('⚠️ No suitable tree nodes found, returning empty results');
      return {
        results: [],
        selectedNodes: []
      };
    }

    // Generate search queries based on selected nodes
    const queries = useLLM 
      ? await this.generateTreeBasedLLMQueries(selectedNodes, 2)
      : this.generateTreeBasedFallbackQueries(selectedNodes);
    
    console.log('🔍 Using tree-based search queries:', queries);
    
    const allResults: SearchResult[] = [];
    
    // Search for each query
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      console.log(`🔍 Processing query ${i + 1}/${queries.length}: "${query}"`);
      
      const results = await this.searchWithBrave(query, 3);
      
      // Add tree-specific metadata to results
      const resultsWithTreeData = results.map(result => {
        const contentText = `${result.title} ${result.snippet}`;
        const qualityScore = this.calculateContentQualityScore(contentText, negativeKeywords);
        
        return {
          ...result,
          contributingNodeIds: selectedNodes.map(n => n.nodeId),
          qualityScore,
          searchQuery: query
        };
      });
      
      allResults.push(...resultsWithTreeData);
      
      // Add delay between requests
      if (i < queries.length - 1) {
        console.log('⏳ Waiting 2 seconds before next search...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Sort results by quality score
    const rankedResults = allResults.sort((a, b) => {
      const qualityA = Math.pow(a.qualityScore || 1.0, 2);
      const qualityB = Math.pow(b.qualityScore || 1.0, 2);
      const scoreA = qualityA * (a.relevanceScore || 1.0);
      const scoreB = qualityB * (b.relevanceScore || 1.0);
      return scoreB - scoreA;
    });

    console.log(`📊 Tree-based search found ${rankedResults.length} results`);
    
    return {
      results: rankedResults,
      selectedNodes
    };
  }


  /**
   * Tree-based feedback processing
   */
  async processFeedback(feedback: UserFeedback[]): Promise<void> {
    console.log(`🔄 Processing ${feedback.length} feedback items...`);

    if (!this.treeManager) {
      console.error('❌ Tree manager not initialized');
      return;
    }

    // Process feedback through tree structure
    if (feedback.length > 0) {
      await this.processTreeFeedback(feedback);
    }

    // Process negative feedback keywords for quality scoring
    const negativeFeedback = feedback.filter(fb => fb.reaction === 'negative');
    
    for (const fb of negativeFeedback) {
      if (fb.extractedKeywords && fb.extractedKeywords.length > 0) {
        console.log(`🚫 Processing negative keywords: ${fb.extractedKeywords.join(', ')}`);
        await this.saveNegativeKeywords(fb.extractedKeywords);
      }
    }

    console.log('✅ Tree-based feedback processed and system updated');
  }






  /**
   * Initialize the system with database persistence and tree structure
   */
  async initializeWithPersistence(): Promise<void> {
    // Initialize tree manager if we have database connection
    if (this.supabase && this.userId) {
      this.treeManager = new TreeManager(this.supabase, this.userId);
      
      // Initialize embedding service
      this.embeddingService = createEmbeddingService(
        this.supabase, 
        this.userId,
        'http://localhost:11434',
        'nomic-embed-text'
      );
      
      // Create or sync interest nodes in the tree
      await this.syncInterestsWithTree();
      
      // Generate embeddings for interests if they don't exist
      await this.generateEmbeddingsForInterests();
      
      // Analyze embeddings and create combinations
      await this.analyzeAndCreateCombinations();
    }
  }

  /**
   * Persist changes after feedback processing
   */
  async persistAfterFeedback(): Promise<void> {
    // Tree-based system handles persistence automatically
    console.log('✅ Tree-based feedback persisted to database');
  }

  /**
   * Save negative keywords to database with frequency tracking
   */
  async saveNegativeKeywords(keywords: string[]): Promise<void> {
    if (!this.supabase || !this.userId || keywords.length === 0) {
      console.log('⚠️ No database connection, user ID, or keywords - skipping negative keyword saving');
      return;
    }

    try {
      console.log('💾 Saving negative keywords:', keywords);

      for (const keyword of keywords) {
        // Check if keyword already exists
        const { data: existing } = await this.supabase
          .from('user_negative_keywords')
          .select('id, frequency, weight')
          .eq('user_id', this.userId)
          .eq('keyword', keyword.toLowerCase())
          .single();

        if (existing) {
          // Update existing keyword - increase frequency and weight
          const newFrequency = existing.frequency + 1;
          const newWeight = Math.min(1.0, existing.weight + 0.1); // Cap at 1.0

          await this.supabase
            .from('user_negative_keywords')
            .update({
              frequency: newFrequency,
              weight: newWeight,
              last_reinforced: new Date().toISOString()
            })
            .eq('id', existing.id);

          console.log(`🔄 Updated negative keyword "${keyword}" (frequency: ${newFrequency}, weight: ${newWeight})`);
        } else {
          // Insert new keyword
          await this.supabase
            .from('user_negative_keywords')
            .insert({
              user_id: this.userId,
              keyword: keyword.toLowerCase(),
              weight: 0.5, // Start with moderate weight
              frequency: 1,
              first_seen: new Date().toISOString(),
              last_reinforced: new Date().toISOString()
            });

          console.log(`➕ Added new negative keyword: "${keyword}"`);
        }
      }
    } catch (error) {
      console.error('❌ Failed to save negative keywords:', error);
    }
  }

  /**
   * Load user's negative keywords for quality scoring
   */
  async loadNegativeKeywords(): Promise<Map<string, number>> {
    if (!this.supabase || !this.userId) {
      return new Map();
    }

    try {
      const { data, error } = await this.supabase
        .from('user_negative_keywords')
        .select('keyword, weight')
        .eq('user_id', this.userId)
        .order('weight', { ascending: false });

      if (error) {
        console.error('❌ Error loading negative keywords:', error);
        return new Map();
      }

      const keywordMap = new Map<string, number>();
      data?.forEach(row => {
        keywordMap.set(row.keyword, row.weight);
      });

      console.log(`📚 Loaded ${keywordMap.size} negative keywords`);
      return keywordMap;
    } catch (error) {
      console.error('❌ Failed to load negative keywords:', error);
      return new Map();
    }
  }

  /**
   * Calculate content quality score based on negative keywords
   */
  calculateContentQualityScore(content: string, negativeKeywords: Map<string, number>): number {
    const contentLower = content.toLowerCase();
    let qualityPenalty = 0;

    // Check content against negative keywords
    for (const [keyword, weight] of negativeKeywords) {
      if (contentLower.includes(keyword)) {
        qualityPenalty += weight;
        console.log(`🚫 Found negative keyword "${keyword}" (weight: ${weight}) in content`);
      }
    }

    // Calculate final quality score (reduce by 60% per unit of penalty for stronger impact)
    const qualityScore = Math.max(0.05, 1.0 - (qualityPenalty * 0.6));
    
    if (qualityPenalty > 0) {
      console.log(`📉 Content quality score: ${qualityScore.toFixed(2)} (penalty: ${qualityPenalty.toFixed(2)})`);
    }

    return qualityScore;
  }

  /**
   * Generate search queries based on tree nodes using LLM
   */
  private async generateTreeBasedLLMQueries(selectedNodes: TreeNode[], maxQueries: number = 2): Promise<string[]> {
    const nodeDescriptions = selectedNodes.map(node => {
      if (node.nodeType === 'interest') {
        return `Interest: ${node.title}`;
      } else {
        return `Approved news: ${node.title} (keywords: ${node.keywords.join(', ')})`;
      }
    }).join('\n- ');
    
    const prompt = `Based on these selected content nodes:
- ${nodeDescriptions}

Generate ${maxQueries} specific search queries for finding current news that would be interesting to this user. Each query should:
- Be 3-6 words long
- Focus on recent/current events
- Use effective news search keywords
- Build upon the approved content patterns

Format: One query per line, no quotes or formatting.

Examples:
- "AI chip shortage latest"
- "robotics startup funding news" 
- "blockchain adoption banking"

Your queries:`;

    const llmResponse = await this.callLocalLLM(prompt);
    
    if (!llmResponse) {
      return this.generateTreeBasedFallbackQueries(selectedNodes);
    }

    const queries = llmResponse
      .split('\n')
      .map(line => line.trim().replace(/^[-"'•]\s*/, '').replace(/["']$/, ''))
      .filter(line => line.length > 5 && line.length < 50)
      .slice(0, maxQueries);

    return queries.length > 0 ? queries : this.generateTreeBasedFallbackQueries(selectedNodes);
  }

  /**
   * Generate fallback search queries from tree nodes
   */
  private generateTreeBasedFallbackQueries(selectedNodes: TreeNode[]): string[] {
    const allKeywords: string[] = [];
    
    selectedNodes.forEach(node => {
      allKeywords.push(...node.keywords);
      
      // Extract additional keywords from title
      const titleWords = node.title.toLowerCase()
        .split(/\s+/)
        .filter(word => 
          word.length > 3 && 
          !['latest', 'news', 'developments', 'about', 'regarding', 'recent'].includes(word)
        );
      allKeywords.push(...titleWords);
    });

    const uniqueKeywords = [...new Set(allKeywords)].slice(0, 8);
    
    if (uniqueKeywords.length === 0) {
      return ['latest news and trending topics'];
    }

    const queries: string[] = [];
    
    if (uniqueKeywords.length >= 2) {
      queries.push(`${uniqueKeywords.slice(0, 2).join(' ')} latest news`);
    }
    
    if (uniqueKeywords.length >= 4) {
      queries.push(`${uniqueKeywords.slice(2, 4).join(' ')} recent developments`);
    }
    
    if (queries.length === 0) {
      queries.push(`${uniqueKeywords[0]} news`);
    }

    return queries.slice(0, 2);
  }

  /**
   * Enhanced interest change handler with semantic cleanup
   */
  async handleInterestChange(oldInterests: string[], newInterests: string[]): Promise<void> {
    if (!this.treeManager || !this.embeddingService) {
      console.log('⚠️ TreeManager or EmbeddingService not available for interest change handling');
      return;
    }

    try {
      console.log('🔄 Handling interest change...');
      console.log(`  Old interests: [${oldInterests.join(', ')}]`);
      console.log(`  New interests: [${newInterests.join(', ')}]`);

      // Identify changes
      const removed = oldInterests.filter(i => !newInterests.includes(i));
      const added = newInterests.filter(i => !oldInterests.includes(i));
      const unchanged = oldInterests.filter(i => newInterests.includes(i));

      console.log(`📊 Change analysis:`);
      console.log(`  • Removed: [${removed.join(', ')}]`);
      console.log(`  • Added: [${added.join(', ')}]`);
      console.log(`  • Unchanged: [${unchanged.join(', ')}]`);

      // Phase 1: Enhanced cleanup for removed interests
      if (removed.length > 0) {
        console.log('🧹 Phase 1: Cleaning up removed interests...');
        for (const removedInterest of removed) {
          const result = await this.treeManager.removeInterestWithSemanticCleanup(
            removedInterest,
            unchanged.concat(added), // All remaining interests
            this.embeddingService
          );
          
          if (result.success) {
            console.log(`✅ Successfully cleaned up interest: ${removedInterest}`);
          } else {
            console.error(`❌ Failed to clean up interest: ${removedInterest}`, result.error);
          }
        }
      }

      // Phase 2: Add new interests
      if (added.length > 0) {
        console.log('➕ Phase 2: Adding new interests...');
        for (const newInterest of added) {
          const result = await this.treeManager.createInterestNode(newInterest, [newInterest]);
          
          if (result.success) {
            console.log(`✅ Created new interest: ${newInterest}`);
          } else if (result.error?.includes('duplicate') || result.error?.includes('unique')) {
            console.log(`ℹ️ Interest already exists: ${newInterest}`);
          } else {
            console.error(`❌ Failed to create interest: ${newInterest}`, result.error);
          }
        }
      }

      // Phase 3: Generate embeddings for new interests
      if (added.length > 0) {
        console.log('🧠 Phase 3: Generating embeddings for new interests...');
        await this.generateEmbeddingsForInterests();
      }

      // Phase 4: Refresh combinations with new interest set
      if (removed.length > 0 || added.length > 0) {
        console.log('🎨 Phase 4: Refreshing combinations...');
        await this.refreshCombinations(newInterests);
      }

      console.log('✅ Interest change handling complete!');
    } catch (error) {
      console.error('❌ Interest change handling failed:', error);
    }
  }

  /**
   * Refresh combinations after interest changes
   */
  private async refreshCombinations(currentInterests: string[]): Promise<void> {
    if (!this.treeManager || !this.embeddingService) return;

    try {
      // Get all nodes with embeddings for current interests
      const nodesWithEmbeddings = await this.treeManager.getNodesWithEmbeddings(['interest']);
      
      // Filter to only include current interests
      const relevantNodes = nodesWithEmbeddings.filter(node => 
        currentInterests.some(interest => 
          node.title.toLowerCase().includes(interest.toLowerCase()) ||
          interest.toLowerCase().includes(node.title.toLowerCase())
        )
      );

      if (relevantNodes.length < 2) {
        console.log('ℹ️ Need at least 2 relevant interests for combinations');
        return;
      }

      console.log(`🎯 Generating new combinations from ${relevantNodes.length} relevant interests`);

      // Generate new combinations
      const analysis = await this.embeddingService.analyzeInterestEmbeddings(relevantNodes);
      
      // Create combination nodes from top suggestions
      const topCombinations = analysis.combinationSuggestions.slice(0, 3); // Reduced to 3 for faster processing
      
      for (const combination of topCombinations) {
        console.log(`🎨 Creating refreshed combination: "${combination.combinedTitle}" (confidence: ${combination.confidenceScore.toFixed(2)})`);
        
        const result = await this.treeManager.createCombinationNode(combination, this.embeddingService);
        
        if (result.success) {
          console.log(`✅ Created refreshed combination: ${result.nodeId}`);
        } else {
          console.log(`⚠️ Failed to create combination: ${result.error}`);
        }
      }

      console.log(`✅ Combination refresh complete: ${topCombinations.length} new combinations created`);
    } catch (error) {
      console.error('❌ Failed to refresh combinations:', error);
    }
  }

  /**
   * Synchronize user interests with tree structure (now calls enhanced handler)
   */
  private async syncInterestsWithTree(): Promise<void> {
    if (!this.treeManager) return;

    try {
      // Get current interests from the tree database
      const { data: existingInterests, error: fetchError } = await this.supabase
        ?.from('news_interest_tree')
        .select('title, node_id')
        .eq('user_id', this.userId)
        .eq('node_type', 'interest')
        .eq('status', 'active') || { data: null, error: null };

      if (fetchError) {
        console.error('❌ Failed to fetch existing interests:', fetchError);
        return;
      }

      const existingInterestNames = existingInterests?.map(i => i.title) || [];
      
      // Use enhanced interest change handler
      await this.handleInterestChange(existingInterestNames, this.initialInterests);

    } catch (error) {
      console.error('❌ Failed to sync interests with tree:', error);
    }
  }

  /**
   * Enhanced feedback processing with tree integration
   */
  async processFeedback(feedback: UserFeedback[]): Promise<void> {
    console.log(`🔄 Processing ${feedback.length} feedback items...`);

    // Process feedback through tree structure if available
    if (this.treeManager && feedback.length > 0) {
      await this.processTreeFeedback(feedback);
    }

  }

  /**
   * Process feedback through tree structure
   */
  private async processTreeFeedback(feedback: UserFeedback[]): Promise<void> {
    for (const fb of feedback) {
      // Create tree feedback object
      const treeFeedback: TreeFeedback = {
        nodeId: fb.resultId,
        reaction: fb.reaction,
        timestamp: fb.timestamp,
        metadata: {
          searchQuery: (fb as any).searchQuery
        }
      };

      // If this is positive feedback on a search result, create a news node
      if (fb.reaction === 'positive' && fb.extractedKeywords?.length) {
        // Find the contributing parent node (from search metadata)
        const contributingNodes = (fb as any).contributingNodeIds || [];
        const parentNodeId = contributingNodes[0]; // Use first contributing node as parent
        
        if (parentNodeId) {
          console.log(`➕ Creating news node for approved content: "${fb.resultId}"`);
          
          // Create news node as child of the contributing interest/news node
          const newsResult = await this.treeManager!.createNewsNode(
            parentNodeId,
            fb.resultId, // Use resultId as title for now (should be actual title)
            (fb as any).url || '',
            (fb as any).snippet || '',
            fb.extractedKeywords,
            {
              searchQuery: (fb as any).searchQuery,
              originalFeedback: fb
            }
          );

          if (newsResult.success) {
            console.log(`✅ Created news node: ${newsResult.nodeId}`);
            
            // Process feedback on the new node
            treeFeedback.nodeId = newsResult.nodeId!;
            await this.treeManager!.processFeedback(treeFeedback);
          }
        }
      } else {
        // Process feedback on existing node (if it exists in tree)
        await this.treeManager!.processFeedback(treeFeedback);
      }
    }
  }

  /**
   * Generate embeddings for interest nodes that don't have them yet
   */
  private async generateEmbeddingsForInterests(): Promise<void> {
    if (!this.treeManager || !this.embeddingService) {
      return;
    }

    console.log('🧠 Checking if interest nodes need embeddings...');
    
    try {
      const result = await this.treeManager.generateEmbeddingsForAllNodes(
        this.embeddingService, 
        ['interest']
      );
      
      if (result.success && result.affectedNodes?.length) {
        console.log(`✅ Generated embeddings for ${result.affectedNodes.length} interest nodes`);
      }
    } catch (error) {
      console.error('❌ Failed to generate embeddings for interests:', error);
    }
  }

  /**
   * Analyze embeddings and create combination suggestions
   */
  private async analyzeAndCreateCombinations(): Promise<void> {
    if (!this.treeManager || !this.embeddingService) {
      return;
    }

    console.log('🎨 Analyzing embeddings for creative combinations...');
    
    try {
      // Get all nodes with embeddings
      const nodesWithEmbeddings = await this.treeManager.getNodesWithEmbeddings(['interest']);
      
      if (nodesWithEmbeddings.length < 2) {
        console.log('ℹ️ Need at least 2 interests with embeddings for combinations');
        return;
      }

      // Analyze embeddings and generate combinations
      const analysis = await this.embeddingService.analyzeInterestEmbeddings(nodesWithEmbeddings);
      
      // Create combination nodes from the best suggestions
      const topCombinations = analysis.combinationSuggestions.slice(0, 5); // Top 5 combinations
      
      for (const combination of topCombinations) {
        console.log(`🎯 Creating combination: "${combination.combinedTitle}" (confidence: ${combination.confidenceScore.toFixed(2)})`);
        
        const result = await this.treeManager.createCombinationNode(combination, this.embeddingService);
        
        if (result.success) {
          console.log(`✅ Created combination node: ${result.nodeId}`);
        } else {
          console.log(`⚠️ Failed to create combination: ${result.error}`);
        }
      }

      console.log(`✅ Embedding analysis complete: ${analysis.combinationSuggestions.length} combinations analyzed, ${topCombinations.length} created`);
    } catch (error) {
      console.error('❌ Failed to analyze embeddings:', error);
    }
  }

  /**
   * Enhanced tree-based search with combination node support
   */
  private async searchWithTreeAndCombinations(useLLM: boolean = true): Promise<{ results: SearchResult[], selectedNodes: TreeNode[] }> {
    console.log('🌳 Using enhanced tree-based content discovery with combinations');
    
    // Load negative keywords for quality scoring
    const negativeKeywords = await this.loadNegativeKeywords();
    
    // Select nodes using Interest-Aware Selection - include combination nodes
    const nodeSelection = await this.treeManager!.selectNodesForDiscovery({
      approvalStatuses: ['approved'],
      statuses: ['active'],
      nodeTypes: ['interest', 'combination'], // Include combination nodes
      minQualityScore: 0.2,
      sortBy: 'quality'
    }, 5, this.initialInterests, this.embeddingService); // Pass current interests and embedding service

    const selectedNodes = nodeSelection.selectedNodes;
    console.log(`🎯 Selected ${selectedNodes.length} tree nodes (including combinations) for content discovery`);
    
    if (selectedNodes.length === 0) {
      console.log('⚠️ No suitable tree nodes found, returning empty results');
      return {
        results: [],
        selectedNodes: []
      };
    }

    // Generate search queries based on selected nodes (including combinations)
    const queries = useLLM 
      ? await this.generateEnhancedLLMQueries(selectedNodes, 3)
      : this.generateEnhancedFallbackQueries(selectedNodes);
    
    console.log('🔍 Using enhanced search queries:', queries);
    
    const allResults: SearchResult[] = [];
    
    // Search for each query
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      console.log(`🔍 Processing query ${i + 1}/${queries.length}: "${query}"`);
      
      const results = await this.searchWithBrave(query, 3);
      
      // Add enhanced metadata to results
      const resultsWithEnhancedData = results.map(result => {
        const contentText = `${result.title} ${result.snippet}`;
        const qualityScore = this.calculateContentQualityScore(contentText, negativeKeywords);
        
        return {
          ...result,
          contributingNodeIds: selectedNodes.map(n => n.nodeId),
          qualityScore,
          searchQuery: query,
          searchMethod: 'enhanced_tree_with_combinations'
        };
      });
      
      allResults.push(...resultsWithEnhancedData);
      
      // Add delay between requests
      if (i < queries.length - 1) {
        console.log('⏳ Waiting 2 seconds before next search...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Sort results by quality score
    const rankedResults = allResults.sort((a, b) => {
      const qualityA = Math.pow(a.qualityScore || 1.0, 2);
      const qualityB = Math.pow(b.qualityScore || 1.0, 2);
      const scoreA = qualityA * (a.relevanceScore || 1.0);
      const scoreB = qualityB * (b.relevanceScore || 1.0);
      return scoreB - scoreA;
    });

    console.log(`📊 Enhanced search found ${rankedResults.length} results`);
    
    return {
      results: rankedResults,
      selectedNodes
    };
  }

  /**
   * Generate enhanced LLM queries including combination nodes
   */
  private async generateEnhancedLLMQueries(selectedNodes: TreeNode[], maxQueries: number = 3): Promise<string[]> {
    const nodeDescriptions = selectedNodes.map(node => {
      if (node.nodeType === 'interest') {
        return `Interest: ${node.title}`;
      } else if (node.nodeType === 'combination') {
        return `Creative combination: ${node.title} (confidence: ${(node as any).confidenceScore || 'N/A'})`;
      } else {
        return `Approved news: ${node.title} (keywords: ${node.keywords.join(', ')})`;
      }
    }).join('\n- ');
    
    const prompt = `Based on these selected content nodes including creative combinations:
- ${nodeDescriptions}

Generate ${maxQueries} specific search queries for finding current news. Mix traditional and creative queries:
- Use creative combinations when available
- Be 3-6 words long
- Focus on recent/current events
- Use effective news search keywords
- Build upon both individual interests and their combinations

Format: One query per line, no quotes or formatting.

Examples:
- "drone jobs spain" (from combination)
- "AI startup funding news"
- "remote work blockchain"

Your queries:`;

    const llmResponse = await this.callLocalLLM(prompt);
    
    if (!llmResponse) {
      return this.generateEnhancedFallbackQueries(selectedNodes);
    }

    const queries = llmResponse
      .split('\n')
      .map(line => line.trim().replace(/^[-"'•]\s*/, '').replace(/["']$/, ''))
      .filter(line => line.length > 5 && line.length < 50)
      .slice(0, maxQueries);

    return queries.length > 0 ? queries : this.generateEnhancedFallbackQueries(selectedNodes);
  }

  /**
   * Generate enhanced fallback queries including combination nodes
   */
  private generateEnhancedFallbackQueries(selectedNodes: TreeNode[]): string[] {
    const queries: string[] = [];
    
    // Process combination nodes first (they have pre-generated queries)
    const combinationNodes = selectedNodes.filter(node => node.nodeType === 'combination');
    for (const combo of combinationNodes) {
      const comboData = combo as any;
      if (comboData.potentialQueries && comboData.potentialQueries.length > 0) {
        queries.push(comboData.potentialQueries[0]); // Use the first suggested query
      }
    }
    
    // Add queries from regular interests
    const interestNodes = selectedNodes.filter(node => node.nodeType === 'interest');
    const allKeywords: string[] = [];
    
    interestNodes.forEach(node => {
      allKeywords.push(...node.keywords);
      
      // Extract additional keywords from title
      const titleWords = node.title.toLowerCase()
        .split(/\s+/)
        .filter(word => 
          word.length > 3 && 
          !['latest', 'news', 'developments', 'about', 'regarding', 'recent'].includes(word)
        );
      allKeywords.push(...titleWords);
    });

    const uniqueKeywords = [...new Set(allKeywords)].slice(0, 6);
    
    if (uniqueKeywords.length >= 2) {
      queries.push(`${uniqueKeywords.slice(0, 2).join(' ')} latest news`);
    }
    
    if (uniqueKeywords.length >= 4) {
      queries.push(`${uniqueKeywords.slice(2, 4).join(' ')} recent developments`);
    }
    
    if (queries.length === 0 && uniqueKeywords.length > 0) {
      queries.push(`${uniqueKeywords[0]} news`);
    }

    return queries.slice(0, 3);
  }

  /**
   * Update the main search method to use enhanced search
   */
  private async searchWithTreeStructure(useLLM: boolean = true): Promise<{ results: SearchResult[], selectedNodes: TreeNode[] }> {
    // Use enhanced search if embedding service is available
    if (this.embeddingService) {
      return this.searchWithTreeAndCombinations(useLLM);
    }
    
    // Fall back to original tree search
    console.log('🌳 Using basic tree-based content discovery (no embeddings)');
    
    const negativeKeywords = await this.loadNegativeKeywords();
    
    const nodeSelection = await this.treeManager!.selectNodesForDiscovery({
      approvalStatuses: ['approved'],
      statuses: ['active'],
      minQualityScore: 0.3,
      sortBy: 'quality'
    }, 3);

    const selectedNodes = nodeSelection.selectedNodes;
    console.log(`🎯 Selected ${selectedNodes.length} tree nodes for basic content discovery`);
    
    if (selectedNodes.length === 0) {
      return { results: [], selectedNodes: [] };
    }

    const queries = useLLM 
      ? await this.generateTreeBasedLLMQueries(selectedNodes, 2)
      : this.generateTreeBasedFallbackQueries(selectedNodes);
    
    console.log('🔍 Using basic tree search queries:', queries);
    
    const allResults: SearchResult[] = [];
    
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      const results = await this.searchWithBrave(query, 3);
      
      const resultsWithTreeData = results.map(result => {
        const contentText = `${result.title} ${result.snippet}`;
        const qualityScore = this.calculateContentQualityScore(contentText, negativeKeywords);
        
        return {
          ...result,
          contributingNodeIds: selectedNodes.map(n => n.nodeId),
          qualityScore,
          searchQuery: query
        };
      });
      
      allResults.push(...resultsWithTreeData);
      
      if (i < queries.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    const rankedResults = allResults.sort((a, b) => {
      const qualityA = Math.pow(a.qualityScore || 1.0, 2);
      const qualityB = Math.pow(b.qualityScore || 1.0, 2);
      const scoreA = qualityA * (a.relevanceScore || 1.0);
      const scoreB = qualityB * (b.relevanceScore || 1.0);
      return scoreB - scoreA;
    });

    return {
      results: rankedResults,
      selectedNodes
    };
  }

}

/**
 * Legacy function for backward compatibility - now uses tree-based search
 */
export async function discoverInterestingContent(
  commonInterests: string[],
  customInterests: string[]
): Promise<SearchResult[]> {
  const allInterests = [...commonInterests, ...customInterests];
  const searchSystem = new AdaptiveSearchSystem(allInterests);
  
  // Initialize with tree structure (this will throw if no database connection)
  await searchSystem.initializeWithPersistence();
  
  const { results } = await searchSystem.searchBasedOnKeySentences(true);
  return results;
}