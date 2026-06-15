ALTER TABLE community_submissions ADD COLUMN target_recipe_id TEXT REFERENCES community_recipes(id);
ALTER TABLE community_submissions ADD COLUMN base_recipe_checksum TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_community_submissions_pending_revision
  ON community_submissions(target_recipe_id)
  WHERE status = 'pending' AND target_recipe_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_community_submissions_target_recipe
  ON community_submissions(target_recipe_id, created_at DESC);
