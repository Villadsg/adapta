<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { initAuth, user, loading } from '$lib/auth';

	onMount(() => {
		initAuth();
	});
</script>

{#if $loading}
	<div class="loading">
		<p>Loading...</p>
	</div>
{:else}
	<slot />
{/if}

<style>
	.loading {
		display: flex;
		justify-content: center;
		align-items: center;
		height: 100vh;
		font-size: 1.2em;
		color: #666;
	}
</style>