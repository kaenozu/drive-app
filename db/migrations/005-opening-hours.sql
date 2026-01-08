-- Add opening hours to spots
ALTER TABLE spots ADD COLUMN opening_time TEXT; -- e.g., "09:00"
ALTER TABLE spots ADD COLUMN closing_time TEXT; -- e.g., "17:00"
ALTER TABLE spots ADD COLUMN closed_days TEXT;  -- e.g., "月,火" or "Monday,Tuesday"

-- Track route history to avoid repetition
CREATE TABLE IF NOT EXISTS route_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    route_hash TEXT NOT NULL, -- hash of spot IDs to detect duplicates
    spot_ids TEXT NOT NULL,   -- JSON array of spot IDs
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_route_history_user ON route_history(user_id);

INSERT OR IGNORE INTO migrations (migration_number, migration_name) VALUES (5, '005-opening-hours');
