import { TavilySearchResults } from '@langchain/community/tools/tavily_search';
import { DuckDuckGoSearch } from '@langchain/community/tools/duckduckgo_search';

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
    }
  ) {
    this.llmConfig = llmConfig;
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
      return this.generateSearchQueries(selectedSentences);
    }

    const queries = llmResponse
      .split('\n')
      .map(line => line.trim().replace(/^[-"'•]\s*/, '').replace(/["']$/, ''))
      .filter(line => line.length > 5 && line.length < 50)
      .slice(0, maxQueries);

    return queries.length > 0 ? queries : this.generateSearchQueries(selectedSentences);
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
        id: `llm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
   * Search with DuckDuckGo (keeping original logic)
   */
  private async searchWithDuckDuckGo(query: string, maxResults: number = 3): Promise<SearchResult[]> {
    try {
      console.log(`🔍 Searching DuckDuckGo for: "${query}"`);
      
      const search = new DuckDuckGoSearch({ maxResults });
      const results = await search.invoke(query);
      
      const parsedResults: SearchResult[] = [];
      
      if (typeof results === 'string') {
        const lines = results.split('\n').filter(line => line.trim());
        
        for (let i = 0; i < lines.length; i += 3) {
          if (i + 2 < lines.length) {
            parsedResults.push({
              title: lines[i].replace(/^\d+\.\s*/, ''),
              snippet: lines[i + 1],
              url: lines[i + 2]
            });
          }
        }
      }
      
      console.log(`✅ Found ${parsedResults.length} results for "${query}"`);
      return parsedResults;
    } catch (error) {
      console.error('DuckDuckGo search error:', error);
      return [];
    }
  }

  /**
   * Main search function with LLM integration
   */
  async searchBasedOnKeySentences(useLLM: boolean = true): Promise<{ results: SearchResult[], selectedSentences: KeySentence[] }> {
    this.totalSearches++;
    
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
    
    console.log('🔍 Using search queries:', queries);
    
    const allResults: SearchResult[] = [];
    
    // Search for each query
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      console.log(`🔍 Processing query ${i + 1}/${queries.length}: "${query}"`);
      
      const results = await this.searchWithDuckDuckGo(query, 3);
      allResults.push(...results);
      
      // Add delay between requests
      if (i < queries.length - 1) {
        console.log('⏳ Waiting 8 seconds before next search...');
        await new Promise(resolve => setTimeout(resolve, 8000));
      }
    }

    // Store search session
    const session: SearchSession = {
      selectedSentences,
      results: allResults,
      feedback: [],
      timestamp: new Date()
    };
    
    this.searchHistory.push(session);
    
    return {
      results: allResults,
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
   * Enhanced feedback processing with LLM keyword extraction
   */
  async processFeedback(feedback: UserFeedback[]): Promise<void> {
    const currentSession = this.searchHistory[this.searchHistory.length - 1];
    if (!currentSession) return;

    currentSession.feedback = feedback;

    // Update key sentence scores based on feedback
    feedback.forEach(fb => {
      currentSession.selectedSentences.forEach(sentence => {
        if (fb.reaction === 'positive') {
          sentence.positiveReactions++;
        } else {
          sentence.negativeReactions++;
        }
        
        sentence.avgFeedback = sentence.positiveReactions / 
          (sentence.positiveReactions + sentence.negativeReactions);
      });
    });

    // Process positive feedback to create new key sentences
    const positiveFeedback = feedback.filter(fb => fb.reaction === 'positive');
    
    for (const fb of positiveFeedback) {
      if (fb.extractedKeywords && fb.extractedKeywords.length > 0) {
        await this.addKeySentenceFromFeedback(fb.extractedKeywords);
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
      id: `feedback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
}

/**
 * Example usage of the adaptive search system with LLM integration
 */
export async function exampleUsage() {
  // Initialize system with user interests and LLM config
  const searchSystem = new AdaptiveSearchSystem(
    ['business', 'stocks', 'isaac sim'],
    {
      apiUrl: 'http://localhost:11434/api/generate',
      model: 'deepseek-r1:8b',
      temperature: 0.7,
      maxTokens: 200
    }
  );

  // Generate enhanced key sentences using LLM
  await searchSystem.generateEnhancedKeySentences(2);

  // Perform search with LLM-enhanced queries
  const { results, selectedSentences } = await searchSystem.searchBasedOnKeySentences(true);
  
  console.log('Selected sentences for search:', selectedSentences.map(s => s.text));
  console.log('Search results:', results);

  // Simulate user feedback
  const feedback: UserFeedback[] = [
    {
      resultId: 'result1',
      reaction: 'positive',
      timestamp: new Date(),
      extractedKeywords: ['nvidia', 'simulation', 'robotics', 'enterprise']
    },
    {
      resultId: 'result2',
      reaction: 'negative',
      timestamp: new Date()
    }
  ];

  // Process feedback with LLM enhancement
  await searchSystem.processFeedback(feedback);

  // View current key sentences status
  console.log('Key sentences status:', searchSystem.getKeySentencesStatus());

  // Perform another search to see learning in action
  console.log('\n--- Second search after feedback ---');
  const { results: results2 } = await searchSystem.searchBasedOnKeySentences(true);
  console.log('New search results:', results2.length);
}