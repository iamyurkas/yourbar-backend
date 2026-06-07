PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS community_submissions (
  id TEXT PRIMARY KEY,
  submitter_user_id TEXT NOT NULL,
  author_google_login TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  recipe_checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
  rejection_reason TEXT,
  moderator_notes TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_community_submissions_status_created ON community_submissions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_submissions_author ON community_submissions(author_google_login);

CREATE TABLE IF NOT EXISTS community_recipes (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE REFERENCES community_submissions(id),
  author_google_login TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  recipe_checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('published', 'hidden')) DEFAULT 'published',
  save_count INTEGER NOT NULL DEFAULT 0 CHECK (save_count >= 0),
  rating_count INTEGER NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  rating_sum INTEGER NOT NULL DEFAULT 0 CHECK (rating_sum >= 0),
  name_normalized TEXT NOT NULL,
  search_tokens_json TEXT NOT NULL DEFAULT '[]',
  tag_ids_json TEXT NOT NULL DEFAULT '[]',
  method_ids_json TEXT NOT NULL DEFAULT '[]',
  random_key TEXT NOT NULL,
  published_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_community_recipes_status_published ON community_recipes(status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_recipes_status_saves ON community_recipes(status, save_count DESC);
CREATE INDEX IF NOT EXISTS idx_community_recipes_status_ratings ON community_recipes(status, rating_count DESC, rating_sum DESC);
CREATE INDEX IF NOT EXISTS idx_community_recipes_author ON community_recipes(author_google_login);
CREATE INDEX IF NOT EXISTS idx_community_recipes_name ON community_recipes(status, name_normalized);

CREATE TABLE IF NOT EXISTS community_recipe_saves (
  recipe_id TEXT NOT NULL REFERENCES community_recipes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (recipe_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_community_recipe_saves_user_recipe ON community_recipe_saves(user_id, recipe_id);

CREATE TABLE IF NOT EXISTS community_recipe_ratings (
  recipe_id TEXT NOT NULL REFERENCES community_recipes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (recipe_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_community_recipe_ratings_user_recipe ON community_recipe_ratings(user_id, recipe_id);

CREATE TABLE IF NOT EXISTS admin_moderation_events (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject')),
  submission_id TEXT NOT NULL REFERENCES community_submissions(id),
  recipe_id TEXT,
  moderator_notes TEXT,
  rejection_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_moderation_submission ON admin_moderation_events(submission_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_community_save_insert
AFTER INSERT ON community_recipe_saves
BEGIN
  UPDATE community_recipes SET save_count = save_count + 1, updated_at = NEW.created_at WHERE id = NEW.recipe_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_community_save_delete
AFTER DELETE ON community_recipe_saves
BEGIN
  UPDATE community_recipes SET save_count = MAX(save_count - 1, 0), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = OLD.recipe_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_community_rating_insert
AFTER INSERT ON community_recipe_ratings
BEGIN
  UPDATE community_recipes SET rating_count = rating_count + 1, rating_sum = rating_sum + NEW.rating, updated_at = NEW.updated_at WHERE id = NEW.recipe_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_community_rating_update
AFTER UPDATE OF rating ON community_recipe_ratings
WHEN OLD.rating <> NEW.rating
BEGIN
  UPDATE community_recipes SET rating_sum = MAX(rating_sum + NEW.rating - OLD.rating, 0), updated_at = NEW.updated_at WHERE id = NEW.recipe_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_community_rating_delete
AFTER DELETE ON community_recipe_ratings
BEGIN
  UPDATE community_recipes SET rating_count = MAX(rating_count - 1, 0), rating_sum = MAX(rating_sum - OLD.rating, 0), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = OLD.recipe_id;
END;
