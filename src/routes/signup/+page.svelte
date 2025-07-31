<script lang="ts">
	import { supabase } from '$lib/supabase';
	import { goto } from '$app/navigation';

	let email = '';
	let password = '';
	let confirmPassword = '';
	let loading = false;
	let error = '';
	let success = false;

	async function handleSignup() {
		if (password !== confirmPassword) {
			error = 'Passwords do not match';
			return;
		}

		if (password.length < 6) {
			error = 'Password must be at least 6 characters';
			return;
		}

		loading = true;
		error = '';

		try {
			const { data, error: signupError } = await supabase.auth.signUp({
				email,
				password
			});

			if (signupError) {
				error = signupError.message;
			} else {
				success = true;
				setTimeout(() => {
					goto('/signin');
				}, 2000);
			}
		} catch (err) {
			error = 'An unexpected error occurred';
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>Sign Up - Interest Selector</title>
</svelte:head>

<main>
	<div class="auth-container">
		<h1>Sign Up</h1>
		
		{#if success}
			<div class="success-message">
				<p>Account created successfully! Check your email to confirm your account.</p>
				<p>Redirecting to sign in...</p>
			</div>
		{:else}
			<form on:submit|preventDefault={handleSignup}>
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
						minlength="6"
					/>
				</div>

				<div class="form-group">
					<label for="confirm-password">Confirm Password</label>
					<input 
						id="confirm-password"
						type="password" 
						bind:value={confirmPassword} 
						required 
						placeholder="Confirm your password"
						minlength="6"
					/>
				</div>

				{#if error}
					<div class="error-message">
						{error}
					</div>
				{/if}

				<button type="submit" disabled={loading}>
					{loading ? 'Creating Account...' : 'Sign Up'}
				</button>
			</form>

			<div class="auth-links">
				<p>Already have an account? <a href="/signin">Sign in</a></p>
			</div>
		{/if}
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

	.success-message {
		background: #efe;
		color: #363;
		padding: 1.5em;
		border-radius: 6px;
		text-align: center;
		border: 1px solid #cfc;
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