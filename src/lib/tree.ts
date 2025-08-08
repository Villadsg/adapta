import { supabase } from './supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { EmbeddingVector, InterestRelationship, CombinationSuggestion } from './embeddings';

// Core tree node interface
export interface TreeNode {
  id: string; // Database id
  nodeId: string; // Unique node identifier
  userId: string;
  parentNodeId: string | null;
  
  // Node classification
  nodeType: 'interest' | 'news' | 'combination';
  title: string;
  contentData: Record<string, any>;
  
  // Tree structure
  depth: number;
  path: string[]; // Array of node_ids from root to this node
  
  // Thompson Sampling metrics
  positiveReactions: number;
  negativeReactions: number;
  qualityScore: number;
  timesSelected: number;
  
  // Content metadata (for news nodes)
  url?: string;
  snippet?: string;
  keywords: string[];
  
  // Embedding fields
  embedding?: EmbeddingVector;
  embeddingModel?: string;
  embeddingGeneratedAt?: Date;
  
  // Status and lifecycle
  status: 'active' | 'archived' | 'hidden';
  approvalStatus: 'pending' | 'approved' | 'rejected';
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt?: Date;
}

// Interest node (root nodes)
export interface InterestNode extends TreeNode {
  nodeType: 'interest';
  parentNodeId: null; // Always null for root nodes
  depth: 0; // Always 0 for root nodes
  interestName: string; // Same as title, but more semantic
  
  // Embedding fields (required for interests)
  embedding: EmbeddingVector;
  embeddingModel: string;
  embeddingGeneratedAt: Date;
  
  // Related interests based on embeddings
  relatedInterests?: InterestRelationship[];
}

// News node (child nodes that can have their own children)
export interface NewsNode extends TreeNode {
  nodeType: 'news';
  parentNodeId: string; // Always has a parent
  depth: number; // 1 or higher
  
  // Required fields for news nodes
  url: string;
  snippet: string;
  
  // Search metadata
  contributingSentenceIds?: string[]; // Which sentences led to discovering this news
  relevanceScore?: number;
  searchQuery?: string; // Original query that found this news
}

// Combination node (creative combinations of interests)
export interface CombinationNode extends TreeNode {
  nodeType: 'combination';
  parentNodeId: null; // Combinations are typically root-level nodes
  depth: 0; // Usually root level
  
  // Combination-specific fields
  sourceNodeIds: string[]; // IDs of the interests that were combined
  sourceTitles: string[]; // Titles of the source interests for display
  combinationType: 'semantic_merge' | 'geographic_expansion' | 'skill_location' | 'industry_location';
  confidenceScore: number; // Confidence in this combination (0.0-1.0)
  potentialQueries: string[]; // Suggested search queries for this combination
  
  // Embedding fields (required for combinations)
  embedding: EmbeddingVector;
  embeddingModel: string;
  embeddingGeneratedAt: Date;
  
  // Performance tracking
  searchAttempts?: number;
  successfulSearches?: number;
  averageResultsFound?: number;
}

// Tree operation result types
export interface TreeOperationResult {
  success: boolean;
  nodeId?: string;
  error?: string;
  affectedNodes?: string[];
}

// Node selection result for Thompson Sampling
export interface NodeSelectionResult {
  selectedNodes: TreeNode[];
  selectionScores: Map<string, number>;
  totalCandidates: number;
}

// Tree traversal options
export interface TreeTraversalOptions {
  maxDepth?: number;
  nodeTypes?: ('interest' | 'news')[];
  statuses?: ('active' | 'archived' | 'hidden')[];
  approvalStatuses?: ('pending' | 'approved' | 'rejected')[];
  minQualityScore?: number;
  sortBy?: 'quality' | 'recent' | 'usage';
  limit?: number;
}

// Feedback processing for tree nodes
export interface TreeFeedback {
  nodeId: string;
  reaction: 'positive' | 'negative';
  timestamp: Date;
  metadata?: {
    searchQuery?: string;
    contributingSentenceIds?: string[];
    userComment?: string;
  };
}

// Tree statistics and analytics
export interface TreeStatistics {
  totalNodes: number;
  nodesByType: {
    interest: number;
    news: number;
  };
  nodesByDepth: Map<number, number>;
  nodesByStatus: {
    active: number;
    archived: number;
    hidden: number;
  };
  averageQualityScore: number;
  topPerformingNodes: TreeNode[];
  recentActivity: {
    nodesCreated: number;
    feedbackReceived: number;
    lastActivity: Date;
  };
}

// Tree manager class for all tree operations
export class TreeManager {
  private supabase: SupabaseClient;
  private userId: string;

  constructor(supabase: SupabaseClient, userId: string) {
    this.supabase = supabase;
    this.userId = userId;
  }

  /**
   * Create a new interest node (root node)
   */
  async createInterestNode(interestName: string, keywords: string[] = []): Promise<TreeOperationResult> {
    try {
      const nodeId = `interest_${interestName.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`;
      
      const { data, error } = await this.supabase
        .from('news_interest_tree')
        .insert({
          node_id: nodeId,
          user_id: this.userId,
          parent_node_id: null,
          node_type: 'interest',
          title: interestName,
          content_data: { interestName, originalKeywords: keywords },
          depth: 0,
          path: [nodeId],
          keywords: keywords,
          status: 'active',
          approval_status: 'approved' // Interests are auto-approved
        })
        .select()
        .single();

      if (error) throw error;

      return {
        success: true,
        nodeId: nodeId,
        affectedNodes: [nodeId]
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create interest node'
      };
    }
  }

  /**
   * Create a new news node as child of an existing node
   */
  async createNewsNode(
    parentNodeId: string,
    title: string,
    url: string,
    snippet: string,
    keywords: string[] = [],
    metadata: Record<string, any> = {}
  ): Promise<TreeOperationResult> {
    try {
      const nodeId = `news_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      
      // Get parent node to build path
      const { data: parentNode, error: parentError } = await this.supabase
        .from('news_interest_tree')
        .select('path, depth')
        .eq('user_id', this.userId)
        .eq('node_id', parentNodeId)
        .single();

      if (parentError) throw parentError;

      const newPath = [...parentNode.path, nodeId];
      const newDepth = parentNode.depth + 1;

      const { data, error } = await this.supabase
        .from('news_interest_tree')
        .insert({
          node_id: nodeId,
          user_id: this.userId,
          parent_node_id: parentNodeId,
          node_type: 'news',
          title: title,
          content_data: metadata,
          depth: newDepth,
          path: newPath,
          url: url,
          snippet: snippet,
          keywords: keywords,
          status: 'active',
          approval_status: 'pending' // News starts as pending
        })
        .select()
        .single();

      if (error) throw error;

      return {
        success: true,
        nodeId: nodeId,
        affectedNodes: [nodeId]
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create news node'
      };
    }
  }

  /**
   * Process feedback on a tree node with cascading effects
   */
  async processFeedback(feedback: TreeFeedback): Promise<TreeOperationResult> {
    try {
      const affectedNodes: string[] = [feedback.nodeId];
      
      // Update the target node
      if (feedback.reaction === 'positive') {
        await this.supabase
          .rpc('increment_positive_reactions', {
            p_user_id: this.userId,
            p_node_id: feedback.nodeId
          });
      } else {
        await this.supabase
          .rpc('increment_negative_reactions', {
            p_user_id: this.userId,
            p_node_id: feedback.nodeId
          });
      }

      // Cascade feedback to children (using stored procedure for efficiency)
      const { data: cascadeResults } = await this.supabase.rpc('cascade_quality_to_children', {
        p_user_id: this.userId,
        p_node_id: feedback.nodeId,
        p_reaction: feedback.reaction
      });

      // Add all affected child nodes to the affected nodes list
      if (cascadeResults && Array.isArray(cascadeResults)) {
        const childNodeIds = cascadeResults.map((result: any) => result.affected_node_id);
        affectedNodes.push(...childNodeIds);
        console.log(`🌊 Cascaded feedback to ${childNodeIds.length} child nodes:`, childNodeIds);
      }

      return {
        success: true,
        nodeId: feedback.nodeId,
        affectedNodes: affectedNodes
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to process feedback'
      };
    }
  }

  /**
   * Get tree nodes using Interest-Aware Selection (replaces Thompson Sampling)
   */
  async selectNodesForDiscovery(
    options: TreeTraversalOptions = {},
    sampleCount: number = 3,
    currentInterests: string[] = [],
    embeddingService?: any
  ): Promise<NodeSelectionResult> {
    try {
      console.log(`🔍 Selecting nodes with Interest-Aware algorithm for interests: [${currentInterests.join(', ')}]`);
      
      // Build query based on options
      let query = this.supabase
        .from('news_interest_tree')
        .select('*')
        .eq('user_id', this.userId)
        .eq('status', 'active');

      if (options.nodeTypes?.length) {
        query = query.in('node_type', options.nodeTypes);
      }
      
      if (options.approvalStatuses?.length) {
        query = query.in('approval_status', options.approvalStatuses);
      }
      
      if (options.maxDepth !== undefined) {
        query = query.lte('depth', options.maxDepth);
      }
      
      if (options.minQualityScore !== undefined) {
        query = query.gte('quality_score', options.minQualityScore);
      }

      const { data: nodes, error } = await query;
      if (error) throw error;

      // Convert to TreeNode objects
      const treeNodes: TreeNode[] = nodes.map(this.dbRowToTreeNode);
      
      console.log(`📊 Found ${treeNodes.length} candidate nodes for selection`);
      
      // Apply Interest-Aware Selection
      const selectedNodes = this.selectInterestAwareNodes(treeNodes, sampleCount, currentInterests, embeddingService);
      
      // Calculate selection scores for analytics
      const selectionScores = new Map<string, number>();
      selectedNodes.forEach(node => {
        const score = this.calculateInterestAwareScore(node, currentInterests, embeddingService);
        selectionScores.set(node.nodeId, score);
      });

      // Update times_selected for selected nodes
      for (const node of selectedNodes) {
        await this.supabase
          .from('news_interest_tree')
          .update({
            times_selected: (node.timesSelected || 0) + 1,
            last_used_at: new Date().toISOString()
          })
          .eq('user_id', this.userId)
          .eq('node_id', node.nodeId);
      }

      console.log(`✅ Selected ${selectedNodes.length} nodes using Interest-Aware algorithm`);

      return {
        selectedNodes,
        selectionScores,
        totalCandidates: treeNodes.length
      };
    } catch (error) {
      console.error('Failed to select nodes:', error);
      return {
        selectedNodes: [],
        selectionScores: new Map(),
        totalCandidates: 0
      };
    }
  }

  /**
   * Interest-Aware Selection implementation (replaces Thompson Sampling)
   */
  private selectInterestAwareNodes(
    nodes: TreeNode[], 
    count: number, 
    currentInterests: string[],
    embeddingService?: any
  ): TreeNode[] {
    if (nodes.length === 0) return [];
    
    // Calculate interest-aware scores for each node
    const scoredNodes = nodes.map(node => ({
      node,
      score: this.calculateInterestAwareScore(node, currentInterests, embeddingService)
    }));

    // Sort by score and select top N
    const selectedNodes = scoredNodes
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .map(item => item.node);

    console.log(`🎯 Interest-aware selection results:`);
    scoredNodes.slice(0, Math.min(5, scoredNodes.length)).forEach((item, i) => {
      console.log(`   ${i + 1}. "${item.node.title}" - Score: ${item.score.toFixed(3)}`);
    });

    return selectedNodes;
  }

  /**
   * Calculate Interest-Aware score combining multiple factors
   */
  private calculateInterestAwareScore(
    node: TreeNode, 
    currentInterests: string[],
    embeddingService?: any
  ): number {
    // 1. Base quality score with temporal decay
    const baseQuality = this.calculateDecayedQuality(node);
    
    // 2. Interest relevance (embedding-based if available)
    const interestRelevance = embeddingService 
      ? this.calculateInterestRelevance(node, currentInterests, embeddingService)
      : this.calculateKeywordRelevance(node, currentInterests);
    
    // 3. Freshness and exploration bonuses
    const freshnessBonus = this.calculateFreshnessBonus(node);
    const explorationBonus = this.calculateExplorationBonus(node);
    
    // 4. Diversity factor (prevent over-selection)
    const diversityFactor = this.calculateDiversityFactor(node);
    
    // 5. Combine all factors
    const finalScore = baseQuality * interestRelevance * freshnessBonus * explorationBonus * diversityFactor;
    
    return Math.max(0, Math.min(10, finalScore)); // Clamp to reasonable range
  }

  /**
   * Calculate quality score with temporal decay
   */
  private calculateDecayedQuality(node: TreeNode): number {
    const alpha = node.positiveReactions;
    const beta = node.negativeReactions;
    const baseQuality = alpha / (alpha + beta);
    
    // Apply temporal decay based on when the node was last used
    const now = Date.now();
    const lastUsed = node.lastUsedAt ? node.lastUsedAt.getTime() : node.createdAt.getTime();
    const daysSinceLastUsed = (now - lastUsed) / (1000 * 60 * 60 * 24);
    
    // Decay factor: content loses relevance over time
    const decayFactor = Math.exp(-daysSinceLastUsed / 30); // 30-day half-life
    
    return baseQuality * (0.3 + 0.7 * decayFactor); // Minimum 30% of original quality
  }

  /**
   * Calculate interest relevance using embeddings
   */
  private calculateInterestRelevance(
    node: TreeNode, 
    currentInterests: string[],
    embeddingService: any
  ): number {
    if (!node.embedding || currentInterests.length === 0) {
      return this.calculateKeywordRelevance(node, currentInterests);
    }

    try {
      // This would normally use cached embeddings for interests
      // For now, use keyword-based relevance as fallback
      return this.calculateKeywordRelevance(node, currentInterests);
    } catch (error) {
      console.error('Error calculating embedding relevance:', error);
      return this.calculateKeywordRelevance(node, currentInterests);
    }
  }

  /**
   * Calculate keyword-based relevance (fallback when embeddings unavailable)
   */
  private calculateKeywordRelevance(node: TreeNode, currentInterests: string[]): number {
    if (currentInterests.length === 0) return 0.5; // Neutral when no interests

    const nodeText = `${node.title} ${node.keywords.join(' ')}`.toLowerCase();
    let totalRelevance = 0;

    for (const interest of currentInterests) {
      const interestWords = interest.toLowerCase().split(/\s+/);
      let interestScore = 0;

      for (const word of interestWords) {
        if (word.length > 2 && nodeText.includes(word)) {
          interestScore += 1;
        }
      }

      // Normalize by number of words in interest
      totalRelevance += interestScore / interestWords.length;
    }

    // Normalize by number of interests and apply scaling
    const avgRelevance = totalRelevance / currentInterests.length;
    return Math.min(1.0, avgRelevance * 2); // Scale up to make relevance more impactful
  }

  /**
   * Calculate freshness bonus for recent content
   */
  private calculateFreshnessBonus(node: TreeNode): number {
    const now = Date.now();
    const created = node.createdAt.getTime();
    const ageInDays = (now - created) / (1000 * 60 * 60 * 24);
    
    // Fresh content gets a bonus, very old content gets slightly penalized
    if (ageInDays < 1) return 1.5;      // Very recent: 50% bonus
    if (ageInDays < 7) return 1.2;      // This week: 20% bonus  
    if (ageInDays < 30) return 1.0;     // This month: neutral
    if (ageInDays < 90) return 0.9;     // Last 3 months: slight penalty
    return 0.8;                         // Older: 20% penalty
  }

  /**
   * Calculate exploration bonus for under-explored content
   */
  private calculateExplorationBonus(node: TreeNode): number {
    const timesSelected = node.timesSelected || 0;
    
    // Boost nodes that haven't been selected much
    if (timesSelected === 0) return 2.0;      // Never selected: 100% bonus
    if (timesSelected < 3) return 1.5;        // Lightly selected: 50% bonus
    if (timesSelected < 10) return 1.0;       // Moderately selected: neutral
    if (timesSelected < 25) return 0.9;       // Heavily selected: slight penalty
    return 0.7;                               // Overused: 30% penalty
  }

  /**
   * Calculate diversity factor to prevent over-selection
   */
  private calculateDiversityFactor(node: TreeNode): number {
    const timesSelected = node.timesSelected || 0;
    
    // Stronger penalty for heavily selected nodes
    if (timesSelected > 20) return 0.5;       // Very overused: 50% penalty
    if (timesSelected > 10) return 0.7;       // Overused: 30% penalty
    if (timesSelected > 5) return 0.9;        // Heavily used: 10% penalty
    return 1.0;                               // Normal usage: no penalty
  }


  /**
   * Get children of a specific node
   */
  async getChildren(
    parentNodeId: string,
    options: TreeTraversalOptions = {}
  ): Promise<TreeNode[]> {
    try {
      const { data, error } = await this.supabase.rpc('get_child_nodes', {
        p_user_id: this.userId,
        p_parent_node_id: parentNodeId,
        p_max_depth: options.maxDepth || 10
      });

      if (error) throw error;
      
      return data.map((row: any) => ({
        ...this.dbRowToTreeNode(row),
        // RPC returns limited fields, so we create a minimal node
        id: '', 
        userId: this.userId,
        contentData: {},
        path: [],
        timesSelected: 0,
        status: 'active',
        updatedAt: new Date(),
        keywords: []
      }));
    } catch (error) {
      console.error('Failed to get children:', error);
      return [];
    }
  }

  /**
   * Get tree statistics
   */
  async getTreeStatistics(): Promise<TreeStatistics> {
    try {
      const { data: nodes, error } = await this.supabase
        .from('news_interest_tree')
        .select('*')
        .eq('user_id', this.userId);

      if (error) throw error;

      const treeNodes = nodes.map(this.dbRowToTreeNode);
      
      // Calculate statistics
      const nodesByType = treeNodes.reduce((acc, node) => {
        acc[node.nodeType]++;
        return acc;
      }, { interest: 0, news: 0 });

      const nodesByDepth = treeNodes.reduce((acc, node) => {
        acc.set(node.depth, (acc.get(node.depth) || 0) + 1);
        return acc;
      }, new Map<number, number>());

      const nodesByStatus = treeNodes.reduce((acc, node) => {
        acc[node.status]++;
        return acc;
      }, { active: 0, archived: 0, hidden: 0 });

      const avgQuality = treeNodes.length > 0 
        ? treeNodes.reduce((sum, node) => sum + node.qualityScore, 0) / treeNodes.length
        : 0;

      const topNodes = treeNodes
        .sort((a, b) => b.qualityScore - a.qualityScore)
        .slice(0, 5);

      return {
        totalNodes: treeNodes.length,
        nodesByType,
        nodesByDepth,
        nodesByStatus,
        averageQualityScore: avgQuality,
        topPerformingNodes: topNodes,
        recentActivity: {
          nodesCreated: treeNodes.filter(n => 
            Date.now() - n.createdAt.getTime() < 7 * 24 * 60 * 60 * 1000
          ).length,
          feedbackReceived: treeNodes.reduce((sum, n) => 
            sum + n.positiveReactions + n.negativeReactions - 2, 0
          ), // Subtract 2 for initial priors
          lastActivity: treeNodes.length > 0 
            ? new Date(Math.max(...treeNodes.map(n => n.updatedAt.getTime())))
            : new Date()
        }
      };
    } catch (error) {
      console.error('Failed to get tree statistics:', error);
      throw error;
    }
  }

  /**
   * Convert database row to TreeNode object
   */
  private dbRowToTreeNode(row: any): TreeNode {
    return {
      id: row.id,
      nodeId: row.node_id,
      userId: row.user_id,
      parentNodeId: row.parent_node_id,
      nodeType: row.node_type,
      title: row.title,
      contentData: row.content_data || {},
      depth: row.depth,
      path: row.path || [],
      positiveReactions: row.positive_reactions,
      negativeReactions: row.negative_reactions,
      qualityScore: parseFloat(row.quality_score),
      timesSelected: row.times_selected,
      url: row.url,
      snippet: row.snippet,
      keywords: row.keywords || [],
      
      // Embedding fields
      embedding: row.embedding ? (Array.isArray(row.embedding) ? row.embedding : JSON.parse(row.embedding)) : undefined,
      embeddingModel: row.embedding_model,
      embeddingGeneratedAt: row.embedding_generated_at ? new Date(row.embedding_generated_at) : undefined,
      
      status: row.status,
      approvalStatus: row.approval_status,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined
    };
  }

  /**
   * Remove an interest node and its direct children only (preserving grandchildren and deeper)
   * Grandchildren get promoted to be direct children of remaining interests or orphaned
   */
  async removeInterestAndDirectChildren(interestName: string): Promise<TreeOperationResult> {
    try {
      const affectedNodes: string[] = [];
      
      // Find the interest node
      const { data: interestNodes, error: findError } = await this.supabase
        .from('news_interest_tree')
        .select('*')
        .eq('user_id', this.userId)
        .eq('node_type', 'interest')
        .eq('title', interestName)
        .eq('status', 'active');

      if (findError) throw findError;
      
      if (!interestNodes || interestNodes.length === 0) {
        return {
          success: false,
          error: `Interest node "${interestName}" not found`
        };
      }

      const interestNode = interestNodes[0];
      const interestNodeId = interestNode.node_id;
      affectedNodes.push(interestNodeId);

      // Find direct children (depth = 1) of this interest
      const { data: directChildren, error: childrenError } = await this.supabase
        .from('news_interest_tree')
        .select('*')
        .eq('user_id', this.userId)
        .eq('parent_node_id', interestNodeId)
        .eq('depth', 1)
        .eq('status', 'active');

      if (childrenError) throw childrenError;

      // Find grandchildren (depth = 2) that need to be preserved
      const directChildIds = directChildren?.map(child => child.node_id) || [];
      let grandchildren: any[] = [];
      
      if (directChildIds.length > 0) {
        const { data: grandchildrenData, error: grandchildrenError } = await this.supabase
          .from('news_interest_tree')
          .select('*')
          .eq('user_id', this.userId)
          .in('parent_node_id', directChildIds)
          .eq('depth', 2)
          .eq('status', 'active');

        if (grandchildrenError) throw grandchildrenError;
        grandchildren = grandchildrenData || [];
      }

      console.log(`🗑️ Removing interest "${interestName}" with ${directChildren?.length || 0} direct children`);
      console.log(`🔄 Preserving ${grandchildren.length} grandchildren by orphaning them`);

      // Step 1: Handle grandchildren - set them as orphaned or reassign to other interests
      for (const grandchild of grandchildren) {
        await this.supabase
          .from('news_interest_tree')
          .update({
            parent_node_id: null, // Orphan them - they become root-level nodes
            depth: 0,
            path: [grandchild.node_id],
            updated_at: new Date().toISOString()
          })
          .eq('id', grandchild.id);
        
        console.log(`🔄 Orphaned grandchild: "${grandchild.title}"`);
      }

      // Step 2: Remove direct children
      if (directChildren && directChildren.length > 0) {
        const { error: deleteChildrenError } = await this.supabase
          .from('news_interest_tree')
          .update({
            status: 'archived',
            updated_at: new Date().toISOString()
          })
          .eq('user_id', this.userId)
          .in('node_id', directChildIds);

        if (deleteChildrenError) throw deleteChildrenError;
        
        affectedNodes.push(...directChildIds);
        console.log(`🗑️ Archived ${directChildIds.length} direct children`);
      }

      // Step 3: Remove the interest node itself
      const { error: deleteInterestError } = await this.supabase
        .from('news_interest_tree')
        .update({
          status: 'archived',
          updated_at: new Date().toISOString()
        })
        .eq('user_id', this.userId)
        .eq('node_id', interestNodeId);

      if (deleteInterestError) throw deleteInterestError;

      console.log(`✅ Successfully removed interest "${interestName}" and its direct children`);
      console.log(`📊 Total affected nodes: ${affectedNodes.length}`);

      return {
        success: true,
        nodeId: interestNodeId,
        affectedNodes: affectedNodes
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to remove interest and children'
      };
    }
  }

  /**
   * Generate embedding for a node using EmbeddingService
   */
  async generateNodeEmbedding(nodeId: string, embeddingService: any): Promise<TreeOperationResult> {
    try {
      // Get the node data
      const { data: node, error: fetchError } = await this.supabase
        .from('news_interest_tree')
        .select('*')
        .eq('user_id', this.userId)
        .eq('node_id', nodeId)
        .single();

      if (fetchError) throw fetchError;

      // Generate embedding based on node content
      const embeddingText = this.getEmbeddingText(node);
      const embedding = await embeddingService.generateEmbedding(embeddingText);

      // Update the node with embedding data
      const { error: updateError } = await this.supabase
        .from('news_interest_tree')
        .update({
          embedding: JSON.stringify(embedding),
          embedding_model: embeddingService.embeddingModel,
          embedding_generated_at: new Date().toISOString()
        })
        .eq('user_id', this.userId)
        .eq('node_id', nodeId);

      if (updateError) throw updateError;

      console.log(`✅ Generated embedding for node: ${nodeId}`);
      return {
        success: true,
        nodeId: nodeId
      };
    } catch (error) {
      console.error(`❌ Failed to generate embedding for node ${nodeId}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate embedding'
      };
    }
  }

  /**
   * Generate embeddings for all nodes of specified types
   */
  async generateEmbeddingsForAllNodes(embeddingService: any, nodeTypes: string[] = ['interest']): Promise<TreeOperationResult> {
    try {
      console.log(`🧠 Starting embedding generation for ${nodeTypes.join(', ')} nodes`);
      
      // Get all nodes that need embeddings
      const { data: nodes, error: fetchError } = await this.supabase
        .from('news_interest_tree')
        .select('node_id, title, keywords, url, snippet, node_type')
        .eq('user_id', this.userId)
        .in('node_type', nodeTypes)
        .eq('status', 'active')
        .is('embedding', null);

      if (fetchError) throw fetchError;

      if (!nodes || nodes.length === 0) {
        console.log('✅ All nodes already have embeddings');
        return { success: true };
      }

      console.log(`📝 Found ${nodes.length} nodes needing embeddings`);
      
      const processedNodes: string[] = [];
      const failedNodes: string[] = [];

      // Process nodes in batches to avoid overwhelming the embedding API
      const batchSize = 3;
      for (let i = 0; i < nodes.length; i += batchSize) {
        const batch = nodes.slice(i, i + batchSize);
        console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(nodes.length/batchSize)}`);
        
        const batchPromises = batch.map(async (node) => {
          try {
            const result = await this.generateNodeEmbedding(node.node_id, embeddingService);
            if (result.success) {
              processedNodes.push(node.node_id);
            } else {
              failedNodes.push(node.node_id);
            }
          } catch (error) {
            console.error(`Failed to process node ${node.node_id}:`, error);
            failedNodes.push(node.node_id);
          }
        });
        
        await Promise.all(batchPromises);
        
        // Small delay between batches
        if (i + batchSize < nodes.length) {
          console.log('⏳ Waiting 2 seconds before next batch...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      console.log(`✅ Embedding generation complete. Processed: ${processedNodes.length}, Failed: ${failedNodes.length}`);
      
      return {
        success: true,
        affectedNodes: processedNodes
      };
    } catch (error) {
      console.error('❌ Failed to generate embeddings:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate embeddings'
      };
    }
  }

  /**
   * Create combination node from embedding analysis
   */
  async createCombinationNode(
    combinationSuggestion: any, // CombinationSuggestion type from embeddings.ts
    embeddingService: any
  ): Promise<TreeOperationResult> {
    try {
      console.log(`🎨 Creating combination node: "${combinationSuggestion.combinedTitle}"`);
      
      // Call the database function to create combination node
      const { data, error } = await this.supabase.rpc('create_combination_node', {
        p_user_id: this.userId,
        p_source_node_ids: combinationSuggestion.sourceInterests,
        p_combined_title: combinationSuggestion.combinedTitle,
        p_combination_type: combinationSuggestion.combinationType,
        p_confidence_score: combinationSuggestion.confidenceScore,
        p_potential_queries: combinationSuggestion.potentialQueries,
        p_embedding: JSON.stringify(combinationSuggestion.embedding),
        p_keywords: combinationSuggestion.potentialQueries.slice(0, 5)
      });

      if (error) throw error;

      const newNodeId = data;
      console.log(`✅ Created combination node: ${newNodeId}`);
      
      return {
        success: true,
        nodeId: newNodeId
      };
    } catch (error) {
      console.error('❌ Failed to create combination node:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create combination node'
      };
    }
  }

  /**
   * Get all nodes with embeddings for analysis
   */
  async getNodesWithEmbeddings(nodeTypes: string[] = ['interest', 'combination']): Promise<any[]> {
    try {
      const { data, error } = await this.supabase.rpc('get_nodes_with_embeddings', {
        p_user_id: this.userId,
        p_node_types: nodeTypes
      });

      if (error) throw error;

      // Convert embeddings from JSON strings to arrays
      return data.map((row: any) => ({
        nodeId: row.node_id,
        title: row.title,
        nodeType: row.node_type,
        embedding: Array.isArray(row.embedding) ? row.embedding : JSON.parse(row.embedding || '[]'),
        keywords: row.keywords || [],
        qualityScore: row.quality_score,
        createdAt: row.created_at
      }));
    } catch (error) {
      console.error('Failed to get nodes with embeddings:', error);
      return [];
    }
  }

  /**
   * Get text to use for embedding generation
   */
  private getEmbeddingText(node: any): string {
    const title = node.title || '';
    const keywords = Array.isArray(node.keywords) ? node.keywords.join(' ') : '';
    const snippet = node.snippet || '';
    
    // Combine title, keywords and snippet for richer embeddings
    return `${title} ${keywords} ${snippet}`.trim();
  }

  /**
   * Enhanced interest removal with semantic cleanup
   */
  async removeInterestWithSemanticCleanup(
    interestName: string, 
    remainingInterests: string[],
    embeddingService: any
  ): Promise<TreeOperationResult> {
    try {
      console.log(`🗑️ Starting enhanced removal of interest: "${interestName}"`);
      const affectedNodes: string[] = [];

      // Phase 1: Remove the core interest and its direct children
      const coreRemovalResult = await this.removeInterestAndDirectChildren(interestName);
      if (!coreRemovalResult.success) {
        return coreRemovalResult;
      }
      affectedNodes.push(...(coreRemovalResult.affectedNodes || []));

      // Phase 2: Clean up combinations containing the deleted interest
      const combinationCleanupResult = await this.cleanupCombinationsContaining(interestName);
      affectedNodes.push(...(combinationCleanupResult.affectedNodes || []));

      // Phase 3: Semantic cleanup of orphaned content
      if (embeddingService && remainingInterests.length > 0) {
        const semanticCleanupResult = await this.performSemanticCleanup(remainingInterests, embeddingService);
        affectedNodes.push(...(semanticCleanupResult.affectedNodes || []));
      }

      console.log(`✅ Enhanced interest removal complete. Total affected nodes: ${affectedNodes.length}`);
      return {
        success: true,
        affectedNodes: affectedNodes
      };
    } catch (error) {
      console.error(`❌ Enhanced interest removal failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Enhanced interest removal failed'
      };
    }
  }

  /**
   * Clean up combination nodes containing a specific interest
   */
  async cleanupCombinationsContaining(interestName: string): Promise<TreeOperationResult> {
    try {
      console.log(`🧹 Cleaning up combinations containing: "${interestName}"`);

      // Find combinations that include this interest in their source titles
      const { data: combinations, error: fetchError } = await this.supabase
        .from('news_interest_tree')
        .select('*')
        .eq('user_id', this.userId)
        .eq('node_type', 'combination')
        .eq('status', 'active');

      if (fetchError) throw fetchError;

      const affectedNodes: string[] = [];

      if (combinations && combinations.length > 0) {
        for (const combo of combinations) {
          // Check if this combination involves the deleted interest
          const sourceNodeIds = combo.source_node_ids || [];
          const sourceTitles = combo.title || '';
          
          // Find source nodes to check their titles
          if (sourceNodeIds.length > 0) {
            const { data: sourceNodes } = await this.supabase
              .from('news_interest_tree')
              .select('title, node_id')
              .eq('user_id', this.userId)
              .in('node_id', sourceNodeIds);

            const involvesDeletedInterest = sourceNodes?.some(node => 
              node.title.toLowerCase().includes(interestName.toLowerCase())
            ) || sourceTitles.toLowerCase().includes(interestName.toLowerCase());

            if (involvesDeletedInterest) {
              // Archive this combination
              await this.supabase
                .from('news_interest_tree')
                .update({
                  status: 'archived',
                  updated_at: new Date().toISOString()
                })
                .eq('user_id', this.userId)
                .eq('node_id', combo.node_id);

              affectedNodes.push(combo.node_id);
              console.log(`🗑️ Archived combination: "${combo.title}"`);
            }
          }
        }
      }

      console.log(`✅ Combination cleanup complete. Archived ${affectedNodes.length} combinations`);
      return {
        success: true,
        affectedNodes: affectedNodes
      };
    } catch (error) {
      console.error('❌ Combination cleanup failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Combination cleanup failed'
      };
    }
  }

  /**
   * Perform semantic cleanup of orphaned content using embeddings
   */
  async performSemanticCleanup(
    remainingInterests: string[],
    embeddingService: any
  ): Promise<TreeOperationResult> {
    try {
      console.log(`🧠 Performing semantic cleanup with remaining interests: [${remainingInterests.join(', ')}]`);

      // Get embeddings for remaining interests
      const interestEmbeddings = [];
      for (const interest of remainingInterests) {
        const embedding = await embeddingService.generateEmbedding(interest);
        interestEmbeddings.push({ interest, embedding });
      }

      // Find orphaned content (nodes with no parent or archived parent)
      const { data: orphanedNodes, error: fetchError } = await this.supabase
        .from('news_interest_tree')
        .select('*')
        .eq('user_id', this.userId)
        .eq('status', 'active')
        .in('node_type', ['news', 'combination'])
        .is('parent_node_id', null); // Orphaned nodes

      if (fetchError) throw fetchError;

      const affectedNodes: string[] = [];
      const relevanceThreshold = 0.3; // Minimum similarity to keep content

      if (orphanedNodes && orphanedNodes.length > 0) {
        console.log(`🔍 Evaluating ${orphanedNodes.length} orphaned nodes for relevance`);

        for (const node of orphanedNodes) {
          // Generate embedding for this node's content
          const nodeText = this.getEmbeddingText(node);
          const nodeEmbedding = await embeddingService.generateEmbedding(nodeText);

          // Calculate maximum similarity to any remaining interest
          let maxSimilarity = 0;
          let mostRelevantInterest = '';

          for (const { interest, embedding } of interestEmbeddings) {
            const similarity = embeddingService.calculateCosineSimilarity(nodeEmbedding, embedding);
            if (similarity > maxSimilarity) {
              maxSimilarity = similarity;
              mostRelevantInterest = interest;
            }
          }

          console.log(`📊 Node "${node.title}" similarity to "${mostRelevantInterest}": ${maxSimilarity.toFixed(3)}`);

          if (maxSimilarity < relevanceThreshold) {
            // Archive irrelevant content
            await this.supabase
              .from('news_interest_tree')
              .update({
                status: 'archived',
                updated_at: new Date().toISOString()
              })
              .eq('user_id', this.userId)
              .eq('node_id', node.node_id);

            affectedNodes.push(node.node_id);
            console.log(`🗑️ Archived irrelevant content: "${node.title}" (similarity: ${maxSimilarity.toFixed(3)})`);
          } else {
            console.log(`✅ Keeping relevant content: "${node.title}" (similarity: ${maxSimilarity.toFixed(3)})`);
          }

          // Add small delay to avoid overwhelming the embedding API
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      console.log(`✅ Semantic cleanup complete. Archived ${affectedNodes.length} irrelevant nodes`);
      return {
        success: true,
        affectedNodes: affectedNodes
      };
    } catch (error) {
      console.error('❌ Semantic cleanup failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Semantic cleanup failed'
      };
    }
  }

  // Utility method to create tree manager instance
  static async create(userId: string): Promise<TreeManager> {
    return new TreeManager(supabase, userId);
  }
}

// Export utility functions
export async function createTreeManager(userId: string): Promise<TreeManager> {
  return TreeManager.create(userId);
}

export default TreeManager;