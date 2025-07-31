import { supabase } from './supabase';

export interface UserProfile {
	id: number;
	user_id: string;
	interests: {
		custom: string[];
	};
	created_at: string;
	updated_at: string;
}

export async function saveUserInterests(commonInterests: string[], customInterests: string[]) {
	console.log('💾 Saving interests:', { customInterests });
	
	const user = await supabase.auth.getUser();
	if (!user.data.user) {
		throw new Error('User not authenticated');
	}

	const userId = user.data.user.id;
	console.log('👤 User ID:', userId);
	
	const interestsData = {
		custom: customInterests
	};

	console.log('📝 Interests data to save:', interestsData);

	// Check if user profile exists
	const { data: existingProfile } = await supabase
		.from('user_profiles')
		.select('id')
		.eq('user_id', userId)
		.single();

	console.log('🔍 Existing profile check:', existingProfile);

	if (existingProfile) {
		// Update existing profile
		console.log('🔄 Updating existing profile');
		const { data, error } = await supabase
			.from('user_profiles')
			.update({ interests: interestsData })
			.eq('user_id', userId)
			.select();

		if (error) {
			console.log('❌ Update error:', error);
			throw error;
		}

		console.log('✅ Profile updated:', data);
		return data;
	} else {
		// Create new profile
		console.log('🆕 Creating new profile');
		const { data, error } = await supabase
			.from('user_profiles')
			.insert({
				user_id: userId,
				interests: interestsData
			})
			.select();

		if (error) {
			console.log('❌ Insert error:', error);
			throw error;
		}

		console.log('✅ Profile created:', data);
		return data;
	}
}

export async function loadUserInterests(): Promise<{ customInterests: string[] }> {
	const user = await supabase.auth.getUser();
	if (!user.data.user) {
		return { customInterests: [] };
	}

	const { data, error } = await supabase
		.from('user_profiles')
		.select('interests')
		.eq('user_id', user.data.user.id)
		.single();

	if (error) {
		// If no profile exists yet, return empty arrays
		if (error.code === 'PGRST116') {
			return { customInterests: [] };
		}
		throw error;
	}

	return {
		customInterests: data?.interests?.custom || []
	};
}

export async function getUserProfile(): Promise<UserProfile | null> {
	const user = await supabase.auth.getUser();
	if (!user.data.user) {
		return null;
	}

	const { data, error } = await supabase
		.from('user_profiles')
		.select('*')
		.eq('user_id', user.data.user.id)
		.single();

	if (error) {
		if (error.code === 'PGRST116') {
			return null;
		}
		throw error;
	}

	return data;
}