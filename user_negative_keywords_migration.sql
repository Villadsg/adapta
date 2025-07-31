-- Migration: Create user_negative_keywords table for content quality scoring
-- This table stores keywords/patterns that users have indicated they dislike

CREATE TABLE IF NOT EXISTS user_negative_keywords (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    keyword VARCHAR(255) NOT NULL, -- The negative keyword or phrase
    weight DECIMAL(3,2) NOT NULL DEFAULT 1.0, -- Strength of negative signal (0.1 to 1.0)
    frequency INTEGER NOT NULL DEFAULT 1, -- How many times this pattern was marked as bad
    first_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(), -- When first encountered
    last_reinforced TIMESTAMP WITH TIME ZONE DEFAULT NOW(), -- Last time user gave negative feedback
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Ensure unique keywords per user
    UNIQUE(user_id, keyword)
);

-- Index for fast lookups by user
CREATE INDEX IF NOT EXISTS idx_user_negative_keywords_user_id ON user_negative_keywords(user_id);

-- Index for keyword lookup and scoring
CREATE INDEX IF NOT EXISTS idx_user_negative_keywords_weight ON user_negative_keywords(user_id, weight DESC);

-- Update timestamp trigger (reuse existing function)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_user_negative_keywords_updated_at ON user_negative_keywords;
CREATE TRIGGER update_user_negative_keywords_updated_at 
    BEFORE UPDATE ON user_negative_keywords 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Enable RLS (Row Level Security)
ALTER TABLE user_negative_keywords ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only access their own negative keywords
CREATE POLICY "Users can access own negative keywords" ON user_negative_keywords
    FOR ALL USING (auth.uid() = user_id);

-- Comments for documentation
COMMENT ON TABLE user_negative_keywords IS 'Stores keywords/patterns that users have indicated they dislike for content quality scoring';
COMMENT ON COLUMN user_negative_keywords.keyword IS 'The keyword or phrase that indicates unwanted content';
COMMENT ON COLUMN user_negative_keywords.weight IS 'Strength of negative signal from 0.1 (weak) to 1.0 (strong)';
COMMENT ON COLUMN user_negative_keywords.frequency IS 'Number of times user has given negative feedback containing this keyword';
COMMENT ON COLUMN user_negative_keywords.last_reinforced IS 'Last time user gave negative feedback for content containing this keyword';

-- Example quality scoring function (can be called from application)
CREATE OR REPLACE FUNCTION calculate_content_quality_score(
    p_user_id UUID,
    p_content_text TEXT,
    p_base_score DECIMAL DEFAULT 1.0
) RETURNS DECIMAL AS $$
DECLARE
    keyword_record RECORD;
    quality_penalty DECIMAL := 0;
    final_score DECIMAL;
BEGIN
    -- Check content against user's negative keywords
    FOR keyword_record IN 
        SELECT keyword, weight 
        FROM user_negative_keywords 
        WHERE user_id = p_user_id 
        ORDER BY weight DESC
    LOOP
        -- Case-insensitive match
        IF LOWER(p_content_text) LIKE '%' || LOWER(keyword_record.keyword) || '%' THEN
            quality_penalty := quality_penalty + keyword_record.weight;
        END IF;
    END LOOP;
    
    -- Calculate final score (penalize based on negative matches)
    final_score := p_base_score * GREATEST(0.1, 1.0 - (quality_penalty * 0.3));
    
    RETURN final_score;
END;
$$ LANGUAGE plpgsql;