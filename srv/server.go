package srv

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"log/slog"
	"math"
	"net/http"
	"path/filepath"
	"runtime"
	"strconv"
	"time"

	"srv.exe.dev/db"
	"srv.exe.dev/db/dbgen"
)

type Server struct {
	DB           *sql.DB
	Hostname     string
	TemplatesDir string
	StaticDir    string
}

func New(dbPath, hostname string) (*Server, error) {
	_, thisFile, _, _ := runtime.Caller(0)
	baseDir := filepath.Dir(thisFile)
	srv := &Server{
		Hostname:     hostname,
		TemplatesDir: filepath.Join(baseDir, "templates"),
		StaticDir:    filepath.Join(baseDir, "static"),
	}
	if err := srv.setUpDatabase(dbPath); err != nil {
		return nil, err
	}
	return srv, nil
}

func (s *Server) HandleRoot(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Permissions-Policy", "geolocation=(self)")
	if err := s.renderTemplate(w, "index.html", nil); err != nil {
		slog.Warn("render template", "url", r.URL.Path, "error", err)
	}
}

func (s *Server) renderTemplate(w http.ResponseWriter, name string, data any) error {
	path := filepath.Join(s.TemplatesDir, name)
	tmpl, err := template.ParseFiles(path)
	if err != nil {
		return fmt.Errorf("parse template %q: %w", name, err)
	}
	if err := tmpl.Execute(w, data); err != nil {
		return fmt.Errorf("execute template %q: %w", name, err)
	}
	return nil
}

func (s *Server) setUpDatabase(dbPath string) error {
	wdb, err := db.Open(dbPath)
	if err != nil {
		return fmt.Errorf("failed to open db: %w", err)
	}
	s.DB = wdb
	if err := db.RunMigrations(wdb); err != nil {
		return fmt.Errorf("failed to run migrations: %w", err)
	}
	return nil
}

func (s *Server) Serve(addr string) error {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.HandleRoot)
	mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir(s.StaticDir))))

	// API routes
	mux.HandleFunc("GET /api/spots", s.HandleGetSpots)
	mux.HandleFunc("POST /api/recommend", s.HandleRecommend)
	mux.HandleFunc("POST /api/feedback", s.HandleFeedback)
	mux.HandleFunc("GET /api/history", s.HandleGetHistory)
	mux.HandleFunc("POST /api/accept", s.HandleAcceptRecommendation)

	slog.Info("starting server", "addr", addr)
	return http.ListenAndServe(addr, mux)
}

// Get user ID from cookie or create new one
func (s *Server) getUserID(w http.ResponseWriter, r *http.Request) string {
	cookie, err := r.Cookie("user_id")
	if err == nil && cookie.Value != "" {
		return cookie.Value
	}

	// Generate new user ID
	userID := fmt.Sprintf("user_%d", time.Now().UnixNano())
	http.SetCookie(w, &http.Cookie{
		Name:     "user_id",
		Value:    userID,
		Path:     "/",
		MaxAge:   365 * 24 * 60 * 60, // 1 year
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	return userID
}

func (s *Server) HandleGetSpots(w http.ResponseWriter, r *http.Request) {
	q := dbgen.New(s.DB)
	spots, err := q.GetAllSpots(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(spots)
}

// SpotWithDistance includes distance and time info
type SpotWithDistance struct {
	dbgen.Spot
	DistanceKm    float64 `json:"distance_km"`
	DrivingTimeMin int     `json:"driving_time_min"`
	RoundTripKm   float64 `json:"round_trip_km"`
	RoundTripMin  int     `json:"round_trip_min"`
}

// RecommendRequest is the request body for recommendations
type RecommendRequest struct {
	Lat           float64 `json:"lat"`
	Lng           float64 `json:"lng"`
	MaxDistanceKm float64 `json:"max_distance_km"`
	MaxTimeHours  float64 `json:"max_time_hours"`
	Category      string  `json:"category"` // optional filter
}

// RecommendResponse is the response from AI recommendations
type RecommendResponse struct {
	Spots      []SpotWithDistance `json:"spots"`
	Message    string             `json:"message"`
	UserStats  *UserStatsInfo     `json:"user_stats,omitempty"`
}

type UserStatsInfo struct {
	TotalVisits      int     `json:"total_visits"`
	FavoriteCategory string  `json:"favorite_category"`
}

func (s *Server) HandleRecommend(w http.ResponseWriter, r *http.Request) {
	userID := s.getUserID(w, r)
	
	var req RecommendRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.MaxDistanceKm == 0 {
		req.MaxDistanceKm = 100 // default 100km
	}
	if req.MaxTimeHours == 0 {
		req.MaxTimeHours = 3 // default 3 hours one way
	}

	q := dbgen.New(s.DB)

	// Ensure user exists
	_, _ = q.GetOrCreateUser(r.Context(), userID)

	// Get user's visit history
	visitedIDs, _ := q.GetUserVisitedSpotIDs(r.Context(), userID)
	visitedSet := make(map[int64]bool)
	for _, id := range visitedIDs {
		visitedSet[id] = true
	}

	// Get recent recommendations to avoid repetition
	recentRecs, _ := q.GetRecentRecommendations(r.Context(), userID)
	recentSet := make(map[int64]bool)
	for _, id := range recentRecs {
		recentSet[id] = true
	}

	// Get user stats for personalization
	var userStats *UserStatsInfo
	stats, err := q.GetUserStats(r.Context(), userID)
	if err == nil && stats.TotalVisits > 0 {
		userStats = &UserStatsInfo{
			TotalVisits:      int(stats.TotalVisits),
			FavoriteCategory: stats.FavoriteCategory,
		}
	}

	// Get visit history for AI context
	history, _ := q.GetUserVisitHistory(r.Context(), dbgen.GetUserVisitHistoryParams{
		UserID: userID,
		Limit:  20,
	})

	// Get all spots
	allSpots, err := q.GetAllSpots(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Filter and calculate distances
	var candidates []SpotWithDistance
	for _, spot := range allSpots {
		// Skip visited spots
		if visitedSet[spot.ID] {
			continue
		}

		// Calculate distance
		dist := haversine(req.Lat, req.Lng, spot.Latitude, spot.Longitude)
		if dist > req.MaxDistanceKm {
			continue
		}

		// Filter by category if specified
		if req.Category != "" && spot.Category != req.Category {
			continue
		}

		// Estimate driving time (assume 40km/h average for scenic routes)
		drivingMin := int(dist / 40 * 60)
		if float64(drivingMin)/60 > req.MaxTimeHours {
			continue
		}

		candidates = append(candidates, SpotWithDistance{
			Spot:           spot,
			DistanceKm:     math.Round(dist*10) / 10,
			DrivingTimeMin: drivingMin,
			RoundTripKm:    math.Round(dist*2*10) / 10,
			RoundTripMin:   drivingMin * 2,
		})
	}

	if len(candidates) == 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(RecommendResponse{
			Spots:   []SpotWithDistance{},
			Message: "条件に合うスポットが見つかりませんでした。距離や時間の条件を緩めてみてください。",
		})
		return
	}

	// Call AI to get recommendations
	recommended, message := s.getAIRecommendations(candidates, history, userStats, recentSet, req)

	// Record recommendations
	for _, spot := range recommended {
		falseVal := false
		q.AddRecommendationHistory(r.Context(), dbgen.AddRecommendationHistoryParams{
			UserID:      userID,
			SpotID:      spot.ID,
			WasAccepted: &falseVal,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(RecommendResponse{
		Spots:     recommended,
		Message:   message,
		UserStats: userStats,
	})
}

func (s *Server) getAIRecommendations(candidates []SpotWithDistance, history []dbgen.GetUserVisitHistoryRow, userStats *UserStatsInfo, recentSet map[int64]bool, req RecommendRequest) ([]SpotWithDistance, string) {
	// Build context for AI
	var historyContext string
	if len(history) > 0 {
		historyContext = "ユーザーの訪問履歴:\n"
		for _, h := range history {
			ratingStr := "未評価"
			if h.Rating != nil {
				ratingStr = fmt.Sprintf("%d点", *h.Rating)
			}
			historyContext += fmt.Sprintf("- %s (%s): %s\n", h.SpotName, h.SpotCategory, ratingStr)
		}
	}

	var prefContext string
	if userStats != nil && userStats.FavoriteCategory != "" {
		catLabel := map[string]string{"drive": "ドライブスポット", "restaurant": "食事", "rest": "休憩所"}[userStats.FavoriteCategory]
		prefContext = fmt.Sprintf("ユーザーの好み: %sを好む傾向があります（%d箇所訪問済み）\n", catLabel, userStats.TotalVisits)
	}

	// Build candidate list for AI
	var candidateList string
	for i, c := range candidates {
		if i >= 30 { // Limit to 30 candidates for AI
			break
		}
		recentTag := ""
		if recentSet[c.ID] {
			recentTag = " [最近おすすめ済み]"
		}
		desc := ""
		if c.Description != nil {
			desc = *c.Description
		}
		candidateList += fmt.Sprintf("%d. [ID:%d] %s (%s) - %.1fkm/片道%d分 - %s%s\n",
			i+1, c.ID, c.Name, c.Category, c.DistanceKm, c.DrivingTimeMin, desc, recentTag)
	}

	prompt := fmt.Sprintf(`あなたはドライブスポットのレコメンドAIです。
以下の情報をもとに、ユーザーに最適なドライブスポットを3〜5件選んでください。

%s%s
候補スポット:
%s

選択基準:
1. ユーザーの好みに合ったカテゴリを優先
2. 最近おすすめ済みのスポットは避ける
3. バラエティを持たせる（同じカテゴリばかりにしない）
4. 距離と所要時間のバランス

以下のJSON形式で回答してください:
{"spot_ids": [選択したスポットのID配列], "message": "おすすめ理由を簡潔に説明"}
`, prefContext, historyContext, candidateList)

	// Call Claude API
	spotIDs, message := callClaudeAPI(prompt)

	// Map IDs back to spots
	idToSpot := make(map[int64]SpotWithDistance)
	for _, c := range candidates {
		idToSpot[c.ID] = c
	}

	var result []SpotWithDistance
	for _, id := range spotIDs {
		if spot, ok := idToSpot[id]; ok {
			result = append(result, spot)
		}
	}

	// Fallback if AI didn't return enough results
	if len(result) < 3 {
		for _, c := range candidates {
			if len(result) >= 5 {
				break
			}
			alreadyIncluded := false
			for _, r := range result {
				if r.ID == c.ID {
					alreadyIncluded = true
					break
				}
			}
			if !alreadyIncluded && !recentSet[c.ID] {
				result = append(result, c)
			}
		}
		if message == "" {
			message = "距離とカテゴリのバランスを考慮しておすすめを選びました。"
		}
	}

	return result, message
}

func callClaudeAPI(prompt string) ([]int64, string) {
	reqBody := map[string]interface{}{
		"model":      "claude-sonnet-4-20250514",
		"max_tokens": 500,
		"messages": []map[string]string{
			{"role": "user", "content": prompt},
		},
	}

	jsonBody, _ := json.Marshal(reqBody)

	client := &http.Client{Timeout: 30 * time.Second}
	req, _ := http.NewRequest("POST", "http://169.254.169.254/gateway/llm/_/gateway/anthropic/v1/messages", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		slog.Error("Claude API error", "error", err)
		return nil, ""
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	var result struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		slog.Error("Parse Claude response", "error", err, "body", string(body))
		return nil, ""
	}

	if len(result.Content) == 0 {
		return nil, ""
	}

	// Parse the JSON response from Claude
	text := result.Content[0].Text
	
	// Find JSON in response
	start := -1
	end := -1
	for i, c := range text {
		if c == '{' && start == -1 {
			start = i
		}
		if c == '}' {
			end = i + 1
		}
	}

	if start == -1 || end == -1 {
		return nil, ""
	}

	var aiResp struct {
		SpotIDs []int64 `json:"spot_ids"`
		Message string  `json:"message"`
	}
	if err := json.Unmarshal([]byte(text[start:end]), &aiResp); err != nil {
		slog.Error("Parse AI JSON", "error", err, "text", text)
		return nil, ""
	}

	return aiResp.SpotIDs, aiResp.Message
}

// Haversine formula for distance calculation
func haversine(lat1, lon1, lat2, lon2 float64) float64 {
	const R = 6371 // Earth's radius in km
	dLat := (lat2 - lat1) * math.Pi / 180
	dLon := (lon2 - lon1) * math.Pi / 180
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*math.Pi/180)*math.Cos(lat2*math.Pi/180)*
			math.Sin(dLon/2)*math.Sin(dLon/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return R * c
}

// HandleFeedback records user feedback after visiting a spot
func (s *Server) HandleFeedback(w http.ResponseWriter, r *http.Request) {
	userID := s.getUserID(w, r)

	var req struct {
		SpotID  int64  `json:"spot_id"`
		Rating  int    `json:"rating"` // 1-5
		Comment string `json:"comment"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	q := dbgen.New(s.DB)
	rating := int64(req.Rating)
	_, err := q.AddVisitHistory(r.Context(), dbgen.AddVisitHistoryParams{
		UserID:  userID,
		SpotID:  req.SpotID,
		Rating:  &rating,
		Comment: &req.Comment,
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// HandleAcceptRecommendation marks a recommendation as accepted
func (s *Server) HandleAcceptRecommendation(w http.ResponseWriter, r *http.Request) {
	userID := s.getUserID(w, r)

	var req struct {
		SpotID int64 `json:"spot_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	q := dbgen.New(s.DB)
	q.UpdateRecommendationAccepted(r.Context(), dbgen.UpdateRecommendationAcceptedParams{
		UserID: userID,
		SpotID: req.SpotID,
	})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// HandleGetHistory returns user's visit history
func (s *Server) HandleGetHistory(w http.ResponseWriter, r *http.Request) {
	userID := s.getUserID(w, r)

	limit := int64(20)
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.ParseInt(l, 10, 64); err == nil {
			limit = parsed
		}
	}

	q := dbgen.New(s.DB)
	history, err := q.GetUserVisitHistory(r.Context(), dbgen.GetUserVisitHistoryParams{
		UserID: userID,
		Limit:  limit,
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(history)
}
