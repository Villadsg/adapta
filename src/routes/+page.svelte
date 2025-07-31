<script lang="ts">
	import { user, signOut } from '$lib/auth';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { saveUserInterests, loadUserInterests } from '$lib/interests';
	import { supabase } from '$lib/supabase';

	let customInterest = '';
	let customInterests: string[] = [];
	let saving = false;
	let saveStatus = '';
	let discovering = false;
	let discoveredContent: any[] = [];
	let discoveryError = '';
	let feedbackStatus = '';

	interface SearchResult {
		title: string;
		url: string;
		snippet: string;
		relevanceScore?: number;
		contributingSentenceIds?: string[];
		qualityScore?: number;
	}

	onMount(() => {
		if (!$user) {
			goto('/signin');
		} else {
			loadSavedInterests();
		}
	});

	async function loadSavedInterests() {
		try {
			const { customInterests: savedCustom } = await loadUserInterests();
			customInterests = savedCustom;
		} catch (error) {
			console.error('Failed to load interests:', error);
		}
	}

	async function saveInterests() {
		saving = true;
		saveStatus = '';
		
		try {
			await saveUserInterests([], customInterests);
			saveStatus = 'Interests saved successfully!';
			setTimeout(() => saveStatus = '', 3000);
		} catch (error) {
			saveStatus = 'Failed to save interests. Please try again.';
			console.error('Failed to save interests:', error);
		} finally {
			saving = false;
		}
	}

	async function discoverContent() {
		if (customInterests.length === 0) {
			discoveryError = 'Please add some interests first before discovering content.';
			return;
		}

		discovering = true;
		discoveryError = '';
		discoveredContent = [];

		try {
			const { data: { session } } = await supabase.auth.getSession();
			if (!session) {
				discoveryError = 'Please sign in to discover content.';
				return;
			}

			const response = await fetch('/api/discover', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${session.access_token}`
				}
			});

			const data = await response.json();

			if (!response.ok) {
				discoveryError = data.error || 'Failed to discover content';
				return;
			}

			discoveredContent = data.results || [];
			
			if (discoveredContent.length === 0) {
				discoveryError = 'No interesting content found. Try adding different or more specific interests.';
			}

		} catch (error) {
			console.error('Discovery error:', error);
			discoveryError = 'Failed to discover content. Make sure Ollama is running with the embedding model.';
		} finally {
			discovering = false;
		}
	}


	async function addCustomInterest() {
		if (customInterest.trim() && !customInterests.includes(customInterest.trim())) {
			customInterests = [...customInterests, customInterest.trim()];
			customInterest = '';
			// Auto-save after adding interest
			await saveInterests();
		}
	}

	async function removeCustomInterest(interest: string) {
		customInterests = customInterests.filter(i => i !== interest);
		// Auto-save after removing interest
		await saveInterests();
	}


	function handleKeyPress(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			addCustomInterest();
		}
	}

	async function provideFeedback(resultIndex: number, reaction: 'good' | 'bad') {
		try {
			const { data: { session } } = await supabase.auth.getSession();
			if (!session) {
				feedbackStatus = 'Please sign in to provide feedback.';
				return;
			}

			const result = discoveredContent[resultIndex];
			
			const response = await fetch('/api/feedback', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${session.access_token}`
				},
				body: JSON.stringify({
					resultId: `${resultIndex}_${Date.now()}`,
					reaction,
					title: result.title,
					snippet: result.snippet,
					url: result.url,
					contributingSentenceIds: result.contributingSentenceIds || []
				})
			});

			const data = await response.json();

			if (response.ok) {
				feedbackStatus = `Feedback recorded! ${reaction === 'good' ? '👍' : '👎'}`;
				setTimeout(() => feedbackStatus = '', 2000);
				
				// Mark the result as feedback provided
				discoveredContent[resultIndex] = { ...result, feedbackProvided: reaction };
			} else {
				feedbackStatus = data.error || 'Failed to record feedback';
				setTimeout(() => feedbackStatus = '', 3000);
			}
		} catch (error) {
			console.error('Feedback error:', error);
			feedbackStatus = 'Failed to record feedback. Please try again.';
			setTimeout(() => feedbackStatus = '', 3000);
		}
	}
</script>

<main>
	{#if $user}
		<div class="header">
			<h1>Interest Selector</h1>
			<div class="user-info">
				<span>Welcome, {$user.email}</span>
				<button class="signout-btn" on:click={signOut}>Sign Out</button>
			</div>
		</div>
		
		<div class="main-layout">
			<div class="left-panel">
				<div class="interest-selector">
					<div class="custom-input">
						<h3>Add your interests:</h3>
						<div class="input-group">
							<input 
								type="text" 
								bind:value={customInterest} 
								placeholder="Enter your interest area (e.g., Machine Learning, Climate Change, Cooking)"
								on:keydown={handleKeyPress}
							/>
							<button on:click={addCustomInterest} disabled={!customInterest.trim()}>
								Add
							</button>
						</div>
					</div>

					{#if customInterests.length > 0}
						<div class="custom-interests">
							<h4>Your interests:</h4>
							<div class="interest-tags">
								{#each customInterests as interest}
									<span class="interest-tag">
										{interest}
										<button class="remove-btn" on:click={() => removeCustomInterest(interest)}>×</button>
									</span>
								{/each}
							</div>
						</div>
					{/if}

					<div class="save-section">
						<button class="save-btn" on:click={saveInterests} disabled={saving}>
							{saving ? 'Saving...' : 'Save Interests'}
						</button>
						
						{#if saveStatus}
							<div class="save-status" class:success={saveStatus.includes('successfully')} class:error={saveStatus.includes('Failed')}>
								{saveStatus}
							</div>
						{/if}
					</div>
				</div>
			</div>

			<div class="right-panel">
				{#if customInterests.length > 0}
					<div class="discovery-section">
						<h3>Discover Interesting Content</h3>
						<p>Find content tailored to your interests using AI-powered search</p>
						<p class="discovery-note">
							💡 First run will automatically download the AI model (~5GB) if needed
						</p>
						
						<button class="discover-btn" on:click={discoverContent} disabled={discovering}>
							{discovering ? 'Initializing AI & Discovering...' : 'Discover Content'}
						</button>

						{#if discoveryError}
							<div class="discovery-error">
								{discoveryError}
							</div>
						{/if}

						{#if discoveredContent.length > 0}
							<div class="discovered-content">
								<h4>Recommended for you:</h4>
								
								{#if feedbackStatus}
									<div class="feedback-status">
										{feedbackStatus}
									</div>
								{/if}
								
								<div class="content-grid">
									{#each discoveredContent as item, index}
										<div class="content-item">
											<h5>
												<a href={item.url} target="_blank" rel="noopener noreferrer">
													{item.title}
												</a>
											</h5>
											<p class="content-snippet">{item.snippet}</p>
											
											<div class="score-indicators">
												{#if item.relevanceScore}
													<div class="relevance-score">
														Relevance: {Math.round(item.relevanceScore * 100)}%
													</div>
												{/if}
												{#if item.qualityScore !== undefined}
													<div class="quality-score" class:quality-low={item.qualityScore < 0.7} class:quality-medium={item.qualityScore >= 0.7 && item.qualityScore < 0.9} class:quality-high={item.qualityScore >= 0.9}>
														Quality: {Math.round(item.qualityScore * 100)}%
													</div>
												{/if}
											</div>
											
											<div class="feedback-buttons">
												{#if item.feedbackProvided}
													<div class="feedback-provided">
														Feedback: {item.feedbackProvided === 'good' ? '👍 Good' : '👎 Bad'}
													</div>
												{:else}
													<button 
														class="feedback-btn good" 
														on:click={() => provideFeedback(index, 'good')}
													>
														👍 Good
													</button>
													<button 
														class="feedback-btn bad" 
														on:click={() => provideFeedback(index, 'bad')}
													>
														👎 Bad
													</button>
												{/if}
											</div>
										</div>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				{:else}
					<div class="empty-state">
						<p>Add some interests to start discovering content!</p>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</main>

<style>
	main {
		padding: 2em;
		max-width: 1400px;
		margin: 0 auto;
	}

	.header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 2em;
		padding-bottom: 1em;
		border-bottom: 1px solid #eee;
	}

	h1 {
		color: #ff3e00;
		text-transform: uppercase;
		font-size: 2.5em;
		font-weight: 100;
		margin: 0;
	}

	.user-info {
		display: flex;
		align-items: center;
		gap: 1em;
		font-size: 0.9em;
		color: #666;
	}

	.signout-btn {
		padding: 0.5em 1em;
		background: #666;
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.9em;
		transition: background-color 0.2s;
	}

	.signout-btn:hover {
		background: #555;
	}

	.main-layout {
		display: grid;
		grid-template-columns: 1fr 2fr;
		gap: 2em;
		align-items: start;
	}

	.left-panel {
		background: #f8f9fa;
		padding: 1.5em;
		border-radius: 8px;
		border: 1px solid #e9ecef;
		height: fit-content;
		sticky: true;
		top: 2em;
	}

	.right-panel {
		min-height: 500px;
	}

	.interest-selector {
		text-align: left;
	}

	h3 {
		color: #333;
		margin-bottom: 1em;
		font-size: 1.2em;
	}

	h4 {
		color: #555;
		margin-bottom: 0.5em;
		font-size: 1.1em;
	}


	.custom-input {
		margin-bottom: 2em;
	}

	.input-group {
		display: flex;
		gap: 0.5em;
		align-items: stretch;
	}

	input[type="text"] {
		flex: 1;
		padding: 0.75em;
		border: 2px solid #ddd;
		border-radius: 6px;
		font-size: 1em;
		box-sizing: border-box;
	}

	input[type="text"]:focus {
		outline: none;
		border-color: #ff3e00;
	}

	button {
		padding: 0.75em 1.5em;
		background: #ff3e00;
		color: white;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		font-size: 1em;
		transition: background-color 0.2s;
	}

	button:hover:not(:disabled) {
		background: #e63600;
	}

	button:disabled {
		background: #ccc;
		cursor: not-allowed;
	}

	.custom-interests {
		margin-bottom: 1.5em;
	}

	.interest-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5em;
	}

	.interest-tag {
		display: inline-flex;
		align-items: center;
		gap: 0.5em;
		padding: 0.5em 1em;
		background: #f0f0f0;
		border-radius: 20px;
		font-size: 0.9em;
		border: 1px solid #ddd;
	}

	.remove-btn {
		background: #ff6b6b;
		color: white;
		border: none;
		border-radius: 50%;
		width: 20px;
		height: 20px;
		font-size: 12px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		line-height: 1;
	}

	.remove-btn:hover {
		background: #ff5252;
	}

	.save-section {
		margin-top: 2em;
		padding-top: 2em;
		border-top: 1px solid #eee;
		text-align: center;
	}

	.save-btn {
		padding: 1em 2em;
		background: #ff3e00;
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 1.1em;
		cursor: pointer;
		transition: background-color 0.2s;
		font-weight: 500;
	}

	.save-btn:hover:not(:disabled) {
		background: #e63600;
	}

	.save-btn:disabled {
		background: #ccc;
		cursor: not-allowed;
	}

	.save-status {
		margin-top: 1em;
		padding: 0.75em;
		border-radius: 6px;
		font-weight: 500;
	}

	.save-status.success {
		background: #efe;
		color: #363;
		border: 1px solid #cfc;
	}

	.save-status.error {
		background: #fee;
		color: #c33;
		border: 1px solid #fcc;
	}

	.discovery-section {
		margin-top: 0;
		padding-top: 0;
		border-top: none;
	}

	.empty-state {
		text-align: center;
		padding: 3em 2em;
		color: #666;
		background: #f8f9fa;
		border-radius: 8px;
		border: 1px solid #e9ecef;
	}

	.discovery-section h3 {
		color: #ff3e00;
		margin-bottom: 0.5em;
	}

	.discovery-section p {
		color: #666;
		margin-bottom: 1.5em;
	}

	.discovery-note {
		font-size: 0.9em;
		color: #888;
		background: #f8f9fa;
		padding: 0.75em;
		border-radius: 6px;
		border-left: 3px solid #28a745;
		margin-bottom: 1.5em;
	}

	.discover-btn {
		padding: 1em 2em;
		background: #28a745;
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 1.1em;
		cursor: pointer;
		transition: background-color 0.2s;
		font-weight: 500;
		margin-bottom: 1.5em;
	}

	.discover-btn:hover:not(:disabled) {
		background: #218838;
	}

	.discover-btn:disabled {
		background: #ccc;
		cursor: not-allowed;
	}

	.discovery-error {
		background: #fee;
		color: #c33;
		padding: 0.75em;
		border-radius: 6px;
		margin-bottom: 1em;
		border: 1px solid #fcc;
	}

	.discovered-content {
		margin-top: 2em;
	}

	.discovered-content h4 {
		color: #333;
		margin-bottom: 1em;
		font-size: 1.2em;
	}

	.content-grid {
		display: grid;
		gap: 1.5em;
		grid-template-columns: 1fr;
	}

	.content-item {
		background: white;
		border: 1px solid #ddd;
		border-radius: 8px;
		padding: 1.5em;
		box-shadow: 0 2px 4px rgba(0,0,0,0.1);
		transition: box-shadow 0.2s;
	}

	.content-item:hover {
		box-shadow: 0 4px 8px rgba(0,0,0,0.15);
	}

	.content-item h5 {
		margin: 0 0 0.5em 0;
		font-size: 1.1em;
	}

	.content-item a {
		color: #ff3e00;
		text-decoration: none;
	}

	.content-item a:hover {
		text-decoration: underline;
	}

	.content-snippet {
		color: #666;
		line-height: 1.5;
		margin-bottom: 0.5em;
	}

	.score-indicators {
		display: flex;
		gap: 1em;
		margin-bottom: 1em;
		flex-wrap: wrap;
	}

	.relevance-score {
		font-size: 0.85em;
		color: #28a745;
		font-weight: 500;
		padding: 0.25em 0.5em;
		background: #f8f9fa;
		border-radius: 3px;
		border: 1px solid #e9ecef;
	}

	.quality-score {
		font-size: 0.85em;
		font-weight: 500;
		padding: 0.25em 0.5em;
		border-radius: 3px;
		border: 1px solid;
	}

	.quality-score.quality-high {
		color: #155724;
		background: #d4edda;
		border-color: #c3e6cb;
	}

	.quality-score.quality-medium {
		color: #856404;
		background: #fff3cd;
		border-color: #ffeaa7;
	}

	.quality-score.quality-low {
		color: #721c24;
		background: #f8d7da;
		border-color: #f1aeb5;
	}

	.feedback-buttons {
		display: flex;
		gap: 0.5em;
		margin-top: 1em;
		padding-top: 1em;
		border-top: 1px solid #eee;
	}

	.feedback-btn {
		padding: 0.5em 1em;
		border: 1px solid #ddd;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.9em;
		transition: all 0.2s;
		background: white;
	}

	.feedback-btn.good {
		color: #28a745;
		border-color: #28a745;
	}

	.feedback-btn.good:hover {
		background: #28a745;
		color: white;
	}

	.feedback-btn.bad {
		color: #dc3545;
		border-color: #dc3545;
	}

	.feedback-btn.bad:hover {
		background: #dc3545;
		color: white;
	}

	.feedback-provided {
		color: #666;
		font-size: 0.9em;
		font-style: italic;
		padding: 0.5em;
		background: #f8f9fa;
		border-radius: 4px;
	}

	.feedback-status {
		background: #d4edda;
		color: #155724;
		padding: 0.75em;
		border-radius: 6px;
		margin-bottom: 1em;
		border: 1px solid #c3e6cb;
		text-align: center;
		font-weight: 500;
	}

	@media (max-width: 1024px) {
		.main-layout {
			grid-template-columns: 1fr;
			gap: 1.5em;
		}
		
		.left-panel {
			position: static;
		}
	}

	@media (min-width: 640px) {
		.content-grid {
			grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
		}
	}
</style>