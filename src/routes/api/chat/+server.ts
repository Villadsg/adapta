import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

function filterThinkingSections(content: string): string {
	// Remove thinking sections marked with <think>...</think> tags
	let cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, '');
	
	// Remove thinking sections marked with <thinking>...</thinking> tags
	cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
	
	// Remove sections that start with "I need to think about this" or similar patterns
	cleaned = cleaned.replace(/^(I need to think about this|Let me think|Thinking|I'll think about this)[\s\S]*?(?=\n\n|\n[A-Z]|$)/gmi, '');
	
	// Remove sections enclosed in triple backticks that contain thinking patterns
	cleaned = cleaned.replace(/```[\s\S]*?(think|reasoning|analysis)[\s\S]*?```/gi, '');
	
	// Clean up any extra whitespace
	cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
	
	return cleaned;
}

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { messages } = await request.json();
		
		// Connect to local deepseek-r1:14b via Ollama API
		const response = await fetch('http://localhost:11434/api/chat', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: 'deepseek-r1:8b',
				messages: messages,
				stream: false
			}),
		});

		if (!response.ok) {
			throw new Error(`Ollama API responded with status: ${response.status}`);
		}

		const data = await response.json();
		const filteredContent = filterThinkingSections(data.message.content);
		
		return json({ 
			response: filteredContent 
		});
		
	} catch (error) {
		console.error('Error connecting to deepseek-r1:', error);
		
		return json(
			{ 
				error: 'Failed to connect to deepseek-r1:14b. Make sure Ollama is running with the model loaded.' 
			}, 
			{ status: 500 }
		);
	}
};