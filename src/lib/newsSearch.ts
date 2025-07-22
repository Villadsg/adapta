/**
 * News Search with Interest-Based Ranking
 * Uses user embeddings to find personalized news articles
 */

import { embeddingsStore, type ConversationEmbedding } from './embeddings.js';
import { Document } from '@langchain/core/documents';
import { BaseRetriever } from '@langchain/core/retrievers';

const OLLAMA_URL = 'http://localhost:11434';
const EMBEDDING_MODEL = 'dengcao/Qwen3-Embedding-8B:Q5_K_M';

export interface NewsArticle {
	title: string;
	snippet: string;
	url: string;
	source: string;
	publishDate: string;
	relevanceScore: number;
	matchedInterests: string[];
}

export interface NewsSearchResult {
	articles: NewsArticle[];
	searchQuery: string;
	userInterests: string[];
	totalFound: number;
}

/**
 * Custom news retriever that uses NewsAPI and user interests
 */
class InterestBasedNewsRetriever extends BaseRetriever {
	private apiKey: string;
	private maxResults: number;

	constructor(apiKey: string, maxResults: number = 20) {
		super();
		this.apiKey = apiKey;
		this.maxResults = maxResults;
	}

	async getRelevantDocuments(query: string): Promise<Document[]> {
		try {
			// Use NewsAPI (replace with your preferred news API)
			const response = await fetch(
				`https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=${this.maxResults}&language=en&apiKey=${this.apiKey}`
			);

			if (!response.ok) {
				throw new Error(`NewsAPI error: ${response.status}`);
			}

			const data = await response.json();
			
			return data.articles?.map((article: any) => new Document({
				pageContent: `${article.title} ${article.description || ''}`,
				metadata: {
					title: article.title,
					source: article.source?.name || 'Unknown',
					url: article.url,
					publishedAt: article.publishedAt,
					description: article.description || '',
					urlToImage: article.urlToImage
				}
			})) || [];
		} catch (error) {
			console.error('Error fetching news:', error);
			return [];
		}
	}
}

/**
 * Search for news articles based on user interests
 */
export async function searchNewsWithInterests(
	newsApiKey: string, 
	options: {
		maxArticles?: number;
		daysBack?: number;
		topInterestsCount?: number;
	} = {}
): Promise<NewsSearchResult> {
	const { maxArticles = 20, daysBack = 7, topInterestsCount = 5 } = options;

	console.log('🔍 Starting interest-based news search...');

	// Get user's top interests
	const topInterests = embeddingsStore.getTopInterests(topInterestsCount);
	
	if (topInterests.length === 0) {
		console.warn('⚠️ No user interests found');
		return {
			articles: [],
			searchQuery: '',
			userInterests: [],
			totalFound: 0
		};
	}

	console.log(`📊 Found ${topInterests.length} user interests`);
	
	// Generate search query from top interests
	const searchTerms = topInterests.map(interest => {
		// Extract key terms from interest text
		const words = interest.text.toLowerCase()
			.replace(/[^\w\s]/g, ' ')
			.split(/\s+/)
			.filter(word => word.length > 3)
			.slice(0, 3);
		return words.join(' ');
	}).filter(term => term.length > 0);

	const searchQuery = searchTerms.slice(0, 3).join(' OR ');
	console.log(`🔎 Search query: "${searchQuery}"`);

	// Search for news articles
	const retriever = new InterestBasedNewsRetriever(newsApiKey, maxArticles);
	const documents = await retriever.getRelevantDocuments(searchQuery);

	console.log(`📰 Found ${documents.length} news articles`);

	if (documents.length === 0) {
		return {
			articles: [],
			searchQuery,
			userInterests: topInterests.map(i => i.text),
			totalFound: 0
		};
	}

	// Calculate relevance scores using embeddings
	const articles = await calculateRelevanceScores(documents, topInterests);

	// Sort by relevance score and take top 3
	const topArticles = articles
		.sort((a, b) => b.relevanceScore - a.relevanceScore)
		.slice(0, 3);

	console.log(`✨ Returning top ${topArticles.length} most relevant articles`);

	return {
		articles: topArticles,
		searchQuery,
		userInterests: topInterests.map(i => i.text),
		totalFound: documents.length
	};
}

/**
 * Calculate relevance scores for articles based on user interests
 */
async function calculateRelevanceScores(
	documents: Document[],
	userInterests: Array<{ text: string; weight: number; embedding?: number[] }>
): Promise<NewsArticle[]> {
	console.log('🧮 Calculating relevance scores...');

	const articles: NewsArticle[] = [];

	for (const doc of documents) {
		try {
			const articleText = `${doc.metadata.title} ${doc.metadata.description}`;
			
			// Create embedding for the article
			const articleEmbedding = await createEmbedding(articleText);
			
			// Calculate similarity with user interests
			let maxSimilarity = 0;
			let totalWeightedSimilarity = 0;
			let totalWeight = 0;
			const matchedInterests: string[] = [];

			for (const interest of userInterests) {
				// Get or create embedding for interest
				let interestEmbedding: number[];
				
				if (interest.embedding) {
					interestEmbedding = interest.embedding;
				} else {
					// Find the embedding from stored data
					const storedEmbedding = embeddingsStore['embeddings']?.find(
						emb => emb.text === interest.text
					);
					if (storedEmbedding) {
						interestEmbedding = storedEmbedding.embedding;
					} else {
						interestEmbedding = await createEmbedding(interest.text);
					}
				}

				const similarity = cosineSimilarity(articleEmbedding, interestEmbedding);
				
				if (similarity > 0.3) { // Threshold for considering a match
					maxSimilarity = Math.max(maxSimilarity, similarity);
					totalWeightedSimilarity += similarity * interest.weight;
					totalWeight += interest.weight;
					
					if (similarity > 0.5) {
						matchedInterests.push(interest.text.slice(0, 50) + (interest.text.length > 50 ? '...' : ''));
					}
				}
			}

			// Calculate final relevance score
			const relevanceScore = totalWeight > 0 ? (totalWeightedSimilarity / totalWeight) : maxSimilarity;

			// Only include articles with some relevance
			if (relevanceScore > 0.2) {
				articles.push({
					title: doc.metadata.title,
					snippet: doc.metadata.description || 'No description available',
					url: doc.metadata.url,
					source: doc.metadata.source,
					publishDate: doc.metadata.publishedAt,
					relevanceScore: Math.round(relevanceScore * 1000) / 1000,
					matchedInterests
				});
			}

		} catch (error) {
			console.error('Error processing article:', error);
			// Continue with next article
		}
	}

	console.log(`✅ Processed ${articles.length} relevant articles`);
	return articles;
}

/**
 * Create embedding using Ollama
 */
async function createEmbedding(text: string): Promise<number[]> {
	const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: EMBEDDING_MODEL,
			prompt: text
		}),
	});

	if (!response.ok) {
		throw new Error(`Ollama API error: ${response.status}`);
	}

	const data = await response.json();
	
	if (!data.embedding || !Array.isArray(data.embedding)) {
		throw new Error('Invalid embedding response from Ollama');
	}
	
	return data.embedding;
}

/**
 * Calculate cosine similarity between two embeddings
 */
function cosineSimilarity(a: number[], b: number[]): number {
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
 * Generate readable summary of search results
 */
export function formatNewsSearchResults(results: NewsSearchResult): string {
	if (results.articles.length === 0) {
		return `# 📰 News Search Results

No relevant news articles found based on your interests.

**Search Query:** ${results.searchQuery}

**Your Top Interests:**
${results.userInterests.slice(0, 5).map((interest, i) => `${i + 1}. ${interest.slice(0, 100)}...`).join('\n')}

Try engaging in more conversations to build a richer interest profile!`;
	}

	let summary = `# 📰 Top News Matches for Your Interests\n\n`;
	summary += `**Search Query:** ${results.searchQuery}\n`;
	summary += `**Found:** ${results.totalFound} articles, showing top ${results.articles.length}\n\n`;

	results.articles.forEach((article, index) => {
		summary += `## ${index + 1}. ${article.title}\n`;
		summary += `**Source:** ${article.source} | **Relevance:** ${(article.relevanceScore * 100).toFixed(1)}%\n`;
		summary += `**Published:** ${new Date(article.publishDate).toLocaleDateString()}\n\n`;
		summary += `${article.snippet}\n\n`;
		
		if (article.matchedInterests.length > 0) {
			summary += `**Matched Interests:** ${article.matchedInterests.join(', ')}\n`;
		}
		
		summary += `🔗 [Read more](${article.url})\n\n`;
		summary += `---\n\n`;
	});

	summary += `💡 *These articles were selected based on your conversation history and interests.*`;

	return summary;
}