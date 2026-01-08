-- User preferences and history for AI recommendations

-- Users table (identified by cookie)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Visit history (which spots user has visited)
CREATE TABLE IF NOT EXISTS visit_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    spot_id INTEGER NOT NULL,
    visited_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    rating INTEGER, -- 1-5 stars, NULL if not rated
    comment TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (spot_id) REFERENCES spots(id)
);

-- User preferences (learned from behavior)
CREATE TABLE IF NOT EXISTS user_preferences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL UNIQUE,
    preferred_categories TEXT, -- JSON array of preferred categories
    preferred_distance_km REAL, -- preferred driving distance
    preferred_time_hours REAL, -- preferred trip duration
    avoid_categories TEXT, -- JSON array of categories to avoid
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Recommendation history (to avoid repetition)
CREATE TABLE IF NOT EXISTS recommendation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    spot_id INTEGER NOT NULL,
    recommended_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    was_accepted BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (spot_id) REFERENCES spots(id)
);

CREATE INDEX IF NOT EXISTS idx_visit_history_user ON visit_history(user_id);
CREATE INDEX IF NOT EXISTS idx_recommendation_history_user ON recommendation_history(user_id);

-- Record execution of this migration
INSERT OR IGNORE INTO migrations (migration_number, migration_name)
VALUES (003, '003-users');
