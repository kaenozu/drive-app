-- name: GetOrCreateUser :one
INSERT INTO users (id, created_at, last_seen)
VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT(id) DO UPDATE SET last_seen = CURRENT_TIMESTAMP
RETURNING *;

-- name: GetUserPreferences :one
SELECT * FROM user_preferences WHERE user_id = ?;

-- name: UpsertUserPreferences :one
INSERT INTO user_preferences (user_id, preferred_categories, preferred_distance_km, preferred_time_hours, avoid_categories, updated_at)
VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
ON CONFLICT(user_id) DO UPDATE SET
    preferred_categories = excluded.preferred_categories,
    preferred_distance_km = excluded.preferred_distance_km,
    preferred_time_hours = excluded.preferred_time_hours,
    avoid_categories = excluded.avoid_categories,
    updated_at = CURRENT_TIMESTAMP
RETURNING *;

-- name: AddVisitHistory :one
INSERT INTO visit_history (user_id, spot_id, visited_at, rating, comment)
VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?)
RETURNING *;

-- name: GetUserVisitHistory :many
SELECT vh.*, s.name as spot_name, s.category as spot_category
FROM visit_history vh
JOIN spots s ON vh.spot_id = s.id
WHERE vh.user_id = ?
ORDER BY vh.visited_at DESC
LIMIT ?;

-- name: GetUserVisitedSpotIDs :many
SELECT DISTINCT spot_id FROM visit_history WHERE user_id = ?;

-- name: AddRecommendationHistory :one
INSERT INTO recommendation_history (user_id, spot_id, recommended_at, was_accepted)
VALUES (?, ?, CURRENT_TIMESTAMP, ?)
RETURNING *;

-- name: GetRecentRecommendations :many
SELECT spot_id FROM recommendation_history
WHERE user_id = ? AND recommended_at > datetime('now', '-7 days')
ORDER BY recommended_at DESC;

-- name: UpdateRecommendationAccepted :exec
UPDATE recommendation_history SET was_accepted = TRUE
WHERE user_id = ? AND spot_id = ?;

-- name: GetUserStats :one
SELECT 
    COUNT(DISTINCT vh.spot_id) as total_visits,
    AVG(vh.rating) as avg_rating,
    (
        SELECT category FROM (
            SELECT s.category, COUNT(*) as cnt
            FROM visit_history vh2
            JOIN spots s ON vh2.spot_id = s.id
            WHERE vh2.user_id = vh.user_id AND vh2.rating >= 4
            GROUP BY s.category
            ORDER BY cnt DESC
            LIMIT 1
        )
    ) as favorite_category
FROM visit_history vh
WHERE vh.user_id = ?;
