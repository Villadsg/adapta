import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { AdaptiveSearchSystem } from '$lib/search';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { BRAVE_API_KEY } from '$env/static/private';

export const POST: RequestHandler = async ({ request }) => {
  try {
    console.log('📝 Feedback endpoint called');
    
    // Get user from authorization header
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('❌ No authorization header');
      return json({ error: 'Authorization required' }, { status: 401 });
    }

    const token = authHeader.substring(7);
    console.log('🔑 Token received, length:', token.length);
    
    // Create a server-side Supabase client with the user's session
    const supabase = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    });
    
    // Verify the token with Supabase
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      console.log('❌ Auth error:', authError);
      return json({ error: 'Invalid token' }, { status: 401 });
    }

    console.log('✅ User authenticated:', user.id);

    // Parse request body
    const { resultId, reaction, title, snippet, url, contributingSentenceIds, contributingNodeIds, searchQuery } = await request.json();
    
    if (!resultId || !reaction || !title || !snippet) {
      return json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (reaction !== 'good' && reaction !== 'bad') {
      return json({ error: 'Invalid reaction. Must be "good" or "bad"' }, { status: 400 });
    }

    console.log(`📝 Processing ${reaction} feedback for result: ${title}`);

    // Load user interests for context
    const { data: profileData, error: profileError } = await supabase
      .from('user_profiles')
      .select('interests')
      .eq('user_id', user.id)
      .single();

    if (profileError) {
      console.log('❌ Profile error:', profileError);
      return json({ error: 'Failed to load user profile' }, { status: 400 });
    }

    const customInterests = profileData?.interests?.custom || [];
    const allInterests = customInterests;

    // Initialize search system for feedback processing
    const searchSystem = new AdaptiveSearchSystem(allInterests, {
      apiUrl: 'http://localhost:11434/api/generate',
      model: 'deepseek-r1:8b',
      temperature: 0.7,
      maxTokens: 200
    }, BRAVE_API_KEY, supabase, user.id);

    // Load user's existing key sentences from database
    await searchSystem.initializeWithPersistence();

    // Extract keywords from the content using LLM
    const contentText = `${title}. ${snippet}`;
    console.log('🧠 Extracting keywords from content...');
    
    // Use the existing extractKeywordsWithLLM method
    const extractedKeywords = await searchSystem.extractKeywordsFromContent(contentText);
    
    console.log('🔑 Extracted keywords:', extractedKeywords);

    // Create feedback object with extended metadata for tree processing
    const feedback = {
      resultId,
      reaction: reaction === 'good' ? 'positive' as const : 'negative' as const,
      timestamp: new Date(),
      extractedKeywords,
      contributingSentenceIds: contributingSentenceIds || [],
      // Extended metadata for tree processing
      contributingNodeIds: contributingNodeIds || [],
      title,
      snippet,
      url,
      searchQuery
    };

    // Process the feedback through the adaptive search system
    await searchSystem.processFeedback([feedback]);

    // Save the updated key sentences back to the database
    await searchSystem.persistAfterFeedback();

    console.log('✅ Feedback processed successfully');

    return json({
      success: true,
      message: `${reaction === 'good' ? 'Positive' : 'Negative'} feedback recorded`,
      extractedKeywords,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Feedback processing error:', error);
    
    return json({
      error: 'Failed to process feedback. Please check that the Ollama server is running.',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
};