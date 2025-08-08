-- Migration: Add embedding support and combination nodes to the existing system
-- This enhances the tree structure to support vector embeddings and creative combinations

-- Enable pgvector extension if available (optional - will work without it too)
-- CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding columns to the existing news_interest_tree table
ALTER TABLE news_interest_tree 
ADD COLUMN IF NOT EXISTS embedding JSONB, -- Store embedding as JSON array (compatible without pgvector)
ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(100) DEFAULT 'nomic-embed-text',
ADD COLUMN IF NOT EXISTS embedding_generated_at TIMESTAMP WITH TIME ZONE;

-- Update the node_type constraint to include combination nodes
ALTER TABLE news_interest_tree 
DROP CONSTRAINT IF EXISTS news_interest_tree_node_type_check;

ALTER TABLE news_interest_tree 
ADD CONSTRAINT news_interest_tree_node_type_check 
CHECK (node_type IN ('interest', 'news', 'combination'));

-- Add combination-specific metadata columns
ALTER TABLE news_interest_tree 
ADD COLUMN IF NOT EXISTS source_node_ids JSONB, -- Array of source node IDs for combinations
ADD COLUMN IF NOT EXISTS combination_type VARCHAR(50), -- Type of combination
ADD COLUMN IF NOT EXISTS confidence_score DECIMAL(5,4), -- Confidence in the combination
ADD COLUMN IF NOT EXISTS potential_queries JSONB; -- Suggested search queries

-- Create embedding_analyses table for storing analysis results
CREATE TABLE IF NOT EXISTS embedding_analyses (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    total_interests INTEGER NOT NULL,
    clusters_count INTEGER NOT NULL,
    relationships_count INTEGER NOT NULL,
    combinations_count INTEGER NOT NULL,
    analysis_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    clusters_data JSONB, -- Stored cluster information
    combinations_data JSONB, -- Stored combination suggestions
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Constraints
    UNIQUE(user_id, analysis_timestamp)
);

-- Create interest_relationships table for caching embedding-based relationships
CREATE TABLE IF NOT EXISTS interest_relationships (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    source_node_id VARCHAR(255) NOT NULL,
    target_node_id VARCHAR(255) NOT NULL,
    similarity_score DECIMAL(6,5) NOT NULL, -- 0.0 to 1.0 with high precision
    relationship_type VARCHAR(50) NOT NULL CHECK (relationship_type IN ('semantic', 'geographic', 'functional', 'temporal')),
    computed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Constraints
    UNIQUE(user_id, source_node_id, target_node_id),
    CHECK(source_node_id != target_node_id)
);

-- Add indexes for embedding and relationship queries
CREATE INDEX IF NOT EXISTS idx_news_tree_embedding ON news_interest_tree(user_id, node_type) WHERE embedding IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_news_tree_combination_type ON news_interest_tree(user_id, combination_type) WHERE combination_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_news_tree_confidence ON news_interest_tree(user_id, confidence_score DESC) WHERE confidence_score IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_embedding_analyses_user_timestamp ON embedding_analyses(user_id, analysis_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_interest_relationships_user ON interest_relationships(user_id);
CREATE INDEX IF NOT EXISTS idx_interest_relationships_source ON interest_relationships(user_id, source_node_id);
CREATE INDEX IF NOT EXISTS idx_interest_relationships_similarity ON interest_relationships(user_id, similarity_score DESC);

-- Enable RLS for new tables
ALTER TABLE embedding_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE interest_relationships ENABLE ROW LEVEL SECURITY;

-- Policies for embedding_analyses
CREATE POLICY "Users can access own embedding analyses" ON embedding_analyses
    FOR ALL USING (auth.uid() = user_id);

-- Policies for interest_relationships  
CREATE POLICY "Users can access own interest relationships" ON interest_relationships
    FOR ALL USING (auth.uid() = user_id);

-- Function to create combination nodes
CREATE OR REPLACE FUNCTION create_combination_node(
    p_user_id UUID,
    p_source_node_ids TEXT[], -- Array of source node IDs
    p_combined_title VARCHAR(500),
    p_combination_type VARCHAR(50),
    p_confidence_score DECIMAL(5,4),
    p_potential_queries JSONB DEFAULT '[]'::jsonb,
    p_embedding JSONB DEFAULT NULL,
    p_keywords JSONB DEFAULT '[]'::jsonb
) RETURNS VARCHAR(255) AS $$
DECLARE
    new_node_id VARCHAR(255);
    max_depth INTEGER := 0;
    combined_path TEXT[] := '{}';
BEGIN
    -- Generate unique node ID for combination
    new_node_id := 'combo_' || extract(epoch from now())::bigint || '_' || substring(md5(random()::text) from 1 for 6);
    
    -- Determine depth and path for combination node
    -- Combinations are typically root-level or shallow
    SELECT COALESCE(MAX(depth), -1) + 1 INTO max_depth
    FROM news_interest_tree
    WHERE user_id = p_user_id AND node_id = ANY(p_source_node_ids);
    
    -- Combinations become new root nodes for now (can be enhanced later)
    combined_path := ARRAY[new_node_id];
    
    -- Insert the combination node
    INSERT INTO news_interest_tree (
        node_id, user_id, parent_node_id, node_type, title,
        depth, path, embedding, embedding_model, embedding_generated_at,
        source_node_ids, combination_type, confidence_score, potential_queries,
        keywords, status, approval_status, positive_reactions, negative_reactions
    ) VALUES (
        new_node_id, p_user_id, NULL, 'combination', p_combined_title,
        0, combined_path, p_embedding, 'nomic-embed-text', COALESCE(EXTRACT(EPOCH FROM NOW()) * 1000, NOW()),
        to_jsonb(p_source_node_ids), p_combination_type, p_confidence_score, p_potential_queries,
        p_keywords, 'active', 'approved', 2, 1  -- Start with slightly positive bias
    );
    
    RETURN new_node_id;
END;
$$ LANGUAGE plpgsql;

-- Function to find similar nodes by embedding similarity (using simple cosine similarity on JSONB)
CREATE OR REPLACE FUNCTION find_similar_nodes_by_embedding(
    p_user_id UUID,
    p_target_embedding JSONB,
    p_node_types TEXT[] DEFAULT ARRAY['interest', 'combination'],
    p_limit INTEGER DEFAULT 5,
    p_min_similarity DECIMAL DEFAULT 0.3
) RETURNS TABLE (
    node_id VARCHAR(255),
    title VARCHAR(500),
    node_type VARCHAR(50),
    similarity_score DECIMAL
) AS $$
BEGIN
    -- This is a simplified version - in production you'd want to use pgvector for efficiency
    -- For now, we'll return nodes that have embeddings and let the application calculate similarity
    RETURN QUERY
    SELECT 
        nt.node_id,
        nt.title,
        nt.node_type,
        0.5::DECIMAL as similarity_score  -- Placeholder - real similarity calculated in application
    FROM news_interest_tree nt
    WHERE nt.user_id = p_user_id
      AND nt.embedding IS NOT NULL
      AND nt.node_type = ANY(p_node_types)
      AND nt.status = 'active'
    ORDER BY nt.quality_score DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- Function to get all nodes with embeddings for analysis
CREATE OR REPLACE FUNCTION get_nodes_with_embeddings(
    p_user_id UUID,
    p_node_types TEXT[] DEFAULT ARRAY['interest', 'combination']
) RETURNS TABLE (
    node_id VARCHAR(255),
    title VARCHAR(500),
    node_type VARCHAR(50),
    embedding JSONB,
    keywords JSONB,
    quality_score DECIMAL(5,4),
    created_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        nt.node_id,
        nt.title,
        nt.node_type,
        nt.embedding,
        nt.keywords,
        nt.quality_score,
        nt.created_at
    FROM news_interest_tree nt
    WHERE nt.user_id = p_user_id
      AND nt.embedding IS NOT NULL
      AND nt.node_type = ANY(p_node_types)
      AND nt.status = 'active'
    ORDER BY nt.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Function to update combination node performance based on search results
CREATE OR REPLACE FUNCTION update_combination_performance(
    p_user_id UUID,
    p_node_id VARCHAR(255),
    p_search_success BOOLEAN,
    p_results_found INTEGER DEFAULT 0
) RETURNS VOID AS $$
BEGIN
    -- Update the combination node based on search performance
    IF p_search_success AND p_results_found > 0 THEN
        -- Successful search - boost confidence and reactions
        UPDATE news_interest_tree
        SET positive_reactions = positive_reactions + 1,
            times_selected = times_selected + 1,
            last_used_at = NOW(),
            confidence_score = LEAST(1.0, confidence_score + 0.1)
        WHERE user_id = p_user_id AND node_id = p_node_id;
    ELSE
        -- Poor search results - reduce confidence
        UPDATE news_interest_tree
        SET negative_reactions = negative_reactions + 1,
            times_selected = times_selected + 1,
            last_used_at = NOW(),
            confidence_score = GREATEST(0.1, confidence_score - 0.05)
        WHERE user_id = p_user_id AND node_id = p_node_id;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to clean up old embedding analyses (keep only latest 5 per user)
CREATE OR REPLACE FUNCTION cleanup_old_embedding_analyses()
RETURNS VOID AS $$
BEGIN
    DELETE FROM embedding_analyses
    WHERE id NOT IN (
        SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY analysis_timestamp DESC) as rn
            FROM embedding_analyses
        ) ranked
        WHERE rn <= 5
    );
END;
$$ LANGUAGE plpgsql;

-- Update the existing trigger function to handle combination nodes
CREATE OR REPLACE FUNCTION update_tree_node_quality_score()
RETURNS TRIGGER AS $$
BEGIN
    -- Calculate new quality score using Thompson Sampling approach
    NEW.quality_score = NEW.positive_reactions::DECIMAL / 
                       (NEW.positive_reactions + NEW.negative_reactions)::DECIMAL;
    
    -- For combination nodes, also update confidence score based on performance
    IF NEW.node_type = 'combination' AND NEW.confidence_score IS NOT NULL THEN
        -- Adjust confidence based on success rate
        IF NEW.quality_score > 0.6 THEN
            NEW.confidence_score = LEAST(1.0, NEW.confidence_score + 0.02);
        ELSIF NEW.quality_score < 0.4 THEN
            NEW.confidence_score = GREATEST(0.1, NEW.confidence_score - 0.01);
        END IF;
    END IF;
    
    -- Update timestamp
    NEW.updated_at = NOW();
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add comments for new columns and tables
COMMENT ON COLUMN news_interest_tree.embedding IS 'Vector embedding of the node content stored as JSON array';
COMMENT ON COLUMN news_interest_tree.source_node_ids IS 'For combination nodes: IDs of the source interests that were combined';
COMMENT ON COLUMN news_interest_tree.combination_type IS 'Type of combination: semantic_merge, skill_location, etc.';
COMMENT ON COLUMN news_interest_tree.confidence_score IS 'Confidence score for combination nodes (0.0-1.0)';
COMMENT ON COLUMN news_interest_tree.potential_queries IS 'Array of suggested search queries for combination nodes';

COMMENT ON TABLE embedding_analyses IS 'Stores results of embedding analysis sessions for interest insights';
COMMENT ON TABLE interest_relationships IS 'Caches embedding-based similarity relationships between interests';

-- Create a view for easy access to combination nodes with their sources
CREATE OR REPLACE VIEW combination_nodes_with_sources AS
SELECT 
    c.node_id,
    c.title as combination_title,
    c.combination_type,
    c.confidence_score,
    c.potential_queries,
    c.quality_score,
    c.times_selected,
    COALESCE(
        (SELECT jsonb_agg(
            jsonb_build_object(
                'node_id', s.node_id,
                'title', s.title,
                'node_type', s.node_type
            )
        )
        FROM news_interest_tree s
        WHERE s.user_id = c.user_id 
          AND s.node_id = ANY(
              SELECT jsonb_array_elements_text(c.source_node_ids)
          )),
        '[]'::jsonb
    ) as source_nodes,
    c.created_at,
    c.last_used_at,
    c.user_id
FROM news_interest_tree c
WHERE c.node_type = 'combination'
  AND c.status = 'active';

COMMENT ON VIEW combination_nodes_with_sources IS 'Convenient view showing combination nodes with their source node details';

-- Helper functions for atomic operations
CREATE OR REPLACE FUNCTION increment_positive_reactions(
    p_user_id UUID,
    p_node_id VARCHAR(255)
) RETURNS VOID AS $$
BEGIN
    UPDATE news_interest_tree
    SET positive_reactions = positive_reactions + 1,
        last_used_at = NOW(),
        approval_status = 'approved'
    WHERE user_id = p_user_id AND node_id = p_node_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION increment_negative_reactions(
    p_user_id UUID,
    p_node_id VARCHAR(255)
) RETURNS VOID AS $$
BEGIN
    UPDATE news_interest_tree
    SET negative_reactions = negative_reactions + 1,
        last_used_at = NOW(),
        approval_status = 'rejected'
    WHERE user_id = p_user_id AND node_id = p_node_id;
END;
$$ LANGUAGE plpgsql;

-- Final message
DO $$ 
BEGIN 
    RAISE NOTICE 'Embedding enhancement migration completed successfully!'; 
    RAISE NOTICE 'Added support for:';
    RAISE NOTICE '- Vector embeddings in news_interest_tree';
    RAISE NOTICE '- Combination nodes for creative search queries'; 
    RAISE NOTICE '- Embedding analyses storage';
    RAISE NOTICE '- Interest relationship caching';
    RAISE NOTICE '- Helper functions for atomic operations';
    RAISE NOTICE 'Run this migration in your Supabase SQL editor or via migration tools.';
END $$;