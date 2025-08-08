-- Stored procedure to cascade quality feedback to child nodes (downward cascading)
-- This replaces the upward cascading approach with a more logical downward approach

CREATE OR REPLACE FUNCTION cascade_quality_to_children(
    p_user_id UUID,
    p_node_id VARCHAR(255),
    p_reaction VARCHAR(10)
)
RETURNS TABLE(affected_node_id VARCHAR(255), cascade_level INTEGER, impact_factor DECIMAL) 
LANGUAGE plpgsql
AS $$
DECLARE
    decay_factor CONSTANT DECIMAL := 0.7; -- Each level gets 70% of previous level's impact
    max_depth CONSTANT INTEGER := 5; -- Maximum cascade depth to prevent infinite recursion
BEGIN
    -- Create temporary table to track cascading results
    CREATE TEMP TABLE IF NOT EXISTS cascade_results (
        node_id VARCHAR(255),
        level INTEGER,
        factor DECIMAL
    );
    
    -- Clear any previous results
    DELETE FROM cascade_results;
    
    -- Recursive CTE to find all descendant nodes with their cascade levels
    WITH RECURSIVE child_nodes AS (
        -- Base case: direct children of the target node
        SELECT 
            n.node_id,
            n.user_id,
            1 as cascade_level,
            decay_factor as impact_factor
        FROM news_interest_tree n
        WHERE n.user_id = p_user_id 
          AND n.parent_node_id = p_node_id
          AND n.status = 'active'
        
        UNION ALL
        
        -- Recursive case: children of children
        SELECT 
            n.node_id,
            n.user_id,
            cn.cascade_level + 1,
            cn.impact_factor * decay_factor
        FROM news_interest_tree n
        INNER JOIN child_nodes cn ON n.parent_node_id = cn.node_id
        WHERE n.user_id = p_user_id 
          AND n.status = 'active'
          AND cn.cascade_level < max_depth -- Prevent infinite recursion
    )
    
    -- Insert cascade results for tracking
    INSERT INTO cascade_results (node_id, level, factor)
    SELECT node_id, cascade_level, impact_factor FROM child_nodes;
    
    -- Apply cascading feedback to child nodes
    IF p_reaction = 'positive' THEN
        -- Apply positive feedback cascade
        UPDATE news_interest_tree 
        SET 
            positive_reactions = positive_reactions + ROUND(cr.factor::numeric, 2),
            updated_at = NOW()
        FROM cascade_results cr
        WHERE news_interest_tree.node_id = cr.node_id 
          AND news_interest_tree.user_id = p_user_id;
    ELSE
        -- Apply negative feedback cascade
        UPDATE news_interest_tree 
        SET 
            negative_reactions = negative_reactions + ROUND(cr.factor::numeric, 2),
            updated_at = NOW()
        FROM cascade_results cr
        WHERE news_interest_tree.node_id = cr.node_id 
          AND news_interest_tree.user_id = p_user_id;
    END IF;
    
    -- Update quality scores for all affected nodes
    UPDATE news_interest_tree
    SET quality_score = CASE 
        WHEN (positive_reactions + negative_reactions) > 0 
        THEN positive_reactions / (positive_reactions + negative_reactions)
        ELSE 0.5 
    END
    FROM cascade_results cr
    WHERE news_interest_tree.node_id = cr.node_id 
      AND news_interest_tree.user_id = p_user_id;
    
    -- Return results showing which nodes were affected
    RETURN QUERY
    SELECT cr.node_id, cr.level, cr.factor
    FROM cascade_results cr
    ORDER BY cr.level, cr.node_id;
    
    -- Clean up temporary table
    DROP TABLE IF EXISTS cascade_results;
END;
$$;

-- Grant execute permission (adjust role as needed)
-- GRANT EXECUTE ON FUNCTION cascade_quality_to_children TO authenticated;

-- Example usage:
-- SELECT * FROM cascade_quality_to_children('user-uuid', 'news_node_123', 'negative');

-- Comment for documentation
COMMENT ON FUNCTION cascade_quality_to_children IS 'Cascades quality feedback from a parent node down to all its descendant nodes with exponential decay. Each cascade level applies 70% of the previous level impact.';