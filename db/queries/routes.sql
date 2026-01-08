-- name: AddRouteHistory :exec
INSERT INTO route_history (user_id, route_hash, spot_ids) VALUES (?, ?, ?);

-- name: GetRecentRouteHashes :many
SELECT route_hash FROM route_history 
WHERE user_id = ? 
ORDER BY created_at DESC 
LIMIT 20;

-- name: GetSpotsWithHours :many
SELECT id, name, description, category, latitude, longitude, address, opening_time, closing_time, closed_days
FROM spots;
