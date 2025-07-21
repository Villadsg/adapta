import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { embeddingsStore } from '$lib/embeddings.js';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { userMessage, assistantMessage } = await request.json();
		
		// Process conversation with Ollama Qwen3-Embedding-8B
		await embeddingsStore.addConversation(
			userMessage || '', 
			assistantMessage || ''
		);
		
		return json({ success: true });
		
	} catch (error) {
		console.error('Error tracking semantic interests:', error);
		return json({ 
			error: 'Failed to track interests with Ollama semantic understanding',
			details: error instanceof Error ? error.message : 'Unknown error'
		}, { status: 500 });
	}
};

export const GET: RequestHandler = async ({ url }) => {
	try {
		// Check if detailed summary is requested
		const detailed = url.searchParams.get('detailed') === 'true';
		
		// Get interests and summary from Ollama embeddings store
		const interests = embeddingsStore.getTopInterests(20);
		const summary = detailed 
			? await embeddingsStore.getDetailedInterestSummary()
			: embeddingsStore.getInterestSummary();
		const config = embeddingsStore.getConfig();
		const stats = embeddingsStore.getStats();
		
		return json({
			interests,
			summary,
			totalInteractions: stats.totalEmbeddings,
			lastUpdated: Date.now(),
			config,
			stats,
			isDetailed: detailed
		});
		
	} catch (error) {
		console.error('Error getting semantic interests:', error);
		return json({ 
			error: 'Failed to get interests from Ollama semantic understanding',
			details: error instanceof Error ? error.message : 'Unknown error'
		}, { status: 500 });
	}
};