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
