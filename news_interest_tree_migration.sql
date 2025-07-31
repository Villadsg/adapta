-- Migration: Create news_interest_tree table for hierarchical content discovery
-- This table stores the tree structure where custom interests are root nodes
-- and approved news articles become child nodes that can spawn their own children

CREATE TABLE IF NOT EXISTS news_interest_tree (
    id BIGSERIAL PRIMARY KEY,
    node_id VARCHAR(255) NOT NULL, -- Unique identifier for this node
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    parent_node_id VARCHAR(255), -- NULL for root nodes (custom interests)
    
    -- Node type and content
    node_type VARCHAR(50) NOT NULL CHECK (node_type IN ('interest', 'news')),
    title VARCHAR(500) NOT NULL, -- Interest name or news article title
    content_data JSONB NOT NULL DEFAULT '{}'::jsonb, -- Flexible storage for node-specific data
    
    -- Tree-specific fields
    depth INTEGER NOT NULL DEFAULT 0, -- 0 for root nodes, 1+ for children
    path TEXT[], -- Array of node_ids from root to this node (for efficient queries)
    
    -- Quality and performance metrics (Thompson Sampling)
    positive_reactions INTEGER NOT NULL DEFAULT 1, -- Good feedback count
    negative_reactions INTEGER NOT NULL DEFAULT 1, -- Bad feedback count
    quality_score DECIMAL(5,4) NOT NULL DEFAULT 0.5000, -- Calculated quality score
    times_selected INTEGER NOT NULL DEFAULT 0, -- How many times used for content discovery
    
    -- Content metadata (for news nodes)
    url VARCHAR(1000), -- News article URL
    snippet TEXT, -- News article snippet
    keywords JSONB NOT NULL DEFAULT '[]'::jsonb, -- Extracted keywords
    
    -- Status and lifecycle
    status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'hidden')),
    approval_status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_used_at TIMESTAMP WITH TIME ZONE,
    
    -- Constraints
    UNIQUE(user_id, node_id)
);

-- Indexes for efficient tree operations
CREATE INDEX IF NOT EXISTS idx_news_tree_user_id ON news_interest_tree(user_id);
CREATE INDEX IF NOT EXISTS idx_news_tree_node_id ON news_interest_tree(node_id);
CREATE INDEX IF NOT EXISTS idx_news_tree_parent ON news_interest_tree(user_id, parent_node_id);
CREATE INDEX IF NOT EXISTS idx_news_tree_path ON news_interest_tree USING GIN (path);
CREATE INDEX IF NOT EXISTS idx_news_tree_type ON news_interest_tree(user_id, node_type);
CREATE INDEX IF NOT EXISTS idx_news_tree_quality ON news_interest_tree(user_id, quality_score DESC, status);
CREATE INDEX IF NOT EXISTS idx_news_tree_depth ON news_interest_tree(user_id, depth, status);

-- Update timestamp trigger
CREATE TRIGGER update_news_interest_tree_updated_at 
    BEFORE UPDATE ON news_interest_tree 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Enable RLS (Row Level Security)
ALTER TABLE news_interest_tree ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only access their own tree nodes
CREATE POLICY "Users can access own tree nodes" ON news_interest_tree
    FOR ALL USING (auth.uid() = user_id);

-- Function to automatically update quality_score when reactions change
CREATE OR REPLACE FUNCTION update_tree_node_quality_score()
RETURNS TRIGGER AS $$
BEGIN
    -- Calculate new quality score using Thompson Sampling approach
    NEW.quality_score = NEW.positive_reactions::DECIMAL / 
                       (NEW.positive_reactions + NEW.negative_reactions)::DECIMAL;
    
    -- Update timestamp
    NEW.updated_at = NOW();
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_quality_score_trigger
    BEFORE UPDATE OF positive_reactions, negative_reactions ON news_interest_tree
    FOR EACH ROW EXECUTE FUNCTION update_tree_node_quality_score();

-- Function to update path when parent relationships change
CREATE OR REPLACE FUNCTION update_tree_node_path()
RETURNS TRIGGER AS $$
DECLARE
    parent_path TEXT[] := '{}';
BEGIN
    -- If this is a root node (no parent), path is just this node
    IF NEW.parent_node_id IS NULL THEN
        NEW.path = ARRAY[NEW.node_id];
        NEW.depth = 0;
    ELSE
        -- Get parent's path
        SELECT path INTO parent_path 
        FROM news_interest_tree 
        WHERE user_id = NEW.user_id AND node_id = NEW.parent_node_id;
        
        -- Build new path by appending this node to parent's path
        NEW.path = parent_path || ARRAY[NEW.node_id];
        NEW.depth = array_length(parent_path, 1);
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_path_trigger
    BEFORE INSERT OR UPDATE OF parent_node_id ON news_interest_tree
    FOR EACH ROW EXECUTE FUNCTION update_tree_node_path();

-- Function to cascade quality score updates to parent nodes
CREATE OR REPLACE FUNCTION cascade_quality_to_parents(
    p_user_id UUID,
    p_node_id VARCHAR(255),
    p_reaction VARCHAR(10) -- 'positive' or 'negative'
) RETURNS VOID AS $$
DECLARE
    current_node RECORD;
    parent_node_id VARCHAR(255);
BEGIN
    -- Get current node info
    SELECT * INTO current_node
    FROM news_interest_tree
    WHERE user_id = p_user_id AND node_id = p_node_id;
    
    -- If no parent, nothing to cascade
    IF current_node.parent_node_id IS NULL THEN
        RETURN;
    END IF;
    
    parent_node_id := current_node.parent_node_id;
    
    -- Update parent with cascaded feedback (reduced weight)
    IF p_reaction = 'positive' THEN
        UPDATE news_interest_tree
        SET positive_reactions = positive_reactions + 1,
            last_used_at = NOW()
        WHERE user_id = p_user_id AND node_id = parent_node_id;
    ELSE
        UPDATE news_interest_tree
        SET negative_reactions = negative_reactions + 1,
            last_used_at = NOW()
        WHERE user_id = p_user_id AND node_id = parent_node_id;
    END IF;
    
    -- Recursively cascade to grandparent (with even more reduced weight)
    PERFORM cascade_quality_to_parents(p_user_id, parent_node_id, p_reaction);
END;
$$ LANGUAGE plpgsql;

-- Function to get all child nodes of a given node
CREATE OR REPLACE FUNCTION get_child_nodes(
    p_user_id UUID,
    p_parent_node_id VARCHAR(255),
    p_max_depth INTEGER DEFAULT 10
) RETURNS TABLE (
    node_id VARCHAR(255),
    title VARCHAR(500),
    node_type VARCHAR(50),
    depth INTEGER,
    quality_score DECIMAL(5,4),
    approval_status VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        nt.node_id,
        nt.title,
        nt.node_type,
        nt.depth,
        nt.quality_score,
        nt.approval_status,
        nt.created_at
    FROM news_interest_tree nt
    WHERE nt.user_id = p_user_id
      AND nt.parent_node_id = p_parent_node_id
      AND nt.depth <= p_max_depth
      AND nt.status = 'active'
    ORDER BY nt.quality_score DESC, nt.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Function to get the full path to root for any node
CREATE OR REPLACE FUNCTION get_node_ancestry(
    p_user_id UUID,
    p_node_id VARCHAR(255)
) RETURNS TABLE (
    node_id VARCHAR(255),
    title VARCHAR(500),
    node_type VARCHAR(50),
    depth INTEGER,
    quality_score DECIMAL(5,4)
) AS $$
DECLARE
    node_path TEXT[];
BEGIN
    -- Get the path array for this node
    SELECT path INTO node_path
    FROM news_interest_tree
    WHERE user_id = p_user_id AND node_id = p_node_id;
    
    -- Return all nodes in the path
    RETURN QUERY
    SELECT 
        nt.node_id,
        nt.title,
        nt.node_type,
        nt.depth,
        nt.quality_score
    FROM news_interest_tree nt
    WHERE nt.user_id = p_user_id
      AND nt.node_id = ANY(node_path)
    ORDER BY nt.depth ASC;
END;
$$ LANGUAGE plpgsql;

-- Comments for documentation
COMMENT ON TABLE news_interest_tree IS 'Hierarchical tree structure for news content discovery based on user interests and feedback';
COMMENT ON COLUMN news_interest_tree.node_id IS 'Unique identifier for this tree node (e.g., interest_tech, news_12345)';
COMMENT ON COLUMN news_interest_tree.parent_node_id IS 'Reference to parent node - NULL for root nodes (custom interests)';
COMMENT ON COLUMN news_interest_tree.node_type IS 'Type of node: interest (root) or news (article that was approved)';
COMMENT ON COLUMN news_interest_tree.content_data IS 'Flexible JSON storage for node-specific data (search params, metadata, etc.)';
COMMENT ON COLUMN news_interest_tree.path IS 'Array of node_ids from root to this node for efficient tree traversal';
COMMENT ON COLUMN news_interest_tree.depth IS 'How deep this node is in the tree (0 = root interest, 1+ = news articles)';
COMMENT ON COLUMN news_interest_tree.quality_score IS 'Thompson Sampling quality score (positive_reactions / total_reactions)';
COMMENT ON COLUMN news_interest_tree.approval_status IS 'Whether this news was approved (good), rejected (bad), or still pending';