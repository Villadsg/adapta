<script lang="ts">
	import { supabase } from '$lib/supabase';
	import { goto } from '$app/navigation';

	let email = '';
	let password = '';
	let loading = false;
	let error = '';

	async function handleSignin() {
		loading = true;
		error = '';

		try {
			const { data, error: signinError } = await supabase.auth.signInWithPassword({
				email,
				password
			});

			if (signinError) {
				error = signinError.message;
			} else {
				goto('/');
			}
		} catch (err) {
			error = 'An unexpected error occurred';
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>Sign In - Interest Selector</title>
</svelte:head>

<main>
	<div class="auth-container">
		<h1>Sign In</h1>
		
		<form on:submit|preventDefault={handleSignin}>
			<div class="form-group">
				<label for="email">Email</label>
				<input 
					id="email"
					type="email" 
					bind:value={email} 
					required 
					placeholder="Enter your email"
				/>
			</div>

			<div class="form-group">
				<label for="password">Password</label>
				<input 
					id="password"
					type="password" 
					bind:value={password} 
					required 
					placeholder="Enter your password"
				/>
			</div>

			{#if error}
				<div class="error-message">
					{error}
				</div>
			{/if}

			<button type="submit" disabled={loading}>
				{loading ? 'Signing In...' : 'Sign In'}
			</button>
		</form>

		<div class="auth-links">
			<p>Don't have an account? <a href="/signup">Sign up</a></p>
		</div>
	</div>
</main>

<style>
	main {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 100vh;
		padding: 2em;
		background: #f8f9fa;
	}

	.auth-container {
		background: white;
		padding: 3em;
		border-radius: 12px;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
		width: 100%;
		max-width: 400px;
	}

	h1 {
		text-align: center;
		color: #ff3e00;
		margin-bottom: 2em;
		font-size: 2.5em;
		font-weight: 100;
	}

	.form-group {
		margin-bottom: 1.5em;
	}

	label {
		display: block;
		margin-bottom: 0.5em;
		font-weight: 500;
		color: #333;
	}

	input {
		width: 100%;
		padding: 0.75em;
		border: 2px solid #ddd;
		border-radius: 6px;
		font-size: 1em;
		box-sizing: border-box;
		transition: border-color 0.2s;
	}

	input:focus {
		outline: none;
		border-color: #ff3e00;
	}

	button {
		width: 100%;
		padding: 0.75em;
		background: #ff3e00;
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 1em;
		cursor: pointer;
		transition: background-color 0.2s;
		margin-top: 1em;
	}

	button:hover:not(:disabled) {
		background: #e63600;
	}

	button:disabled {
		background: #ccc;
		cursor: not-allowed;
	}

	.error-message {
		background: #fee;
		color: #c33;
		padding: 0.75em;
		border-radius: 6px;
		margin-bottom: 1em;
		border: 1px solid #fcc;
	}

	.auth-links {
		text-align: center;
		margin-top: 2em;
		padding-top: 2em;
		border-top: 1px solid #eee;
	}

	.auth-links a {
		color: #ff3e00;
		text-decoration: none;
	}

	.auth-links a:hover {
		text-decoration: underline;
	}
</style>