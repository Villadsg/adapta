-- Migration: Create user_key_sentences table for persistent learning
-- This table stores learned key sentences with their performance metrics per user

CREATE TABLE IF NOT EXISTS user_key_sentences (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    sentence_id VARCHAR(255) NOT NULL, -- Unique identifier for the sentence
    text TEXT NOT NULL, -- The actual search sentence
    source VARCHAR(50) NOT NULL CHECK (source IN ('user', 'feedback', 'llm')),
    positive_reactions INTEGER NOT NULL DEFAULT 1, -- Good feedback count
    negative_reactions INTEGER NOT NULL DEFAULT 1, -- Bad feedback count
    times_used INTEGER NOT NULL DEFAULT 0, -- Usage counter for diversity penalty
    keywords JSONB NOT NULL DEFAULT '[]'::jsonb, -- Associated keywords
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Ensure unique sentences per user
    UNIQUE(user_id, sentence_id)
);

-- Index for fast lookups by user
CREATE INDEX IF NOT EXISTS idx_user_key_sentences_user_id ON user_key_sentences(user_id);

-- Index for sentence lookup
CREATE INDEX IF NOT EXISTS idx_user_key_sentences_sentence_id ON user_key_sentences(sentence_id);

-- Update timestamp trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_user_key_sentences_updated_at 
    BEFORE UPDATE ON user_key_sentences 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Enable RLS (Row Level Security)
ALTER TABLE user_key_sentences ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only access their own key sentences
CREATE POLICY "Users can access own key sentences" ON user_key_sentences
    FOR ALL USING (auth.uid() = user_id);

-- Comment for documentation
COMMENT ON TABLE user_key_sentences IS 'Stores learned key sentences with Thompson Sampling performance metrics for each user';
COMMENT ON COLUMN user_key_sentences.sentence_id IS 'Unique identifier for the sentence (e.g., llm_timestamp_random)';
COMMENT ON COLUMN user_key_sentences.positive_reactions IS 'Number of positive user feedback reactions (starts at 1 for neutral prior)';
COMMENT ON COLUMN user_key_sentences.negative_reactions IS 'Number of negative user feedback reactions (starts at 1 for neutral prior)';
COMMENT ON COLUMN user_key_sentences.times_used IS 'Number of times this sentence was used for search (for diversity penalty)';
COMMENT ON COLUMN user_key_sentences.keywords IS 'JSON array of keywords associated with this sentence';