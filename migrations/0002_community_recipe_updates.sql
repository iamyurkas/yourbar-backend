ALTER TABLE community_submissions ADD COLUMN target_recipe_id TEXT REFERENCES community_recipes(id);
ALTER TABLE community_submissions ADD COLUMN base_recipe_checksum TEXT;
ALTER TABLE community_recipes ADD COLUMN author_user_id TEXT;

UPDATE community_recipes
SET author_user_id = (
  SELECT submitter_user_id
  FROM community_submissions
  WHERE community_submissions.id = community_recipes.submission_id
);

CREATE INDEX IF NOT EXISTS idx_community_submissions_target_status
  ON community_submissions(target_recipe_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_submissions_author_checksum_status
  ON community_submissions(submitter_user_id, recipe_checksum, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_recipes_author_checksum
  ON community_recipes(author_user_id, recipe_checksum, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_submissions_one_pending_create
  ON community_submissions(submitter_user_id, recipe_checksum)
  WHERE status = 'pending' AND target_recipe_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_submissions_one_pending_update
  ON community_submissions(target_recipe_id)
  WHERE status = 'pending' AND target_recipe_id IS NOT NULL;
