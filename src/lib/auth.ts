import { writable } from 'svelte/store';
import { supabase } from './supabase';
import type { User } from '@supabase/supabase-js';

export const user = writable<User | null>(null);
export const loading = writable(true);

export async function initAuth() {
	loading.set(true);
	
	const { data: { session } } = await supabase.auth.getSession();
	user.set(session?.user ?? null);
	loading.set(false);

	supabase.auth.onAuthStateChange((_event, session) => {
		user.set(session?.user ?? null);
	});
}

export async function signOut() {
	await supabase.auth.signOut();
}