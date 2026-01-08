-- name: GetAllSpots :many
SELECT * FROM spots ORDER BY created_at DESC;

-- name: GetSpotsByCategory :many
SELECT * FROM spots WHERE category = ? ORDER BY rating DESC;

-- name: GetSpotByID :one
SELECT * FROM spots WHERE id = ?;

-- name: CreateSpot :one
INSERT INTO spots (name, description, category, latitude, longitude, address, image_url, rating, created_by)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: DeleteSpot :exec
DELETE FROM spots WHERE id = ?;

-- name: GetNearbySpots :many
SELECT *,
    (6371 * acos(cos(radians(?)) * cos(radians(latitude)) * cos(radians(longitude) - radians(?)) + sin(radians(?)) * sin(radians(latitude)))) AS distance
FROM spots
ORDER BY distance
LIMIT ?;

-- name: AddFavorite :exec
INSERT OR IGNORE INTO favorites (user_id, spot_id) VALUES (?, ?);

-- name: RemoveFavorite :exec
DELETE FROM favorites WHERE user_id = ? AND spot_id = ?;

-- name: GetUserFavorites :many
SELECT s.* FROM spots s
JOIN favorites f ON s.id = f.spot_id
WHERE f.user_id = ?
ORDER BY f.created_at DESC;

-- name: IsFavorite :one
SELECT COUNT(*) FROM favorites WHERE user_id = ? AND spot_id = ?;
