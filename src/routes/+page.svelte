<script lang="ts">
	let messages: Array<{role: 'user' | 'assistant', content: string}> = [];
	let currentMessage = '';
	let isLoading = false;
	let showInterestSummary = false;
	let interestSummary = '';
	let isLoadingSummary = false;
	let isDetailedSummary = false;
	let showConfig = false;
	let config = {
		userInputWeight: 3.0,
		assistantOutputWeight: 1.0,
		recencyDecay: 0.95,
		similarityThreshold: 0.7,
		maxInterests: 1000
	};
	let isLoadingConfig = false;

	async function trackInterests(userMessage: string, assistantMessage: string) {
		try {
			await fetch('/api/interests', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					userMessage,
					assistantMessage
				}),
			});
		} catch (error) {
			console.error('Failed to track interests:', error);
		}
	}

	async function sendMessage() {
		if (!currentMessage.trim()) return;
		
		const userMessage = currentMessage;
		messages = [...messages, {role: 'user', content: userMessage}];
		currentMessage = '';
		isLoading = true;

		try {
			const response = await fetch('/api/chat', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					messages: messages
				}),
			});

			if (!response.ok) {
				throw new Error('Failed to get response');
			}

			const data = await response.json();
			const assistantMessage = data.response;
			messages = [...messages, {role: 'assistant', content: assistantMessage}];
			
			// Track interests in background
			trackInterests(userMessage, assistantMessage);
		} catch (error) {
			messages = [...messages, {role: 'assistant', content: 'Error: Unable to connect to deepseek-r1:14b'}];
		} finally {
			isLoading = false;
		}
	}

	async function generateInterestSummary(detailed = true) {
		isLoadingSummary = true;
		isDetailedSummary = detailed;
		try {
			const url = detailed ? '/api/interests?detailed=true' : '/api/interests';
			const response = await fetch(url);
			if (response.ok) {
				const data = await response.json();
				interestSummary = data.summary || 'No interests tracked yet.';
				showInterestSummary = true;
			} else {
				interestSummary = 'Failed to generate interest summary.';
				showInterestSummary = true;
			}
		} catch (error) {
			interestSummary = 'Error generating interest summary.';
			showInterestSummary = true;
		} finally {
			isLoadingSummary = false;
		}
	}

	async function loadConfig() {
		try {
			const response = await fetch('/api/interests/config');
			if (response.ok) {
				config = await response.json();
			}
		} catch (error) {
			console.error('Failed to load config:', error);
		}
	}

	async function saveConfig() {
		isLoadingConfig = true;
		try {
			const response = await fetch('/api/interests/config', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(config),
			});
			if (response.ok) {
				showConfig = false;
			}
		} catch (error) {
			console.error('Failed to save config:', error);
		} finally {
			isLoadingConfig = false;
		}
	}

	async function openConfig() {
		await loadConfig();
		showConfig = true;
	}

	function handleKeyPress(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			sendMessage();
		}
	}
</script>

<main class="chat-container">
	<div class="header">
		<h1>DeepSeek R1 Chat</h1>
		<div class="header-buttons">
			<button 
				class="config-button" 
				on:click={openConfig}
				disabled={isLoadingConfig}
			>
				⚙️ Config
			</button>
			<button 
				class="quick-summary-button" 
				on:click={() => generateInterestSummary(false)}
				disabled={isLoadingSummary}
			>
				📊 Quick Summary
			</button>
			<button 
				class="interest-button" 
				on:click={() => generateInterestSummary(true)}
				disabled={isLoadingSummary}
			>
				{isLoadingSummary ? 'Generating...' : '🧠 Detailed Analysis'}
			</button>
		</div>
	</div>

	{#if showConfig}
		<div class="config-modal">
			<div class="config-content">
				<div class="config-header">
					<h3>Semantic Interest Configuration</h3>
					<button class="close-button" on:click={() => showConfig = false}>×</button>
				</div>
				
				<div class="config-form">
					<div class="config-field">
						<label>User Input Weight:</label>
						<input type="number" step="0.1" bind:value={config.userInputWeight} />
						<small>How much weight to give user questions (higher = more important)</small>
					</div>
					
					<div class="config-field">
						<label>Assistant Output Weight:</label>
						<input type="number" step="0.1" bind:value={config.assistantOutputWeight} />
						<small>How much weight to give AI responses (lower = less important)</small>
					</div>
					
					<div class="config-field">
						<label>Recency Decay:</label>
						<input type="number" step="0.01" min="0" max="1" bind:value={config.recencyDecay} />
						<small>How fast old interests decay (0.95 = slow decay, 0.5 = fast decay)</small>
					</div>
					
					<div class="config-field">
						<label>Similarity Threshold:</label>
						<input type="number" step="0.05" min="0" max="1" bind:value={config.similarityThreshold} />
						<small>Minimum similarity to cluster interests (0.7 = strict, 0.5 = loose)</small>
					</div>
					
					<div class="config-field">
						<label>Max Interests:</label>
						<input type="number" step="100" bind:value={config.maxInterests} />
						<small>Maximum number of interests to store</small>
					</div>
					
					<div class="config-buttons">
						<button class="save-button" on:click={saveConfig} disabled={isLoadingConfig}>
							{isLoadingConfig ? 'Saving...' : 'Save Configuration'}
						</button>
					</div>
				</div>
			</div>
		</div>
	{/if}

	{#if showInterestSummary}
		<div class="interest-summary" class:detailed={isDetailedSummary}>
			<div class="summary-header">
				<h3>
					{isDetailedSummary ? '🧠 Detailed Interest Analysis' : '📊 Quick Interest Summary'} 
					<span class="subtitle">(Ollama Qwen3-Embedding)</span>
				</h3>
				<div class="header-actions">
					{#if !isDetailedSummary}
						<button 
							class="expand-button" 
							on:click={() => generateInterestSummary(true)}
							disabled={isLoadingSummary}
						>
							🧠 Detailed
						</button>
					{/if}
					{#if isDetailedSummary}
						<button 
							class="expand-button" 
							on:click={() => generateInterestSummary(false)}
							disabled={isLoadingSummary}
						>
							📊 Quick
						</button>
					{/if}
					<button class="close-button" on:click={() => showInterestSummary = false}>×</button>
				</div>
			</div>
			<div class="summary-content">
				<pre>{interestSummary}</pre>
			</div>
		</div>
	{/if}
	
	<div class="messages">
		{#each messages as message}
			<div class="message {message.role}">
				<strong>{message.role === 'user' ? 'You' : 'DeepSeek'}:</strong>
				<p>{message.content}</p>
			</div>
		{/each}
		
		{#if isLoading}
			<div class="message assistant loading">
				<strong>DeepSeek:</strong>
				<p>Thinking...</p>
			</div>
		{/if}
	</div>

	<div class="input-container">
		<textarea
			bind:value={currentMessage}
			on:keypress={handleKeyPress}
			placeholder="Ask me anything..."
			rows="3"
			disabled={isLoading}
		></textarea>
		<button on:click={sendMessage} disabled={isLoading || !currentMessage.trim()}>
			Send
		</button>
	</div>
</main>

<style>
	.chat-container {
		max-width: 800px;
		margin: 0 auto;
		padding: 2rem;
		height: 100vh;
		display: flex;
		flex-direction: column;
	}

	.header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 2rem;
	}

	h1 {
		margin: 0;
		color: #333;
	}

	.header-buttons {
		display: flex;
		gap: 0.5rem;
	}

	.config-button {
		padding: 0.5rem 1rem;
		background: #9C27B0;
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.9rem;
	}

	.config-button:disabled {
		background: #ccc;
		cursor: not-allowed;
	}

	.config-button:not(:disabled):hover {
		background: #7B1FA2;
	}

	.quick-summary-button {
		padding: 0.5rem 1rem;
		background: #FF9800;
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.9rem;
	}

	.quick-summary-button:disabled {
		background: #ccc;
		cursor: not-allowed;
	}

	.quick-summary-button:not(:disabled):hover {
		background: #F57C00;
	}

	.interest-button {
		padding: 0.5rem 1rem;
		background: #2196F3;
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.9rem;
	}

	.interest-button:disabled {
		background: #ccc;
		cursor: not-allowed;
	}

	.interest-button:not(:disabled):hover {
		background: #1976D2;
	}

	.config-modal {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.config-content {
		background: white;
		border-radius: 8px;
		padding: 2rem;
		max-width: 500px;
		max-height: 80vh;
		overflow-y: auto;
		margin: 2rem;
	}

	.config-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1.5rem;
	}

	.config-header h3 {
		margin: 0;
		color: #333;
	}

	.config-form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.config-field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.config-field label {
		font-weight: bold;
		color: #555;
	}

	.config-field input {
		padding: 0.5rem;
		border: 1px solid #ddd;
		border-radius: 4px;
		font-size: 1rem;
	}

	.config-field small {
		color: #666;
		font-style: italic;
	}

	.config-buttons {
		margin-top: 1rem;
		display: flex;
		justify-content: flex-end;
	}

	.save-button {
		padding: 0.75rem 1.5rem;
		background: #4CAF50;
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-weight: bold;
	}

	.save-button:disabled {
		background: #ccc;
		cursor: not-allowed;
	}

	.save-button:not(:disabled):hover {
		background: #45a049;
	}

	.interest-summary {
		background: #fff3cd;
		border: 1px solid #ffeaa7;
		border-radius: 8px;
		padding: 1rem;
		margin-bottom: 1rem;
	}

	.interest-summary.detailed {
		background: #f8f9fa;
		border: 1px solid #dee2e6;
		max-height: 70vh;
		overflow-y: auto;
	}

	.summary-content {
		max-height: 60vh;
		overflow-y: auto;
	}

	.summary-content pre {
		white-space: pre-wrap;
		word-wrap: break-word;
		margin: 0;
		padding: 1rem 0;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
		font-size: 0.9rem;
		line-height: 1.5;
		color: #333;
	}

	.summary-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
	}

	.summary-header h3 {
		margin: 0;
		color: #856404;
		font-size: 1.1rem;
	}

	.interest-summary.detailed .summary-header h3 {
		color: #495057;
	}

	.subtitle {
		font-size: 0.8rem;
		font-weight: normal;
		opacity: 0.7;
	}

	.header-actions {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.expand-button {
		background: #17a2b8;
		color: white;
		border: none;
		border-radius: 4px;
		padding: 0.25rem 0.5rem;
		font-size: 0.8rem;
		cursor: pointer;
		transition: background 0.2s;
	}

	.expand-button:disabled {
		background: #ccc;
		cursor: not-allowed;
	}

	.expand-button:not(:disabled):hover {
		background: #138496;
	}

	.close-button {
		background: none;
		border: none;
		font-size: 1.5rem;
		cursor: pointer;
		color: #856404;
		padding: 0;
		width: 30px;
		height: 30px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.close-button:hover {
		background: rgba(133, 100, 4, 0.1);
		border-radius: 50%;
	}

	.interest-summary p {
		margin: 0;
		color: #856404;
		line-height: 1.4;
	}

	.messages {
		flex: 1;
		overflow-y: auto;
		border: 1px solid #ddd;
		border-radius: 8px;
		padding: 1rem;
		margin-bottom: 1rem;
		background: #f9f9f9;
	}

	.message {
		margin-bottom: 1rem;
		padding: 1rem;
		border-radius: 8px;
	}

	.message.user {
		background: #e3f2fd;
		margin-left: 2rem;
	}

	.message.assistant {
		background: #f3e5f5;
		margin-right: 2rem;
	}

	.message.loading {
		opacity: 0.7;
		font-style: italic;
	}

	.message strong {
		display: block;
		margin-bottom: 0.5rem;
		color: #555;
	}

	.message p {
		margin: 0;
		white-space: pre-wrap;
		word-wrap: break-word;
	}

	.input-container {
		display: flex;
		gap: 1rem;
		align-items: flex-end;
	}

	textarea {
		flex: 1;
		padding: 0.75rem;
		border: 1px solid #ddd;
		border-radius: 4px;
		resize: vertical;
		font-family: inherit;
	}

	button {
		padding: 0.75rem 1.5rem;
		background: #4CAF50;
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-weight: bold;
	}

	button:disabled {
		background: #ccc;
		cursor: not-allowed;
	}

	button:not(:disabled):hover {
		background: #45a049;
	}
</style>
