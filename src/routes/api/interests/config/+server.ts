import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { embeddingsStore } from '$lib/embeddings.js';

export const GET: RequestHandler = async () => {
	try {
		const config = embeddingsStore.getConfig();
		return json(config);
		
	} catch (error) {
		console.error('Error getting config:', error);
		return json({ 
			error: 'Failed to get configuration',
			details: error instanceof Error ? error.message : 'Unknown error'
		}, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const newConfig = await request.json();
		const updatedConfig = embeddingsStore.updateConfig(newConfig);
		
		return json({
			success: true,
			config: updatedConfig,
			message: 'Configuration updated successfully'
		});
		
	} catch (error) {
		console.error('Error updating config:', error);
		return json({ 
			error: 'Failed to update configuration',
			details: error instanceof Error ? error.message : 'Unknown error'
		}, { status: 500 });
	}
};