import { BraveSearch } from 'brave-search';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { TreeManager, type TreeNode, type TreeFeedback, type NodeSelectionResult } from './tree';

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
  contributingSentenceIds?: string[]; // Track which sentences led to this result (legacy)
  contributingNodeIds?: string[]; // Track which tree nodes led to this result (new)
  qualityScore?: number; // Content quality score based on negative keyword matching
  searchQuery?: string; // The query that found this result
}

export interface KeySentence {
  id: string;
  text: string;
  source: 'user' | 'feedback' | 'llm';
  createdAt: Date;
  timesUsed: number;
  positiveReactions: number;
  negativeReactions: number;
  avgFeedback: number;
  keywords: string[];
}

export interface UserFeedback {
  resultId: string;
  reaction: 'positive' | 'negative';
  timestamp: Date;
  extractedKeywords?: string[];
  contributingSentenceIds?: string[];
}

export interface SearchSession {
  selectedSentences: KeySentence[];
  results: SearchResult[];
  feedback: UserFeedback[];
  timestamp: Date;
}

/**
 * Enhanced search system with key sentences, feedback learning, and LLM integration
 */
export class AdaptiveSearchSystem {
  private keySentences: KeySentence[] = [];
  private searchHistory: SearchSession[] = [];
  private totalSearches = 0;
  private llmConfig: LLMConfig;
  private braveSearch: BraveSearch;
  private supabase: SupabaseClient | null = null;
  private userId: string | null = null;
  private initialInterests: string[] = [];
  private treeManager: TreeManager | null = null;

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
    
    // Initialize with basic sentences from interests (will be enhanced with loaded sentences)
    this.initializeKeySentences(initialInterests);
  }

  /**
   * Create initial key sentences from user interests
   */
  private initializeKeySentences(interests: string[]): void {
    this.keySentences = interests.map((interest, index) => ({
      id: `init_${index}`,
      text: `Latest news and developments in ${interest}`,
      source: 'user',
      createdAt: new Date(),
      timesUsed: 0,
      positiveReactions: 1, // Start with prior
      negativeReactions: 1, // Start with prior
      avgFeedback: 0.5,
      keywords: [interest]
    }));
  }

  /**
   * Calculate time-based exponential decay weight
   */
  private calculateTimeWeight(timestamp: Date, decayRate: number = 0.95): number {
    const daysOld = (Date.now() - timestamp.getTime()) / (1000 * 60 * 60 * 24);
    return Math.pow(decayRate, daysOld);
  }

  /**
   * Thompson Sampling for key sentence selection
   */
  private sampleSentenceScore(sentence: KeySentence): number {
    // Beta distribution sampling approximation
    const alpha = sentence.positiveReactions;
    const beta = sentence.negativeReactions;
    
    // Simple beta distribution approximation using normal distribution
    const mean = alpha / (alpha + beta);
    const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
    const stdDev = Math.sqrt(variance);
    
    // Box-Muller transform for normal distribution
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    
    return Math.max(0, Math.min(1, mean + z * stdDev));
  }

  /**
   * Select key sentences using Thompson Sampling with time decay
   */
  private selectKeySentences(count: number = 3): KeySentence[] {
    const scoredSentences = this.keySentences.map(sentence => {
      const timeWeight = this.calculateTimeWeight(sentence.createdAt);
      const thompsonScore = this.sampleSentenceScore(sentence);
      const diversityPenalty = sentence.timesUsed > 5 ? 0.8 : 1.0; // Reduce overuse
      
      return {
        sentence,
        finalScore: thompsonScore * timeWeight * diversityPenalty
      };
    });

    // Sort by score and select top N
    return scoredSentences
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, count)
      .map(item => item.sentence);
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
   * Generate contextual search queries using LLM
   */
  private async generateLLMSearchQueries(
    selectedSentences: KeySentence[],
    maxQueries: number = 2
  ): Promise<string[]> {
    const sentenceTexts = selectedSentences.map(s => s.text).join('\n- ');
    
    const prompt = `Based on these key interest areas:
- ${sentenceTexts}

Generate ${maxQueries} specific, effective search queries for finding current news. Each query should:
- Be 3-6 words long
- Focus on recent/current events
- Use news-friendly keywords
- Target different aspects of the interests

Format: One query per line, no quotes or formatting.

Examples:
- "AI chip shortage latest"
- "robotics startup funding news"
- "stock market tech trends"

Your queries:`;

    const llmResponse = await this.callLocalLLM(prompt);
    
    if (!llmResponse) {
      // Fallback to keyword extraction method
      return this.generateFallbackSearchQueries(selectedSentences);
    }

    const queries = llmResponse
      .split('\n')
      .map(line => line.trim().replace(/^[-"'•]\s*/, '').replace(/["']$/, ''))
      .filter(line => line.length > 5 && line.length < 50)
      .slice(0, maxQueries);

    return queries.length > 0 ? queries : this.generateFallbackSearchQueries(selectedSentences);
  }

  /**
   * Enhanced key sentence generation using LLM
   */
  async generateEnhancedKeySentences(count: number = 2): Promise<void> {
    console.log('🧠 Generating enhanced key sentences with LLM...');
    
    // Collect current interests and recent positive feedback
    const currentInterests = [...new Set(
      this.keySentences.flatMap(s => s.keywords)
    )].slice(0, 5);
    
    const recentPositiveFeedback = this.searchHistory
      .slice(-3) // Last 3 sessions
      .flatMap(session => 
        session.feedback
          .filter(fb => fb.reaction === 'positive')
          .flatMap(fb => fb.extractedKeywords || [])
      );

    // Generate new sentences using LLM
    const llmSentences = await this.generateLLMKeySentences(
      currentInterests,
      recentPositiveFeedback,
      count
    );

    // Add each generated sentence to the system
    for (const sentenceText of llmSentences) {
      const keywords = await this.extractKeywordsWithLLM(sentenceText);
      
      const newSentence: KeySentence = {
        id: `llm_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
        text: sentenceText,
        source: 'llm',
        createdAt: new Date(),
        timesUsed: 0,
        positiveReactions: 1, // Start with neutral prior
        negativeReactions: 1,
        avgFeedback: 0.5,
        keywords: keywords
      };

      this.keySentences.push(newSentence);
      console.log(`➕ Added LLM sentence: "${sentenceText}"`);
    }

    // Trim old low-performing sentences
    this.trimKeySentences();
  }

  /**
   * Remove old or poorly performing key sentences
   */
  private trimKeySentences(maxSentences: number = 25): void {
    if (this.keySentences.length <= maxSentences) return;

    // Score sentences by performance and recency
    const scoredSentences = this.keySentences.map(sentence => ({
      sentence,
      score: sentence.avgFeedback * this.calculateTimeWeight(sentence.createdAt, 0.9)
    }));

    // Keep the best performing sentences
    this.keySentences = scoredSentences
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSentences)
      .map(item => item.sentence);
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
  async searchBasedOnKeySentences(useLLM: boolean = true): Promise<{ results: SearchResult[], selectedSentences: KeySentence[], selectedNodes?: TreeNode[] }> {
    this.totalSearches++;
    
    // Use tree-based search if available, otherwise fall back to legacy system
    if (this.treeManager) {
      return this.searchWithTreeStructure(useLLM);
    }
    
    // Legacy search system (keep for backward compatibility)
    return this.legacySearchBasedOnKeySentences(useLLM);
  }

  /**
   * Tree-based search implementation
   */
  private async searchWithTreeStructure(useLLM: boolean = true): Promise<{ results: SearchResult[], selectedSentences: KeySentence[], selectedNodes: TreeNode[] }> {
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
      console.log('⚠️ No suitable tree nodes found, falling back to legacy system');
      return this.legacySearchBasedOnKeySentences(useLLM);
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
          contributingSentenceIds: [], // Will be populated by tree node IDs instead
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
    
    // Convert selected nodes to legacy sentence format for compatibility
    const selectedSentences: KeySentence[] = selectedNodes.map(node => ({
      id: node.nodeId,
      text: node.title,
      source: node.nodeType === 'interest' ? 'user' : 'feedback',
      createdAt: node.createdAt,
      timesUsed: node.timesSelected,
      positiveReactions: node.positiveReactions,
      negativeReactions: node.negativeReactions,
      avgFeedback: node.qualityScore,
      keywords: node.keywords
    }));
    
    return {
      results: rankedResults,
      selectedSentences,
      selectedNodes
    };
  }

  /**
   * Legacy search system (for backward compatibility)
   */
  private async legacySearchBasedOnKeySentences(useLLM: boolean = true): Promise<{ results: SearchResult[], selectedSentences: KeySentence[] }> {
    // Load negative keywords for quality scoring
    const negativeKeywords = await this.loadNegativeKeywords();
    
    // Optionally generate new LLM sentences before search
    if (useLLM && this.totalSearches % 3 === 1) { // Every 3rd search
      await this.generateEnhancedKeySentences(2);
    }

    // Select key sentences using Thompson Sampling
    const selectedSentences = this.selectKeySentences(3);
    
    // Mark sentences as used
    selectedSentences.forEach(sentence => {
      sentence.timesUsed++;
    });

    // Generate search queries (with LLM if enabled)
    const queries = useLLM 
      ? await this.generateLLMSearchQueries(selectedSentences, 2)
      : this.generateFallbackSearchQueries(selectedSentences);
    
    console.log('🔍 Using legacy search queries:', queries);
    
    const allResults: SearchResult[] = [];
    const selectedSentenceIds = selectedSentences.map(s => s.id);
    
    // Search for each query
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      console.log(`🔍 Processing query ${i + 1}/${queries.length}: "${query}"`);
      
      const results = await this.searchWithBrave(query, 3);
      
      // Add contributing sentence IDs and quality scores to each result
      const resultsWithScoring = results.map(result => {
        const contentText = `${result.title} ${result.snippet}`;
        const qualityScore = this.calculateContentQualityScore(contentText, negativeKeywords);
        
        return {
          ...result,
          contributingSentenceIds: selectedSentenceIds,
          qualityScore
        };
      });
      
      allResults.push(...resultsWithScoring);
      
      // Add delay between requests
      if (i < queries.length - 1) {
        console.log('⏳ Waiting 2 seconds before next search...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Sort results by quality score with exponential weighting (higher quality first)
    const rankedResults = allResults.sort((a, b) => {
      // Square the quality score to exponentially penalize low quality content
      const qualityA = Math.pow(a.qualityScore || 1.0, 2);
      const qualityB = Math.pow(b.qualityScore || 1.0, 2);
      const scoreA = qualityA * (a.relevanceScore || 1.0);
      const scoreB = qualityB * (b.relevanceScore || 1.0);
      return scoreB - scoreA;
    });

    console.log(`📊 Ranked ${rankedResults.length} results by quality score`);
    
    // Store search session
    const session: SearchSession = {
      selectedSentences,
      results: rankedResults,
      feedback: [],
      timestamp: new Date()
    };
    
    this.searchHistory.push(session);
    
    return {
      results: rankedResults,
      selectedSentences
    };
  }

  /**
   * Fallback search query generation (original method)
   */
  private generateFallbackSearchQueries(selectedSentences: KeySentence[]): string[] {
    const allKeywords: string[] = [];
    
    selectedSentences.forEach(sentence => {
      allKeywords.push(...sentence.keywords);
      
      const words = sentence.text.toLowerCase()
        .split(/\s+/)
        .filter(word => 
          word.length > 3 && 
          !['latest', 'news', 'developments', 'about', 'regarding'].includes(word)
        );
      allKeywords.push(...words);
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
   * Enhanced feedback processing with targeted sentence updates
   */
  async processFeedback(feedback: UserFeedback[]): Promise<void> {
    console.log(`🔄 Processing ${feedback.length} feedback items...`);

    // Update ONLY the sentences that contributed to each result
    feedback.forEach(fb => {
      const contributingIds = fb.contributingSentenceIds || [];
      
      if (contributingIds.length === 0) {
        console.log('⚠️ No contributing sentence IDs found - falling back to updating all sentences');
        // Fallback: update all sentences (old behavior)
        this.keySentences.forEach(sentence => {
          if (fb.reaction === 'positive') {
            sentence.positiveReactions++;
          } else {
            sentence.negativeReactions++;
          }
          sentence.avgFeedback = sentence.positiveReactions / 
            (sentence.positiveReactions + sentence.negativeReactions);
        });
        return;
      }

      // Update only the contributing sentences
      contributingIds.forEach(sentenceId => {
        const sentence = this.keySentences.find(s => s.id === sentenceId);
        if (sentence) {
          if (fb.reaction === 'positive') {
            sentence.positiveReactions++;
            console.log(`➕ Increased positive reactions for sentence "${sentence.text}" (${sentence.positiveReactions}/${sentence.negativeReactions})`);
          } else {
            sentence.negativeReactions++;
            console.log(`➖ Increased negative reactions for sentence "${sentence.text}" (${sentence.positiveReactions}/${sentence.negativeReactions})`);
          }
          
          sentence.avgFeedback = sentence.positiveReactions / 
            (sentence.positiveReactions + sentence.negativeReactions);
        } else {
          console.log(`⚠️ Could not find sentence with ID: ${sentenceId}`);
        }
      });
    });

    // Process positive feedback to create new key sentences
    const positiveFeedback = feedback.filter(fb => fb.reaction === 'positive');
    
    for (const fb of positiveFeedback) {
      if (fb.extractedKeywords && fb.extractedKeywords.length > 0) {
        await this.addKeySentenceFromFeedback(fb.extractedKeywords);
      }
    }

    // Process negative feedback keywords and save them for quality scoring
    const negativeFeedback = feedback.filter(fb => fb.reaction === 'negative');
    
    for (const fb of negativeFeedback) {
      if (fb.extractedKeywords && fb.extractedKeywords.length > 0) {
        console.log(`🚫 Processing negative keywords: ${fb.extractedKeywords.join(', ')}`);
        // Save negative keywords to database for content quality scoring
        await this.saveNegativeKeywords(fb.extractedKeywords);
      }
    }

    console.log('✅ Feedback processed and system updated');
  }

  /**
   * Enhanced key sentence creation from feedback using LLM
   */
  private async addKeySentenceFromFeedback(keywords: string[]): Promise<void> {
    // Use LLM to create a more natural sentence from keywords
    const prompt = `Create a natural, search-friendly sentence that incorporates these keywords: ${keywords.join(', ')}

The sentence should be suitable for finding current news and developments. Make it specific and informative.

Format: Single sentence, no quotes or explanations.

Example: "Recent blockchain technology adoption in financial services and banking"

Your sentence:`;

    const llmResponse = await this.callLocalLLM(prompt);
    
    let sentenceText: string;
    if (llmResponse && llmResponse.trim().length > 10) {
      sentenceText = llmResponse.trim().replace(/^["']|["']$/g, ''); // Remove quotes
    } else {
      // Fallback to template
      sentenceText = `Recent developments in ${keywords.join(', ')}`;
    }

    const newSentence: KeySentence = {
      id: `feedback_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      text: sentenceText,
      source: 'feedback',
      createdAt: new Date(),
      timesUsed: 0,
      positiveReactions: 2, // Higher prior for feedback-derived sentences
      negativeReactions: 1,
      avgFeedback: 0.67,
      keywords
    };

    this.keySentences.push(newSentence);
    console.log(`➕ Added feedback sentence: "${sentenceText}"`);

    // Trim if needed
    this.trimKeySentences();
  }

  /**
   * Get current key sentences with their performance metrics
   */
  getKeySentencesStatus(): KeySentence[] {
    return this.keySentences.map(sentence => ({
      ...sentence,
      currentWeight: this.calculateTimeWeight(sentence.createdAt)
    }));
  }

  /**
   * Add new key sentence manually (e.g., from LLM generation)
   */
  addKeySentence(text: string, keywords: string[], source: 'user' | 'llm' = 'user'): void {
    const newSentence: KeySentence = {
      id: `manual_${Date.now()}`,
      text,
      source,
      createdAt: new Date(),
      timesUsed: 0,
      positiveReactions: 1,
      negativeReactions: 1,
      avgFeedback: 0.5,
      keywords
    };

    this.keySentences.push(newSentence);
  }

  /**
   * Load user's learned key sentences from database
   */
  async loadUserKeySentences(): Promise<void> {
    if (!this.supabase || !this.userId) {
      console.log('⚠️ No database connection or user ID - skipping sentence loading');
      return;
    }

    try {
      console.log('📚 Loading user key sentences from database...');
      
      const { data, error } = await this.supabase
        .from('user_key_sentences')
        .select('*')
        .eq('user_id', this.userId)
        .order('updated_at', { ascending: false });

      if (error) {
        console.error('❌ Error loading key sentences:', error);
        return;
      }

      if (data && data.length > 0) {
        // Convert database records to KeySentence objects
        const loadedSentences: KeySentence[] = data.map(row => ({
          id: row.sentence_id,
          text: row.text,
          source: row.source as 'user' | 'feedback' | 'llm',
          createdAt: new Date(row.created_at),
          timesUsed: row.times_used,
          positiveReactions: row.positive_reactions,
          negativeReactions: row.negative_reactions,
          avgFeedback: row.positive_reactions / (row.positive_reactions + row.negative_reactions),
          keywords: Array.isArray(row.keywords) ? row.keywords : []
        }));

        // Replace initial sentences with loaded ones
        this.keySentences = loadedSentences;
        console.log(`✅ Loaded ${loadedSentences.length} key sentences from database`);
      } else {
        console.log('📝 No existing key sentences found - using initial sentences');
      }
    } catch (error) {
      console.error('❌ Failed to load key sentences:', error);
    }
  }

  /**
   * Save user's key sentences to database
   */
  async saveUserKeySentences(): Promise<void> {
    if (!this.supabase || !this.userId) {
      console.log('⚠️ No database connection or user ID - skipping sentence saving');
      return;
    }

    try {
      console.log('💾 Saving key sentences to database...');

      // Prepare data for upsert
      const sentencesToSave = this.keySentences.map(sentence => ({
        user_id: this.userId,
        sentence_id: sentence.id,
        text: sentence.text,
        source: sentence.source,
        positive_reactions: sentence.positiveReactions,
        negative_reactions: sentence.negativeReactions,
        times_used: sentence.timesUsed,
        keywords: sentence.keywords,
        created_at: sentence.createdAt.toISOString(),
        updated_at: new Date().toISOString()
      }));

      // Use upsert to insert new or update existing sentences
      const { error } = await this.supabase
        .from('user_key_sentences')
        .upsert(sentencesToSave, {
          onConflict: 'user_id,sentence_id',
          ignoreDuplicates: false
        });

      if (error) {
        console.error('❌ Error saving key sentences:', error);
      } else {
        console.log(`✅ Saved ${sentencesToSave.length} key sentences to database`);
      }
    } catch (error) {
      console.error('❌ Failed to save key sentences:', error);
    }
  }

  /**
   * Synchronize key sentences with current interests
   * Removes sentences for interests that no longer exist and adds sentences for new interests
   */
  async syncWithCurrentInterests(): Promise<void> {
    if (!this.supabase || !this.userId) {
      console.log('⚠️ No database connection or user ID - skipping interest sync');
      return;
    }

    try {
      // Use the current interests from constructor
      const currentInterests = new Set(this.initialInterests);
      console.log('🔄 Syncing key sentences with current interests:', Array.from(currentInterests));

      // Remove sentences for interests that no longer exist
      const initialSentencesToRemove = this.keySentences.filter(sentence => 
        sentence.source === 'user' && 
        sentence.id.startsWith('init') &&
        sentence.keywords.some(keyword => !currentInterests.has(keyword))
      );

      if (initialSentencesToRemove.length > 0) {
        console.log(`🗑️ Removing ${initialSentencesToRemove.length} sentences for old interests:`, 
          initialSentencesToRemove.map(s => s.text));
        
        this.keySentences = this.keySentences.filter(sentence => 
          !initialSentencesToRemove.includes(sentence)
        );

        // Delete from database
        for (const sentence of initialSentencesToRemove) {
          await this.supabase
            .from('user_key_sentences')
            .delete()
            .eq('user_id', this.userId)
            .eq('sentence_id', sentence.id);
        }
      }

      // Check if we need to add sentences for new interests
      const existingInterestKeywords = new Set(
        this.keySentences
          .filter(s => s.source === 'user' && s.id.startsWith('init'))
          .flatMap(s => s.keywords)
      );

      const newInterests = Array.from(currentInterests).filter(
        interest => !existingInterestKeywords.has(interest)
      );

      if (newInterests.length > 0) {
        console.log(`➕ Adding sentences for new interests: ${newInterests.join(', ')}`);
        
        // Add new initial sentences for new interests
        for (const [index, interest] of newInterests.entries()) {
          const newSentence: KeySentence = {
            id: `init_new_${Date.now()}_${index}`,
            text: `Latest news and developments in ${interest}`,
            source: 'user',
            createdAt: new Date(),
            timesUsed: 0,
            positiveReactions: 1,
            negativeReactions: 1,
            avgFeedback: 0.5,
            keywords: [interest]
          };

          this.keySentences.push(newSentence);
        }
      }

      // Save updated sentences to database
      if (initialSentencesToRemove.length > 0 || newInterests.length > 0) {
        await this.saveUserKeySentences();
        console.log('✅ Interest synchronization completed');
      } else {
        console.log('✅ Key sentences already in sync with interests');
      }

    } catch (error) {
      console.error('❌ Failed to sync interests with key sentences:', error);
    }
  }

  /**
   * Initialize the system with database persistence and tree structure
   */
  async initializeWithPersistence(): Promise<void> {
    // Initialize tree manager if we have database connection
    if (this.supabase && this.userId) {
      this.treeManager = new TreeManager(this.supabase, this.userId);
      
      // Create or sync interest nodes in the tree
      await this.syncInterestsWithTree();
    }
    
    // Keep legacy system for backward compatibility
    await this.loadUserKeySentences();
    await this.syncWithCurrentInterests();
  }

  /**
   * Persist changes after feedback processing
   */
  async persistAfterFeedback(): Promise<void> {
    await this.saveUserKeySentences();
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
   * Synchronize user interests with tree structure
   */
  private async syncInterestsWithTree(): Promise<void> {
    if (!this.treeManager) return;

    try {
      console.log('🌳 Syncing interests with tree structure...');
      
      // Create interest nodes for each custom interest
      for (const interest of this.initialInterests) {
        const result = await this.treeManager.createInterestNode(interest, [interest]);
        
        if (result.success) {
          console.log(`✅ Created interest node: ${interest}`);
        } else if (result.error?.includes('duplicate') || result.error?.includes('unique')) {
          console.log(`ℹ️ Interest node already exists: ${interest}`);
        } else {
          console.error(`❌ Failed to create interest node for "${interest}":`, result.error);
        }
      }
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

    // Also process through legacy system for backward compatibility
    await this.processLegacyFeedback(feedback);
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
          contributingSentenceIds: fb.contributingSentenceIds,
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
              contributingSentenceIds: fb.contributingSentenceIds,
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
   * Legacy feedback processing (renamed for clarity)
   */
  private async processLegacyFeedback(feedback: UserFeedback[]): Promise<void> {
    // Update ONLY the sentences that contributed to each result
    feedback.forEach(fb => {
      const contributingIds = fb.contributingSentenceIds || [];
      
      if (contributingIds.length === 0) {
        console.log('⚠️ No contributing sentence IDs found - falling back to updating all sentences');
        // Fallback: update all sentences (old behavior)
        this.keySentences.forEach(sentence => {
          if (fb.reaction === 'positive') {
            sentence.positiveReactions++;
          } else {
            sentence.negativeReactions++;
          }
          sentence.avgFeedback = sentence.positiveReactions / 
            (sentence.positiveReactions + sentence.negativeReactions);
        });
        return;
      }

      // Update only the contributing sentences
      contributingIds.forEach(sentenceId => {
        const sentence = this.keySentences.find(s => s.id === sentenceId);
        if (sentence) {
          if (fb.reaction === 'positive') {
            sentence.positiveReactions++;
            console.log(`➕ Increased positive reactions for sentence "${sentence.text}" (${sentence.positiveReactions}/${sentence.negativeReactions})`);
          } else {
            sentence.negativeReactions++;
            console.log(`➖ Increased negative reactions for sentence "${sentence.text}" (${sentence.positiveReactions}/${sentence.negativeReactions})`);
          }
          
          sentence.avgFeedback = sentence.positiveReactions / 
            (sentence.positiveReactions + sentence.negativeReactions);
        } else {
          console.log(`⚠️ Could not find sentence with ID: ${sentenceId}`);
        }
      });
    });

    // Process positive feedback to create new key sentences
    const positiveFeedback = feedback.filter(fb => fb.reaction === 'positive');
    
    for (const fb of positiveFeedback) {
      if (fb.extractedKeywords && fb.extractedKeywords.length > 0) {
        await this.addKeySentenceFromFeedback(fb.extractedKeywords);
      }
    }

    // Process negative feedback keywords and save them for quality scoring
    const negativeFeedback = feedback.filter(fb => fb.reaction === 'negative');
    
    for (const fb of negativeFeedback) {
      if (fb.extractedKeywords && fb.extractedKeywords.length > 0) {
        console.log(`🚫 Processing negative keywords: ${fb.extractedKeywords.join(', ')}`);
        // Save negative keywords to database for content quality scoring
        await this.saveNegativeKeywords(fb.extractedKeywords);
      }
    }

    console.log('✅ Legacy feedback processed and system updated');
  }
}

/**
 * Legacy function for backward compatibility - now uses adaptive search
 */
export async function discoverInterestingContent(
  commonInterests: string[],
  customInterests: string[]
): Promise<SearchResult[]> {
  const allInterests = [...commonInterests, ...customInterests];
  const searchSystem = new AdaptiveSearchSystem(allInterests);
  
  const { results } = await searchSystem.searchBasedOnKeySentences(true);
  return results;
}