import type { SupabaseClient } from '@supabase/supabase-js';

// Embedding vector type (768 dimensions for nomic-embed-text)
export type EmbeddingVector = number[];

// Semantic cluster interface
export interface SemanticCluster {
  clusterId: string;
  name: string;
  keywords: string[];
  centerEmbedding: EmbeddingVector;
  memberCount: number;
}

// Interest relationship interface  
export interface InterestRelationship {
  nodeId: string;
  title: string;
  similarity: number;
  relationshipType: 'semantic' | 'geographic' | 'functional' | 'temporal';
}

// Combination suggestion interface
export interface CombinationSuggestion {
  sourceInterests: string[]; // Node IDs of source interests
  sourceTitles: string[]; // Titles for display
  combinedTitle: string;
  confidenceScore: number;
  combinationType: 'semantic_merge' | 'geographic_expansion' | 'skill_location' | 'industry_location';
  potentialQueries: string[];
  embedding: EmbeddingVector;
}

// Embedding analysis result
export interface EmbeddingAnalysis {
  clusters: SemanticCluster[];
  relationships: Map<string, InterestRelationship[]>;
  combinationSuggestions: CombinationSuggestion[];
  totalInterests: number;
  analysisTimestamp: Date;
}

/**
 * Service for managing embeddings, semantic analysis, and creative combinations
 */
export class EmbeddingService {
  private ollamaApiUrl: string;
  private embeddingModel: string;
  private supabase: SupabaseClient | null;
  private userId: string | null;

  constructor(
    ollamaApiUrl: string = 'http://localhost:11434',
    embeddingModel: string = 'nomic-embed-text',
    supabase?: SupabaseClient,
    userId?: string
  ) {
    this.ollamaApiUrl = ollamaApiUrl;
    this.embeddingModel = embeddingModel;
    this.supabase = supabase || null;
    this.userId = userId || null;
  }

  /**
   * Generate embedding for a single text
   */
  async generateEmbedding(text: string): Promise<EmbeddingVector> {
    try {
      console.log(`🧠 Generating embedding for: "${text}"`);
      
      const response = await fetch(`${this.ollamaApiUrl}/api/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.embeddingModel,
          prompt: text
        })
      });

      if (!response.ok) {
        throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      console.log(`✅ Generated embedding with ${data.embedding.length} dimensions`);
      return data.embedding;
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw error;
    }
  }

  /**
   * Generate embeddings for multiple texts in batch
   */
  async generateEmbeddingsBatch(texts: string[]): Promise<EmbeddingVector[]> {
    console.log(`🧠 Generating ${texts.length} embeddings in batch`);
    
    const embeddings: EmbeddingVector[] = [];
    
    // Process in smaller batches to avoid overwhelming the API
    const batchSize = 5;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchPromises = batch.map(text => this.generateEmbedding(text));
      const batchResults = await Promise.all(batchPromises);
      embeddings.push(...batchResults);
      
      // Small delay between batches
      if (i + batchSize < texts.length) {
        console.log(`⏳ Processed batch ${Math.floor(i/batchSize) + 1}, waiting before next batch...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log(`✅ Generated ${embeddings.length} embeddings`);
    return embeddings;
  }

  /**
   * Calculate cosine similarity between two embeddings
   */
  calculateCosineSimilarity(embedding1: EmbeddingVector, embedding2: EmbeddingVector): number {
    if (embedding1.length !== embedding2.length) {
      throw new Error('Embedding dimensions must match');
    }

    // Calculate dot product
    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;

    for (let i = 0; i < embedding1.length; i++) {
      dotProduct += embedding1[i] * embedding2[i];
      magnitude1 += embedding1[i] * embedding1[i];
      magnitude2 += embedding2[i] * embedding2[i];
    }

    // Calculate magnitudes
    magnitude1 = Math.sqrt(magnitude1);
    magnitude2 = Math.sqrt(magnitude2);

    // Calculate cosine similarity
    const similarity = dotProduct / (magnitude1 * magnitude2);
    return Math.max(-1, Math.min(1, similarity)); // Clamp to [-1, 1]
  }

  /**
   * Find similar interests based on embedding similarity
   */
  async findSimilarInterests(
    targetEmbedding: EmbeddingVector,
    candidateEmbeddings: Array<{nodeId: string, title: string, embedding: EmbeddingVector}>,
    topK: number = 5,
    minSimilarity: number = 0.3
  ): Promise<InterestRelationship[]> {
    const similarities = candidateEmbeddings.map(candidate => ({
      nodeId: candidate.nodeId,
      title: candidate.title,
      similarity: this.calculateCosineSimilarity(targetEmbedding, candidate.embedding),
      relationshipType: this.classifyRelationship(targetEmbedding, candidate.embedding)
    }));

    // Filter by minimum similarity and sort by similarity score
    return similarities
      .filter(item => item.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  /**
   * Classify the type of relationship between two interests based on embeddings
   */
  private classifyRelationship(embedding1: EmbeddingVector, embedding2: EmbeddingVector): 'semantic' | 'geographic' | 'functional' | 'temporal' {
    // For now, we'll use a simple heuristic
    // In a more sophisticated implementation, we could train a classifier
    const similarity = this.calculateCosineSimilarity(embedding1, embedding2);
    
    if (similarity > 0.8) {
      return 'semantic'; // Very similar concepts
    } else if (similarity > 0.6) {
      return 'functional'; // Related functions or domains
    } else if (similarity > 0.4) {
      return 'geographic'; // Potentially location-based relationships
    } else {
      return 'temporal'; // Time-based or contextual relationships
    }
  }

  /**
   * Generate creative combinations from interest embeddings
   */
  async generateCombinations(
    interests: Array<{nodeId: string, title: string, embedding: EmbeddingVector}>,
    maxCombinations: number = 10,
    minConfidence: number = 0.4
  ): Promise<CombinationSuggestion[]> {
    console.log(`🎨 Generating creative combinations from ${interests.length} interests`);
    
    const combinations: CombinationSuggestion[] = [];
    
    // Generate pairwise combinations
    for (let i = 0; i < interests.length; i++) {
      for (let j = i + 1; j < interests.length; j++) {
        const interest1 = interests[i];
        const interest2 = interests[j];
        
        const combination = await this.createCombination(interest1, interest2);
        if (combination.confidenceScore >= minConfidence) {
          combinations.push(combination);
        }
      }
    }
    
    // Sort by confidence score and return top combinations
    const topCombinations = combinations
      .sort((a, b) => b.confidenceScore - a.confidenceScore)
      .slice(0, maxCombinations);
    
    console.log(`✅ Generated ${topCombinations.length} high-confidence combinations`);
    return topCombinations;
  }

  /**
   * Create a combination from two interests
   */
  private async createCombination(
    interest1: {nodeId: string, title: string, embedding: EmbeddingVector},
    interest2: {nodeId: string, title: string, embedding: EmbeddingVector}
  ): Promise<CombinationSuggestion> {
    // Calculate similarity between interests
    const similarity = this.calculateCosineSimilarity(interest1.embedding, interest2.embedding);
    
    // Determine combination type based on content analysis
    const combinationType = this.determineCombinationType(interest1.title, interest2.title);
    
    // Generate combined title
    const combinedTitle = this.generateCombinedTitle(interest1.title, interest2.title, combinationType);
    
    // Average the embeddings (simple approach - could be more sophisticated)
    const combinedEmbedding = this.averageEmbeddings([interest1.embedding, interest2.embedding]);
    
    // Generate potential search queries
    const potentialQueries = this.generateSearchQueries(combinedTitle, interest1.title, interest2.title);
    
    // Calculate confidence score based on similarity and combination type
    const confidenceScore = this.calculateConfidenceScore(similarity, combinationType, interest1.title, interest2.title);
    
    return {
      sourceInterests: [interest1.nodeId, interest2.nodeId],
      sourceTitles: [interest1.title, interest2.title],
      combinedTitle,
      confidenceScore,
      combinationType,
      potentialQueries,
      embedding: combinedEmbedding
    };
  }

  /**
   * Determine the type of combination based on interest titles
   */
  private determineCombinationType(title1: string, title2: string): 'semantic_merge' | 'geographic_expansion' | 'skill_location' | 'industry_location' {
    const lower1 = title1.toLowerCase();
    const lower2 = title2.toLowerCase();
    
    // Geographic indicators
    const geographicTerms = ['spain', 'madrid', 'barcelona', 'valencia', 'europe', 'usa', 'california', 'london', 'paris', 'berlin', 'amsterdam', 'italy', 'france', 'germany', 'uk', 'remote'];
    
    // Skill/profession indicators
    const skillTerms = ['jobs', 'career', 'work', 'employment', 'developer', 'engineer', 'designer', 'manager', 'analyst', 'consultant', 'freelance'];
    
    // Industry indicators
    const industryTerms = ['tech', 'technology', 'ai', 'blockchain', 'drone', 'robotics', 'finance', 'healthcare', 'marketing', 'startup'];
    
    const hasGeo1 = geographicTerms.some(term => lower1.includes(term));
    const hasGeo2 = geographicTerms.some(term => lower2.includes(term));
    const hasSkill1 = skillTerms.some(term => lower1.includes(term));
    const hasSkill2 = skillTerms.some(term => lower2.includes(term));
    const hasIndustry1 = industryTerms.some(term => lower1.includes(term));
    const hasIndustry2 = industryTerms.some(term => lower2.includes(term));
    
    if ((hasSkill1 || hasSkill2) && (hasGeo1 || hasGeo2)) {
      return 'skill_location';
    } else if ((hasIndustry1 || hasIndustry2) && (hasGeo1 || hasGeo2)) {
      return 'industry_location';
    } else if (hasGeo1 || hasGeo2) {
      return 'geographic_expansion';
    } else {
      return 'semantic_merge';
    }
  }

  /**
   * Generate a combined title from two interest titles
   */
  private generateCombinedTitle(title1: string, title2: string, combinationType: string): string {
    const lower1 = title1.toLowerCase();
    const lower2 = title2.toLowerCase();
    
    switch (combinationType) {
      case 'skill_location':
        // Put skill first, then location
        if (this.isLocationTerm(title1)) {
          return `${title2} in ${title1}`;
        } else {
          return `${title1} in ${title2}`;
        }
      
      case 'industry_location':
        // Put industry first, then location  
        if (this.isLocationTerm(title1)) {
          return `${title2} ${title1}`;
        } else {
          return `${title1} ${title2}`;
        }
      
      case 'geographic_expansion':
        return `${title1} ${title2}`;
      
      case 'semantic_merge':
      default:
        return `${title1} ${title2}`;
    }
  }

  /**
   * Check if a term is location-related
   */
  private isLocationTerm(term: string): boolean {
    const geographicTerms = ['spain', 'madrid', 'barcelona', 'valencia', 'europe', 'usa', 'california', 'london', 'paris', 'berlin', 'amsterdam', 'italy', 'france', 'germany', 'uk', 'remote'];
    return geographicTerms.some(geo => term.toLowerCase().includes(geo));
  }

  /**
   * Generate potential search queries for a combination
   */
  private generateSearchQueries(combinedTitle: string, title1: string, title2: string): string[] {
    const queries = [
      combinedTitle,
      `${combinedTitle} opportunities`,
      `${combinedTitle} latest news`,
      `${combinedTitle} developments`
    ];
    
    // Add more specific queries based on content
    if (combinedTitle.includes('job') || combinedTitle.includes('career')) {
      queries.push(`${combinedTitle} openings`);
      queries.push(`${combinedTitle} positions`);
    }
    
    if (combinedTitle.includes('drone') || combinedTitle.includes('ai') || combinedTitle.includes('tech')) {
      queries.push(`${combinedTitle} innovation`);
      queries.push(`${combinedTitle} market`);
    }
    
    return queries.slice(0, 6); // Limit to 6 queries
  }

  /**
   * Calculate confidence score for a combination
   */
  private calculateConfidenceScore(
    similarity: number,
    combinationType: string,
    title1: string,
    title2: string
  ): number {
    let baseScore = similarity;
    
    // Boost score for high-value combination types
    switch (combinationType) {
      case 'skill_location':
        baseScore *= 1.3; // Skill + location combinations are usually valuable
        break;
      case 'industry_location':
        baseScore *= 1.2;
        break;
      case 'geographic_expansion':
        baseScore *= 1.1;
        break;
      case 'semantic_merge':
      default:
        baseScore *= 1.0;
    }
    
    // Penalize very similar titles (might be redundant)
    if (this.calculateTextSimilarity(title1, title2) > 0.8) {
      baseScore *= 0.7;
    }
    
    // Boost score for complementary terms
    if (this.hasComplementaryTerms(title1, title2)) {
      baseScore *= 1.2;
    }
    
    return Math.max(0, Math.min(1, baseScore));
  }

  /**
   * Calculate simple text similarity (Jaccard similarity)
   */
  private calculateTextSimilarity(text1: string, text2: string): number {
    const words1 = new Set(text1.toLowerCase().split(/\s+/));
    const words2 = new Set(text2.toLowerCase().split(/\s+/));
    
    const words1Array = Array.from(words1);
    const words2Array = Array.from(words2);
    const intersection = new Set(words1Array.filter(x => words2.has(x)));
    const union = new Set(words1Array.concat(words2Array));
    
    return intersection.size / union.size;
  }

  /**
   * Check if two titles have complementary terms
   */
  private hasComplementaryTerms(title1: string, title2: string): boolean {
    const complementaryPairs = [
      ['job', 'spain'], ['career', 'remote'], ['drone', 'pilot'],
      ['ai', 'engineer'], ['blockchain', 'developer'], ['tech', 'startup'],
      ['marketing', 'digital'], ['data', 'scientist']
    ];
    
    const lower1 = title1.toLowerCase();
    const lower2 = title2.toLowerCase();
    
    return complementaryPairs.some(([term1, term2]) => 
      (lower1.includes(term1) && lower2.includes(term2)) ||
      (lower1.includes(term2) && lower2.includes(term1))
    );
  }

  /**
   * Average multiple embeddings
   */
  private averageEmbeddings(embeddings: EmbeddingVector[]): EmbeddingVector {
    if (embeddings.length === 0) {
      throw new Error('Cannot average empty embedding array');
    }
    
    const dimensions = embeddings[0].length;
    const avgEmbedding = new Array(dimensions).fill(0);
    
    for (const embedding of embeddings) {
      for (let i = 0; i < dimensions; i++) {
        avgEmbedding[i] += embedding[i];
      }
    }
    
    for (let i = 0; i < dimensions; i++) {
      avgEmbedding[i] /= embeddings.length;
    }
    
    return avgEmbedding;
  }

  /**
   * Store embedding analysis results to database
   */
  async storeEmbeddingAnalysis(analysis: EmbeddingAnalysis): Promise<void> {
    if (!this.supabase || !this.userId) {
      console.log('⚠️ No database connection - skipping storage');
      return;
    }

    try {
      console.log('💾 Storing embedding analysis to database');
      
      // Store analysis metadata
      const { error: analysisError } = await this.supabase
        .from('embedding_analyses')
        .insert({
          user_id: this.userId,
          total_interests: analysis.totalInterests,
          clusters_count: analysis.clusters.length,
          relationships_count: Array.from(analysis.relationships.values()).reduce((sum, arr) => sum + arr.length, 0),
          combinations_count: analysis.combinationSuggestions.length,
          analysis_timestamp: analysis.analysisTimestamp.toISOString(),
          clusters_data: analysis.clusters,
          combinations_data: analysis.combinationSuggestions
        });

      if (analysisError) {
        console.error('❌ Error storing analysis:', analysisError);
      } else {
        console.log('✅ Embedding analysis stored successfully');
      }
    } catch (error) {
      console.error('❌ Failed to store embedding analysis:', error);
    }
  }

  /**
   * Load previous embedding analysis from database
   */
  async loadEmbeddingAnalysis(): Promise<EmbeddingAnalysis | null> {
    if (!this.supabase || !this.userId) {
      return null;
    }

    try {
      const { data, error } = await this.supabase
        .from('embedding_analyses')
        .select('*')
        .eq('user_id', this.userId)
        .order('analysis_timestamp', { ascending: false })
        .limit(1)
        .single();

      if (error || !data) {
        return null;
      }

      return {
        clusters: data.clusters_data || [],
        relationships: new Map(), // Would need to reconstruct this
        combinationSuggestions: data.combinations_data || [],
        totalInterests: data.total_interests,
        analysisTimestamp: new Date(data.analysis_timestamp)
      };
    } catch (error) {
      console.error('Failed to load embedding analysis:', error);
      return null;
    }
  }

  /**
   * Analyze all interest embeddings and generate insights
   */
  async analyzeInterestEmbeddings(
    interests: Array<{nodeId: string, title: string, embedding: EmbeddingVector}>
  ): Promise<EmbeddingAnalysis> {
    console.log(`🔬 Analyzing ${interests.length} interest embeddings`);
    
    // Find relationships between all interests
    const relationships = new Map<string, InterestRelationship[]>();
    
    for (const interest of interests) {
      const similarInterests = await this.findSimilarInterests(
        interest.embedding,
        interests.filter(i => i.nodeId !== interest.nodeId),
        5,
        0.3
      );
      relationships.set(interest.nodeId, similarInterests);
    }
    
    // Generate combination suggestions
    const combinationSuggestions = await this.generateCombinations(interests, 15, 0.4);
    
    // Create simple clusters based on high similarity
    const clusters = this.createSimpleClusters(interests, relationships);
    
    const analysis: EmbeddingAnalysis = {
      clusters,
      relationships,
      combinationSuggestions,
      totalInterests: interests.length,
      analysisTimestamp: new Date()
    };
    
    // Store analysis to database
    await this.storeEmbeddingAnalysis(analysis);
    
    console.log(`✅ Analysis complete: ${clusters.length} clusters, ${combinationSuggestions.length} combinations`);
    return analysis;
  }

  /**
   * Create simple clusters based on high similarity relationships
   */
  private createSimpleClusters(
    interests: Array<{nodeId: string, title: string, embedding: EmbeddingVector}>,
    relationships: Map<string, InterestRelationship[]>
  ): SemanticCluster[] {
    const clusters: SemanticCluster[] = [];
    const clustered = new Set<string>();
    
    for (const interest of interests) {
      if (clustered.has(interest.nodeId)) continue;
      
      const relatedInterests = relationships.get(interest.nodeId) || [];
      const highSimilarityRelated = relatedInterests.filter(rel => rel.similarity > 0.7);
      
      if (highSimilarityRelated.length > 0) {
        const clusterMembers = [interest, ...interests.filter(i => 
          highSimilarityRelated.some(rel => rel.nodeId === i.nodeId)
        )];
        
        const centerEmbedding = this.averageEmbeddings(clusterMembers.map(m => m.embedding));
        const keywords = Array.from(new Set(
          clusterMembers.flatMap(m => m.title.toLowerCase().split(/\s+/))
        )).slice(0, 5);
        
        clusters.push({
          clusterId: `cluster_${clusters.length + 1}`,
          name: `${interest.title} cluster`,
          keywords,
          centerEmbedding,
          memberCount: clusterMembers.length
        });
        
        clusterMembers.forEach(member => clustered.add(member.nodeId));
      }
    }
    
    return clusters;
  }
}

// Export utility functions
export function createEmbeddingService(
  supabase?: SupabaseClient,
  userId?: string,
  ollamaUrl: string = 'http://localhost:11434',
  model: string = 'nomic-embed-text'
): EmbeddingService {
  return new EmbeddingService(ollamaUrl, model, supabase, userId);
}

export default EmbeddingService;