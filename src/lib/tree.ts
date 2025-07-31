import { supabase } from './supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

// Core tree node interface
export interface TreeNode {
  id: string; // Database id
  nodeId: string; // Unique node identifier
  userId: string;
  parentNodeId: string | null;
  
  // Node classification
  nodeType: 'interest' | 'news';
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
          .from('news_interest_tree')
          .update({
            positive_reactions: this.supabase.raw('positive_reactions + 1'),
            last_used_at: new Date().toISOString(),
            approval_status: 'approved' // Positive feedback approves the node
          })
          .eq('user_id', this.userId)
          .eq('node_id', feedback.nodeId);
      } else {
        await this.supabase
          .from('news_interest_tree')
          .update({
            negative_reactions: this.supabase.raw('negative_reactions + 1'),
            last_used_at: new Date().toISOString(),
            approval_status: 'rejected' // Negative feedback rejects the node
          })
          .eq('user_id', this.userId)
          .eq('node_id', feedback.nodeId);
      }

      // Cascade feedback to parents (using stored procedure for efficiency)
      await this.supabase.rpc('cascade_quality_to_parents', {
        p_user_id: this.userId,
        p_node_id: feedback.nodeId,
        p_reaction: feedback.reaction
      });

      // Get all parent nodes for affected nodes list
      const { data: nodeData } = await this.supabase
        .from('news_interest_tree')
        .select('path')
        .eq('user_id', this.userId)
        .eq('node_id', feedback.nodeId)
        .single();

      if (nodeData?.path) {
        affectedNodes.push(...nodeData.path.filter(id => id !== feedback.nodeId));
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
   * Get tree nodes using Thompson Sampling for selection
   */
  async selectNodesForDiscovery(
    options: TreeTraversalOptions = {},
    sampleCount: number = 3
  ): Promise<NodeSelectionResult> {
    try {
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
      
      // Apply Thompson Sampling selection
      const selectedNodes = this.thompsonSampleNodes(treeNodes, sampleCount);
      
      // Calculate selection scores for analytics
      const selectionScores = new Map<string, number>();
      selectedNodes.forEach(node => {
        const score = this.calculateThompsonScore(node);
        selectionScores.set(node.nodeId, score);
      });

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
   * Thompson Sampling implementation for node selection
   */
  private thompsonSampleNodes(nodes: TreeNode[], count: number): TreeNode[] {
    if (nodes.length === 0) return [];
    
    // Calculate Thompson sampling scores for each node
    const scoredNodes = nodes.map(node => ({
      node,
      score: this.calculateThompsonScore(node)
    }));

    // Sort by score and select top N
    return scoredNodes
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .map(item => item.node);
  }

  /**
   * Calculate Thompson Sampling score for a node
   */
  private calculateThompsonScore(node: TreeNode): number {
    // Beta distribution sampling approximation
    const alpha = node.positiveReactions;
    const beta = node.negativeReactions;
    
    const mean = alpha / (alpha + beta);
    const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
    const stdDev = Math.sqrt(variance);
    
    // Box-Muller transform for normal distribution approximation
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    
    const thompsonScore = Math.max(0, Math.min(1, mean + z * stdDev));
    
    // Apply time decay
    const timeWeight = this.calculateTimeWeight(node.createdAt);
    
    // Apply diversity penalty for overused nodes
    const diversityPenalty = node.timesSelected > 5 ? 0.8 : 1.0;
    
    return thompsonScore * timeWeight * diversityPenalty;
  }

  /**
   * Calculate time-based exponential decay weight
   */
  private calculateTimeWeight(timestamp: Date, decayRate: number = 0.95): number {
    const daysOld = (Date.now() - timestamp.getTime()) / (1000 * 60 * 60 * 24);
    return Math.pow(decayRate, daysOld);
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
      status: row.status,
      approvalStatus: row.approval_status,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined
    };
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