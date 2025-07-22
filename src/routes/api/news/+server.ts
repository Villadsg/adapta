import { json } from '@sveltejs/kit';
import { searchNewsWithInterests, formatNewsSearchResults } from '$lib/newsSearch.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { newsApiKey, options } = await request.json();
		
		if (!newsApiKey) {
			return json(
				{ 
					error: 'NewsAPI key is required. Get one at https://newsapi.org/register',
					code: 'MISSING_API_KEY'
				}, 
				{ status: 400 }
			);
		}

		console.log('🔍 Starting news search with user interests...');
		
		const results = await searchNewsWithInterests(newsApiKey, options);
		
		return json({
			success: true,
			results,
			formattedResults: formatNewsSearchResults(results)
		});

	} catch (error) {
		console.error('❌ News search error:', error);
		
		if (error instanceof Error) {
			if (error.message.includes('NewsAPI error: 401')) {
				return json(
					{ 
						error: 'Invalid NewsAPI key. Please check your API key at https://newsapi.org/',
						code: 'INVALID_API_KEY'
					}, 
					{ status: 401 }
				);
			}
			
			if (error.message.includes('Ollama')) {
				return json(
					{ 
						error: 'Ollama is not running or not accessible. Please start Ollama with the Qwen3-Embedding-8B model.',
						code: 'OLLAMA_ERROR'
					}, 
					{ status: 503 }
				);
			}
		}

		return json(
			{ 
				error: 'Failed to search for news articles. Please try again.',
				code: 'SEARCH_FAILED',
				details: error instanceof Error ? error.message : 'Unknown error'
			}, 
			{ status: 500 }
		);
	}
};

export const GET: RequestHandler = async () => {
	return json({
		message: 'Interest-based news search API',
		usage: 'POST with { newsApiKey: string, options?: { maxArticles?: number, daysBack?: number, topInterestsCount?: number } }',
		requirements: [
			'NewsAPI key from https://newsapi.org/register',
			'Ollama running with dengcao/Qwen3-Embedding-8B:Q5_K_M model',
			'User conversation history with stored embeddings'
		]
	});
};