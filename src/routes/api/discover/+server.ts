import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { AdaptiveSearchSystem } from '$lib/search';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import { BRAVE_API_KEY } from '$env/static/private';

export const POST: RequestHandler = async ({ request }) => {
  try {
    console.log('🔍 Discover endpoint called');
    
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

    // Load user interests directly from database using the authenticated user's ID
    console.log('🔍 Querying user_profiles for user:', user.id);
    const { data: profileData, error: profileError } = await supabase
      .from('user_profiles')
      .select('interests')
      .eq('user_id', user.id)
      .single();

    console.log('📊 Profile query result:', { profileData, profileError });

    if (profileError) {
      if (profileError.code === 'PGRST116') {
        console.log('❌ No profile found for user');
        return json({ 
          error: 'No interests found. Please save your interests first.',
          results: [],
          debug: { userId: user.id, error: 'No profile exists' }
        }, { status: 400 });
      }
      console.log('❌ Profile error:', profileError);
      throw profileError;
    }

    const customInterests = profileData?.interests?.custom || [];
    
    console.log('🎯 Loaded interests:', { customInterests });
    
    if (customInterests.length === 0) {
      console.log('❌ No interests in profile');
      return json({ 
        error: 'No interests found. Please add some interests first.',
        results: [],
        debug: { 
          userId: user.id, 
          profileData,
          custom: customInterests
        }
      }, { status: 400 });
    }

    // Discover content based on interests using adaptive search system
    const allInterests = customInterests;
    const searchSystem = new AdaptiveSearchSystem(allInterests, {
      apiUrl: 'http://localhost:11434/api/generate',
      model: 'deepseek-r1:8b',
      temperature: 0.7,
      maxTokens: 200
    }, BRAVE_API_KEY, supabase, user.id);
    
    // Load user's learned key sentences from database
    await searchSystem.initializeWithPersistence();
    
    const searchResult = await searchSystem.searchBasedOnKeySentences(true);
    const { results, selectedSentences, selectedNodes } = searchResult;
    
    return json({
      success: true,
      results,
      selectedSentences: selectedSentences.map(s => ({
        id: s.id,
        text: s.text,
        source: s.source,
        avgFeedback: s.avgFeedback,
        timesUsed: s.timesUsed
      })),
      // Include tree node information if available
      selectedNodes: selectedNodes?.map(n => ({
        nodeId: n.nodeId,
        title: n.title,
        nodeType: n.nodeType,
        qualityScore: n.qualityScore,
        depth: n.depth,
        keywords: n.keywords
      })) || [],
      interestsUsed: {
        custom: customInterests
      },
      searchMode: selectedNodes ? 'tree-based' : 'legacy',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Content discovery error:', error);
    
    return json({
      error: 'Failed to discover content. Please check that the Ollama server is running with the deepseek-r1:8b model.',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
};

export const GET: RequestHandler = async ({ url, request }) => {
  try {
    // Get user from authorization header
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return json({ error: 'Authorization required' }, { status: 401 });
    }

    const token = authHeader.substring(7);
    
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
      return json({ error: 'Invalid token' }, { status: 401 });
    }

    // Get query parameters
    const query = url.searchParams.get('query');
    const maxResults = parseInt(url.searchParams.get('maxResults') || '10');

    if (!query) {
      return json({ error: 'Query parameter required' }, { status: 400 });
    }

    // Load user interests directly from database using the authenticated user's ID
    const { data: profileData, error: profileError } = await supabase
      .from('user_profiles')
      .select('interests')
      .eq('user_id', user.id)
      .single();

    if (profileError) {
      if (profileError.code === 'PGRST116') {
        return json({ 
          error: 'No interests found. Please add some interests first.',
          results: []
        }, { status: 400 });
      }
      throw profileError;
    }

    const customInterests = profileData?.interests?.custom || [];
    
    // Use the adaptive search system with the provided query
    const allInterests = query ? [query, ...customInterests] : customInterests;
    const searchSystem = new AdaptiveSearchSystem(allInterests, {
      apiUrl: 'http://localhost:11434/api/generate',
      model: 'deepseek-r1:8b',
      temperature: 0.7,
      maxTokens: 200
    }, BRAVE_API_KEY, supabase, user.id);
    
    // Load user's learned key sentences from database
    await searchSystem.initializeWithPersistence();
    
    const searchResult = await searchSystem.searchBasedOnKeySentences(true);
    const { results, selectedNodes } = searchResult;
    
    return json({
      success: true,
      results: results.slice(0, maxResults),
      query,
      searchMode: selectedNodes ? 'tree-based' : 'legacy',
      selectedNodes: selectedNodes?.map(n => ({
        nodeId: n.nodeId,
        title: n.title,
        nodeType: n.nodeType,
        qualityScore: n.qualityScore
      })) || [],
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Search error:', error);
    
    return json({
      error: 'Failed to search content',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
};