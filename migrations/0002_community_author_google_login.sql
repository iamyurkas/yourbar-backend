ALTER TABLE community_submissions ADD COLUMN submitter_google_login TEXT;
ALTER TABLE community_recipes ADD COLUMN author_google_login TEXT;
CREATE INDEX IF NOT EXISTS idx_community_recipes_author_google_login ON community_recipes(author_google_login);
