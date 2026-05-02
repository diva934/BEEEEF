-- Migration: debate_history
-- Persists probability history points across server restarts.
-- Run once in your Supabase SQL editor.

CREATE TABLE IF NOT EXISTS debate_history (
  id           BIGSERIAL PRIMARY KEY,
  debate_id    TEXT        NOT NULL,
  recorded_at  BIGINT      NOT NULL,   -- unix timestamp ms
  yes_prob     REAL        NOT NULL,   -- 0-100 (yesProbability)
  volume       REAL        NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast range lookups by debate + time
CREATE INDEX IF NOT EXISTS idx_debate_history_lookup
  ON debate_history (debate_id, recorded_at ASC);

-- Prevent exact-duplicate rows (same debate + same ms timestamp)
CREATE UNIQUE INDEX IF NOT EXISTS idx_debate_history_unique
  ON debate_history (debate_id, recorded_at);

-- Row-level security: service role can do everything; anon can only SELECT
ALTER TABLE debate_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "service role full access"
  ON debate_history
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "anon read only"
  ON debate_history
  FOR SELECT
  TO anon
  USING (true);
