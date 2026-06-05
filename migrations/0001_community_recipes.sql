CREATE TABLE IF NOT EXISTS community_submissions (
  id TEXT PRIMARY KEY,
  submitter_user_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  recipe_checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason TEXT,
  moderator_notes TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT
);

CREATE TABLE IF NOT EXISTS community_recipes (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  recipe_checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('published', 'hidden')),
  save_count INTEGER NOT NULL DEFAULT 0 CHECK (save_count >= 0),
  rating_count INTEGER NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  rating_sum INTEGER NOT NULL DEFAULT 0 CHECK (rating_sum >= 0),
  name_normalized TEXT NOT NULL,
  search_tokens_json TEXT NOT NULL,
  tag_ids_json TEXT NOT NULL,
  method_ids_json TEXT NOT NULL,
  published_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES community_submissions(id)
);

CREATE TABLE IF NOT EXISTS community_recipe_saves (
  recipe_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (recipe_id, user_id),
  FOREIGN KEY (recipe_id) REFERENCES community_recipes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS community_recipe_ratings (
  recipe_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (recipe_id, user_id),
  FOREIGN KEY (recipe_id) REFERENCES community_recipes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS admin_moderation_events (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject')),
  submission_id TEXT NOT NULL,
  recipe_id TEXT,
  notes TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES community_submissions(id),
  FOREIGN KEY (recipe_id) REFERENCES community_recipes(id)
);

CREATE INDEX IF NOT EXISTS idx_community_submissions_status_created_at ON community_submissions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_community_recipes_status_published_at ON community_recipes(status, published_at);
CREATE INDEX IF NOT EXISTS idx_community_recipes_status_save_count ON community_recipes(status, save_count);
CREATE INDEX IF NOT EXISTS idx_community_recipes_status_rating ON community_recipes(status, rating_count, rating_sum);
CREATE INDEX IF NOT EXISTS idx_community_recipe_saves_user_recipe ON community_recipe_saves(user_id, recipe_id);
CREATE INDEX IF NOT EXISTS idx_community_recipe_ratings_user_recipe ON community_recipe_ratings(user_id, recipe_id);
CREATE INDEX IF NOT EXISTS idx_admin_moderation_events_submission ON admin_moderation_events(submission_id, created_at);
