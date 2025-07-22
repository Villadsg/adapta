/**
 * Semantic Interest Tracking with Ollama Qwen3-Embedding-8B
 * Pure TypeScript implementation without Python dependencies
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';

const EMBEDDINGS_FILE = 'user_embeddings.json';
const CONFIG_FILE = 'interest_config.json';
const EMBEDDING_MODEL = 'dengcao/Qwen3-Embedding-8B:Q5_K_M';
const OLLAMA_URL = 'http://localhost:11434';

export interface InterestConfig {
	userInputWeight: number;
	assistantOutputWeight: number;
	recencyDecay: number;
	similarityThreshold: number;
	maxInterests: number;
}

export interface ConversationEmbedding {
	text: string;
	embedding: number[];
	weight: number;
	timestamp: number;
	source: 'input' | 'output';
	clusterId?: number;
}

export interface EmbeddingsData {
	embeddings: ConversationEmbedding[];
	lastUpdated: number;
}

export class OllamaEmbeddingsStore {
	private config: InterestConfig;
	private embeddings: ConversationEmbedding[] = [];

	constructor() {
		this.config = this.loadConfig();
		this.embeddings = this.loadEmbeddings();
	}

	private getDefaultConfig(): InterestConfig {
		return {
			userInputWeight: 3.0,
			assistantOutputWeight: 1.0,
			recencyDecay: 0.95,
			similarityThreshold: 0.7,
			maxInterests: 1000
		};
	}

	private loadConfig(): InterestConfig {
		if (!existsSync(CONFIG_FILE)) {
			const config = this.getDefaultConfig();
			this.saveConfig(config);
			return config;
		}

		try {
			const data = readFileSync(CONFIG_FILE, 'utf8');
			return JSON.parse(data);
		} catch (error) {
			console.error('Error loading config:', error);
			return this.getDefaultConfig();
		}
	}

	private saveConfig(config: InterestConfig): void {
		try {
			writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
		} catch (error) {
			console.error('Error saving config:', error);
		}
	}

	private loadEmbeddings(): ConversationEmbedding[] {
		if (!existsSync(EMBEDDINGS_FILE)) {
			return [];
		}

		try {
			const data = readFileSync(EMBEDDINGS_FILE, 'utf8');
			const embeddingsData: EmbeddingsData = JSON.parse(data);
			return embeddingsData.embeddings || [];
		} catch (error) {
			console.error('Error loading embeddings:', error);
			return [];
		}
	}

	private saveEmbeddings(): void {
		try {
			const data: EmbeddingsData = {
				embeddings: this.embeddings,
				lastUpdated: Date.now()
			};
			writeFileSync(EMBEDDINGS_FILE, JSON.stringify(data, null, 2));
		} catch (error) {
			console.error('Error saving embeddings:', error);
		}
	}

	/**
	 * Create embedding using Ollama Qwen3-Embedding-8B model
	 */
	private async createEmbedding(text: string): Promise<number[]> {
		console.log(`🧠 Creating embedding for text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
		console.log(`📡 Using model: ${EMBEDDING_MODEL}`);
		
		try {
			const requestBody = {
				model: EMBEDDING_MODEL,
				prompt: text
			};
			
			console.log('📤 Sending request to Ollama:', `${OLLAMA_URL}/api/embeddings`);
			
			const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(requestBody),
			});

			console.log(`📥 Ollama response status: ${response.status}`);

			if (!response.ok) {
				const errorText = await response.text();
				console.error('❌ Ollama API error response:', errorText);
				throw new Error(`Ollama API responded with status: ${response.status} - ${errorText}`);
			}

			const data = await response.json();
			console.log(`✅ Embedding created successfully. Dimensions: ${data.embedding?.length || 'unknown'}`);
			
			if (!data.embedding || !Array.isArray(data.embedding)) {
				console.error('❌ Invalid embedding response:', data);
				throw new Error('Invalid embedding response from Ollama');
			}
			
			return data.embedding;
		} catch (error) {
			console.error('❌ Error creating embedding:', error);
			if (error instanceof Error) {
				console.error('Error details:', error.message);
			}
			throw error;
		}
	}

	/**
	 * Calculate cosine similarity between two embeddings
	 */
	private cosineSimilarity(a: number[], b: number[]): number {
		if (a.length !== b.length) {
			throw new Error('Embeddings must have the same dimension');
		}

		let dotProduct = 0;
		let normA = 0;
		let normB = 0;

		for (let i = 0; i < a.length; i++) {
			dotProduct += a[i] * b[i];
			normA += a[i] * a[i];
			normB += b[i] * b[i];
		}

		normA = Math.sqrt(normA);
		normB = Math.sqrt(normB);

		if (normA === 0 || normB === 0) {
			return 0;
		}

		return dotProduct / (normA * normB);
	}

	/**
	 * Apply recency decay to existing embeddings
	 */
	private applyRecencyWeights(): void {
		const currentTime = Date.now();
		
		for (const embedding of this.embeddings) {
			const timeDiff = currentTime - embedding.timestamp;
			const daysOld = timeDiff / (24 * 60 * 60 * 1000); // Convert to days
			const decayFactor = Math.pow(this.config.recencyDecay, daysOld);
			embedding.weight *= decayFactor;
		}
	}

	/**
	 * Find similar embeddings using cosine similarity
	 */
	private findSimilarEmbeddings(
		newEmbedding: number[], 
		threshold?: number
	): Array<{ index: number; similarity: number }> {
		if (this.embeddings.length === 0) {
			return [];
		}

		const similarityThreshold = threshold || this.config.similarityThreshold;
		const similarities: Array<{ index: number; similarity: number }> = [];

		for (let i = 0; i < this.embeddings.length; i++) {
			const similarity = this.cosineSimilarity(newEmbedding, this.embeddings[i].embedding);
			if (similarity >= similarityThreshold) {
				similarities.push({ index: i, similarity });
			}
		}

		return similarities.sort((a, b) => b.similarity - a.similarity);
	}

	/**
	 * Simple clustering based on similarity threshold
	 */
	private clusterEmbeddings(): void {
		// Reset cluster IDs
		this.embeddings.forEach(emb => emb.clusterId = undefined);

		let nextClusterId = 0;
		const visited = new Set<number>();

		for (let i = 0; i < this.embeddings.length; i++) {
			if (visited.has(i)) continue;

			const cluster: number[] = [i];
			visited.add(i);

			// Find all similar embeddings to form a cluster
			const similar = this.findSimilarEmbeddings(this.embeddings[i].embedding);
			
			for (const { index } of similar) {
				if (!visited.has(index) && index !== i) {
					cluster.push(index);
					visited.add(index);
				}
			}

			// Assign cluster ID if cluster has more than one member
			if (cluster.length > 1) {
				for (const embIndex of cluster) {
					this.embeddings[embIndex].clusterId = nextClusterId;
				}
				nextClusterId++;
			}
		}
	}

	/**
	 * Add conversation embeddings with semantic analysis
	 */
	async addConversation(userMessage: string, assistantMessage: string): Promise<void> {
		console.log('🔄 Starting conversation processing...');
		console.log(`👤 User message: "${userMessage.substring(0, 100)}${userMessage.length > 100 ? '...' : ''}"`);
		console.log(`🤖 Assistant message: "${assistantMessage.substring(0, 100)}${assistantMessage.length > 100 ? '...' : ''}"`);
		
		const timestamp = Date.now();
		let processedAny = false;

		// Apply recency decay to existing embeddings
		this.applyRecencyWeights();

		// Process user input (higher weight)
		if (userMessage.trim()) {
			try {
				console.log('🔍 Processing user input...');
				const userEmbedding = await this.createEmbedding(userMessage);
				
				// Check for similar user inputs to avoid duplicates
				const similar = this.findSimilarEmbeddings(userEmbedding, 0.9);
				if (similar.length > 0) {
					console.log(`♻️ Found ${similar.length} similar user inputs, boosting existing embedding`);
					// Boost weight of most similar existing embedding
					const mostSimilarIdx = similar[0].index;
					this.embeddings[mostSimilarIdx].weight += this.config.userInputWeight * 0.5;
					this.embeddings[mostSimilarIdx].timestamp = timestamp;
				} else {
					console.log('✨ Adding new user input embedding');
					// Add new embedding
					this.embeddings.push({
						text: userMessage,
						embedding: userEmbedding,
						weight: this.config.userInputWeight,
						timestamp,
						source: 'input'
					});
				}
				processedAny = true;
			} catch (error) {
				console.error('❌ Error processing user message:', error);
				// Continue processing assistant message even if user message fails
			}
		}

		// Process assistant output (lower weight)
		if (assistantMessage.trim()) {
			try {
				console.log('🔍 Processing assistant output...');
				const assistantEmbedding = await this.createEmbedding(assistantMessage);
				
				// Check for similar assistant outputs
				const similar = this.findSimilarEmbeddings(assistantEmbedding, 0.9);
				if (similar.length > 0) {
					console.log(`♻️ Found ${similar.length} similar assistant outputs, boosting existing embedding`);
					// Boost weight of most similar existing embedding
					const mostSimilarIdx = similar[0].index;
					this.embeddings[mostSimilarIdx].weight += this.config.assistantOutputWeight * 0.5;
					this.embeddings[mostSimilarIdx].timestamp = timestamp;
				} else {
					console.log('✨ Adding new assistant output embedding');
					// Add new embedding
					this.embeddings.push({
						text: assistantMessage,
						embedding: assistantEmbedding,
						weight: this.config.assistantOutputWeight,
						timestamp,
						source: 'output'
					});
				}
				processedAny = true;
			} catch (error) {
				console.error('❌ Error processing assistant message:', error);
			}
		}

		if (!processedAny) {
			console.warn('⚠️ No messages were processed successfully');
			return;
		}

		// Limit total embeddings
		if (this.embeddings.length > this.config.maxInterests) {
			console.log(`🧹 Limiting embeddings to ${this.config.maxInterests} (had ${this.embeddings.length})`);
			this.embeddings.sort((a, b) => b.weight - a.weight);
			this.embeddings = this.embeddings.slice(0, this.config.maxInterests);
		}

		// Re-cluster embeddings
		console.log('🔗 Re-clustering embeddings...');
		this.clusterEmbeddings();

		// Save to file
		console.log('💾 Saving embeddings to file...');
		this.saveEmbeddings();
		
		console.log(`✅ Conversation processed successfully. Total embeddings: ${this.embeddings.length}`);
	}

	/**
	 * Get top interests by weight with clustering information
	 */
	getTopInterests(limit: number = 20): Array<{
		text: string;
		weight: number;
		source: string;
		timestamp: number;
		clusterId?: number;
		preview: string;
	}> {
		const sortedEmbeddings = [...this.embeddings].sort((a, b) => b.weight - a.weight);
		
		return sortedEmbeddings.slice(0, limit).map(emb => ({
			text: emb.text,
			weight: Math.round(emb.weight * 100) / 100,
			source: emb.source,
			timestamp: emb.timestamp,
			clusterId: emb.clusterId,
			preview: emb.text.length > 100 ? emb.text.slice(0, 100) + '...' : emb.text
		}));
	}

	/**
	 * Generate detailed statistical analysis of interests
	 */
	private generateStatistics(): {
		totalInteractions: number;
		userQuestions: number;
		assistantResponses: number;
		totalClusters: number;
		averageWeight: number;
		timespan: { days: number; firstInteraction: Date; lastInteraction: Date } | null;
		topSources: { input: number; output: number };
		weightDistribution: { high: number; medium: number; low: number };
	} {
		if (this.embeddings.length === 0) {
			return {
				totalInteractions: 0,
				userQuestions: 0,
				assistantResponses: 0,
				totalClusters: 0,
				averageWeight: 0,
				timespan: null,
				topSources: { input: 0, output: 0 },
				weightDistribution: { high: 0, medium: 0, low: 0 }
			};
		}

		const userQuestions = this.embeddings.filter(e => e.source === 'input').length;
		const assistantResponses = this.embeddings.filter(e => e.source === 'output').length;
		
		const clusterIds = new Set(
			this.embeddings
				.map(emb => emb.clusterId)
				.filter(id => id !== undefined)
		);
		
		const totalWeight = this.embeddings.reduce((sum, emb) => sum + emb.weight, 0);
		const averageWeight = totalWeight / this.embeddings.length;
		
		const timestamps = this.embeddings.map(e => e.timestamp).sort((a, b) => a - b);
		const timespan = timestamps.length > 1 ? {
			days: Math.ceil((timestamps[timestamps.length - 1] - timestamps[0]) / (24 * 60 * 60 * 1000)),
			firstInteraction: new Date(timestamps[0]),
			lastInteraction: new Date(timestamps[timestamps.length - 1])
		} : null;

		// Weight distribution
		const weights = this.embeddings.map(e => e.weight);
		const maxWeight = Math.max(...weights);
		const weightDistribution = {
			high: weights.filter(w => w > maxWeight * 0.7).length,
			medium: weights.filter(w => w > maxWeight * 0.3 && w <= maxWeight * 0.7).length,
			low: weights.filter(w => w <= maxWeight * 0.3).length
		};

		return {
			totalInteractions: this.embeddings.length,
			userQuestions,
			assistantResponses,
			totalClusters: clusterIds.size,
			averageWeight: Math.round(averageWeight * 100) / 100,
			timespan,
			topSources: { input: userQuestions, output: assistantResponses },
			weightDistribution
		};
	}

	/**
	 * Generate comprehensive interest summary using clustering and AI analysis
	 */
	async getDetailedInterestSummary(): Promise<string> {
		if (this.embeddings.length === 0) {
			return "No interests tracked yet. Start chatting to build your semantic interest profile!";
		}

		console.log('📊 Generating detailed interest summary...');

		// Get statistical analysis
		const stats = this.generateStatistics();

		// Group by clusters
		const clusters: Map<number, ConversationEmbedding[]> = new Map();
		const unclustered: ConversationEmbedding[] = [];

		for (const emb of this.embeddings) {
			if (emb.clusterId !== undefined) {
				if (!clusters.has(emb.clusterId)) {
					clusters.set(emb.clusterId, []);
				}
				clusters.get(emb.clusterId)!.push(emb);
			} else {
				unclustered.push(emb);
			}
		}

		// Prepare cluster summaries
		const clusterSummaries: Array<{
			id: number;
			topics: string[];
			totalWeight: number;
			count: number;
			representative: string;
			userQuestions: number;
			assistantResponses: number;
		}> = [];

		for (const [clusterId, clusterEmbs] of clusters) {
			clusterEmbs.sort((a, b) => b.weight - a.weight);
			const totalWeight = clusterEmbs.reduce((sum, emb) => sum + emb.weight, 0);
			const representative = clusterEmbs[0];
			
			clusterSummaries.push({
				id: clusterId,
				topics: clusterEmbs.map(e => e.text.length > 100 ? e.text.slice(0, 100) + '...' : e.text),
				totalWeight,
				count: clusterEmbs.length,
				representative: representative.text,
				userQuestions: clusterEmbs.filter(e => e.source === 'input').length,
				assistantResponses: clusterEmbs.filter(e => e.source === 'output').length
			});
		}

		// Sort clusters by weight
		clusterSummaries.sort((a, b) => b.totalWeight - a.totalWeight);

		// Prepare data for AI analysis
		const topClusters = clusterSummaries.slice(0, 5);
		const topUnclustered = unclustered
			.sort((a, b) => b.weight - a.weight)
			.slice(0, 5)
			.map(e => e.text.length > 100 ? e.text.slice(0, 100) + '...' : e.text);

		// Create comprehensive summary
		let detailedSummary = `# 🧠 Semantic Interest Analysis\n\n`;

		// Statistics section
		detailedSummary += `## 📊 Overview\n`;
		detailedSummary += `- **Total Interactions**: ${stats.totalInteractions}\n`;
		detailedSummary += `- **Your Questions**: ${stats.userQuestions}\n`;
		detailedSummary += `- **AI Responses**: ${stats.assistantResponses}\n`;
		detailedSummary += `- **Interest Clusters**: ${stats.totalClusters}\n`;
		detailedSummary += `- **Average Interest Weight**: ${stats.averageWeight}\n`;

		if (stats.timespan) {
			detailedSummary += `- **Conversation Span**: ${stats.timespan.days} days (${stats.timespan.firstInteraction.toDateString()} to ${stats.timespan.lastInteraction.toDateString()})\n`;
		}

		detailedSummary += `\n## 🎯 Interest Intensity Distribution\n`;
		detailedSummary += `- **High Interest Topics**: ${stats.weightDistribution.high}\n`;
		detailedSummary += `- **Medium Interest Topics**: ${stats.weightDistribution.medium}\n`;
		detailedSummary += `- **Low Interest Topics**: ${stats.weightDistribution.low}\n`;

		// Clustered interests
		if (topClusters.length > 0) {
			detailedSummary += `\n## 🔗 Main Interest Clusters\n`;
			
			for (let i = 0; i < topClusters.length; i++) {
				const cluster = topClusters[i];
				detailedSummary += `\n### ${i + 1}. Cluster ${cluster.id + 1} (Weight: ${Math.round(cluster.totalWeight * 100) / 100})\n`;
				detailedSummary += `- **Topics Discussed**: ${cluster.count}\n`;
				detailedSummary += `- **Your Questions**: ${cluster.userQuestions}\n`;
				detailedSummary += `- **AI Responses**: ${cluster.assistantResponses}\n`;
				detailedSummary += `- **Representative Topic**: "${cluster.representative.slice(0, 150)}${cluster.representative.length > 150 ? '...' : ''}"\n`;
				
				if (cluster.topics.length > 1) {
					detailedSummary += `- **Related Topics**: \n`;
					for (let j = 1; j < Math.min(4, cluster.topics.length); j++) {
						detailedSummary += `  - "${cluster.topics[j].slice(0, 80)}${cluster.topics[j].length > 80 ? '...' : ''}"\n`;
					}
					if (cluster.topics.length > 4) {
						detailedSummary += `  - ... and ${cluster.topics.length - 4} more related topics\n`;
					}
				}
			}
		}

		// Unclustered interests
		if (topUnclustered.length > 0) {
			detailedSummary += `\n## 💡 Individual Interests\n`;
			detailedSummary += `These topics haven't been grouped with similar ones yet:\n\n`;
			
			for (let i = 0; i < topUnclustered.length; i++) {
				detailedSummary += `${i + 1}. "${topUnclustered[i]}"\n`;
			}
		}

		// AI-Generated insights (if we can call DeepSeek)
		try {
			const aiInsights = await this.generateAIInsights(topClusters, topUnclustered, stats);
			if (aiInsights) {
				detailedSummary += `\n## 🤖 AI Analysis\n${aiInsights}\n`;
			}
		} catch (error) {
			console.error('Failed to generate AI insights:', error);
			detailedSummary += `\n## 🤖 AI Analysis\n*AI analysis temporarily unavailable*\n`;
		}

		// Recommendations
		detailedSummary += `\n## 🚀 Recommendations\n`;
		if (stats.totalClusters > 3) {
			detailedSummary += `- You have ${stats.totalClusters} distinct interest areas - consider exploring connections between them\n`;
		}
		if (stats.userQuestions > stats.assistantResponses * 2) {
			detailedSummary += `- You ask many questions - great curiosity! Consider diving deeper into your top interests\n`;
		}
		if (stats.timespan && stats.timespan.days > 7) {
			detailedSummary += `- You've been exploring topics for ${stats.timespan.days} days - your interests are evolving!\n`;
		}
		
		detailedSummary += `- Use the ⚙️ Config button to adjust how interests are weighted and clustered\n`;

		return detailedSummary;
	}

	/**
	 * Generate AI-powered insights about user interests
	 */
	private async generateAIInsights(
		clusters: Array<{ representative: string; count: number; totalWeight: number }>,
		unclustered: string[],
		stats: any
	): Promise<string | null> {
		try {
			const clusterTexts = clusters.map(c => c.representative).slice(0, 3);
			const allTopics = [...clusterTexts, ...unclustered.slice(0, 2)];

			const prompt = `Analyze these conversation topics and provide insights about the person's interests and learning patterns:

**Main Topics:**
${allTopics.map((topic, i) => `${i + 1}. "${topic}"`).join('\n')}

**Statistics:**
- Total conversations: ${stats.totalInteractions}
- Questions asked: ${stats.userQuestions}
- Distinct interest areas: ${stats.totalClusters}
- Conversation span: ${stats.timespan?.days || 0} days

Provide a 2-3 paragraph analysis covering:
1. What their main interests and learning style appear to be
2. Patterns in their curiosity and engagement
3. Suggestions for related topics they might enjoy exploring

Keep it personal, insightful, and encouraging. Focus on their intellectual curiosity and growth.`;

			const response = await fetch(`${OLLAMA_URL}/api/chat`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: 'deepseek-r1:8b',
					messages: [{ role: 'user', content: prompt }],
					stream: false
				}),
			});

			if (!response.ok) {
				throw new Error(`Failed to generate AI insights: ${response.status}`);
			}

			const data = await response.json();
			return data.message.content;
		} catch (error) {
			console.error('Error generating AI insights:', error);
			return null;
		}
	}

	/**
	 * Generate meaningful quick summary describing actual interests
	 */
	getInterestSummary(): string {
		if (this.embeddings.length === 0) {
			return "No interests tracked yet. Start chatting to build your interest profile!";
		}

		const stats = this.generateStatistics();
		
		// Get top interests by weight
		const topInterests = [...this.embeddings]
			.sort((a, b) => b.weight - a.weight)
			.slice(0, 5);

		// Group by clusters to understand main themes
		const clusters: Map<number, ConversationEmbedding[]> = new Map();
		const unclustered: ConversationEmbedding[] = [];

		for (const emb of this.embeddings) {
			if (emb.clusterId !== undefined) {
				if (!clusters.has(emb.clusterId)) {
					clusters.set(emb.clusterId, []);
				}
				clusters.get(emb.clusterId)!.push(emb);
			} else {
				unclustered.push(emb);
			}
		}

		// Get representative topics from top clusters
		const clusterSummaries: Array<{ representative: string; weight: number; count: number }> = [];
		for (const [clusterId, clusterEmbs] of clusters) {
			clusterEmbs.sort((a, b) => b.weight - a.weight);
			const totalWeight = clusterEmbs.reduce((sum, emb) => sum + emb.weight, 0);
			const representative = clusterEmbs[0];
			clusterSummaries.push({
				representative: representative.text,
				weight: totalWeight,
				count: clusterEmbs.length
			});
		}

		// Sort by weight and get top topics
		clusterSummaries.sort((a, b) => b.weight - a.weight);
		const topClusters = clusterSummaries.slice(0, 3);

		// Build quick summary
		let summary = `📊 **Quick Interest Overview** (${stats.totalInteractions} interactions)\n\n`;

		if (topClusters.length > 0) {
			summary += `🎯 **Top Interest Areas:**\n`;
			for (let i = 0; i < topClusters.length; i++) {
				const cluster = topClusters[i];
				const preview = cluster.representative.length > 60 
					? cluster.representative.slice(0, 60) + '...' 
					: cluster.representative;
				summary += `${i + 1}. "${preview}" (${cluster.count} related topics)\n`;
			}
		}

		// Add top individual interests if space allows
		const topUnclustered = unclustered
			.sort((a, b) => b.weight - a.weight)
			.slice(0, Math.min(2, Math.max(0, 5 - topClusters.length)));

		if (topUnclustered.length > 0) {
			summary += `\n💡 **Individual Topics:**\n`;
			for (let i = 0; i < topUnclustered.length; i++) {
				const preview = topUnclustered[i].text.length > 50 
					? topUnclustered[i].text.slice(0, 50) + '...' 
					: topUnclustered[i].text;
				summary += `• "${preview}"\n`;
			}
		}

		// Add engagement stats
		summary += `\n📈 **Activity:** ${stats.userQuestions} questions, ${stats.assistantResponses} responses`;
		
		if (stats.timespan) {
			summary += `, ${stats.timespan.days} day${stats.timespan.days !== 1 ? 's' : ''}`;
		}

		if (stats.totalClusters > 0) {
			summary += `\n🔗 **${stats.totalClusters} thematic cluster${stats.totalClusters !== 1 ? 's' : ''} identified**`;
		}

		summary += `\n\n💡 *Click "🧠 Detailed Analysis" for comprehensive AI insights*`;

		return summary;
	}

	/**
	 * Get current configuration
	 */
	getConfig(): InterestConfig {
		return { ...this.config };
	}

	/**
	 * Update configuration
	 */
	updateConfig(newConfig: Partial<InterestConfig>): InterestConfig {
		this.config = { ...this.config, ...newConfig };
		this.saveConfig(this.config);
		return this.config;
	}

	/**
	 * Get statistics
	 */
	getStats(): {
		totalEmbeddings: number;
		totalClusters: number;
		modelUsed: string;
	} {
		const clusterIds = new Set(
			this.embeddings
				.map(emb => emb.clusterId)
				.filter(id => id !== undefined)
		);

		return {
			totalEmbeddings: this.embeddings.length,
			totalClusters: clusterIds.size,
			modelUsed: EMBEDDING_MODEL
		};
	}

	/**
	 * Search for personalized news based on user interests
	 * Returns top 3 news articles with highest probability of interest
	 */
	async searchPersonalizedNews(newsApiKey: string): Promise<{
		articles: Array<{
			title: string;
			snippet: string;
			url: string;
			source: string;
			publishDate: string;
			relevanceScore: number;
			matchedInterests: string[];
		}>;
		summary: string;
	}> {
		try {
			// Import the news search function dynamically to avoid circular imports
			const { searchNewsWithInterests, formatNewsSearchResults } = await import('./newsSearch.js');
			
			const results = await searchNewsWithInterests(newsApiKey, {
				maxArticles: 20,
				topInterestsCount: 5
			});

			return {
				articles: results.articles,
				summary: formatNewsSearchResults(results)
			};
		} catch (error) {
			console.error('Error searching personalized news:', error);
			throw new Error(`Failed to search news: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}
}

// Export singleton instance
export const embeddingsStore = new OllamaEmbeddingsStore();