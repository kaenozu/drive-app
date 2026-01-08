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
	"strings"
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
	mux.HandleFunc("POST /api/route", s.HandleGenerateRoute)
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


// RouteRequest is the request for route generation
type RouteRequest struct {
	Lat               float64 `json:"lat"`
	Lng               float64 `json:"lng"`
	DepartureTime     string  `json:"departure_time"`     // "HH:MM"
	ReturnTime        string  `json:"return_time"`        // "HH:MM" optional
	IncludeRestaurant bool    `json:"include_restaurant"`
	IncludeRest       bool    `json:"include_rest"`
}

// RouteStop represents a stop in the route
type RouteStop struct {
	ID               int64   `json:"id"`
	Name             string  `json:"name"`
	Description      string  `json:"description,omitempty"`
	Category         string  `json:"category"`
	Lat              float64 `json:"lat"`
	Lng              float64 `json:"lng"`
	DistanceFromPrev float64 `json:"distance_from_prev,omitempty"`
	ArrivalTime      string  `json:"arrival_time,omitempty"`
	StayDuration     int     `json:"stay_duration,omitempty"` // minutes
}

// RouteResponse is the response containing the full route
type RouteResponse struct {
	Stops           []RouteStop `json:"stops"`
	TotalDistanceKm float64     `json:"total_distance_km"`
	TotalTimeMin    float64     `json:"total_time_min"`
	DepartureTime   string      `json:"departure_time"`
	EstimatedReturn string      `json:"estimated_return"`
	Message         string      `json:"message"`
}

// HandleGenerateRoute creates a drive route with multiple stops
func (s *Server) HandleGenerateRoute(w http.ResponseWriter, r *http.Request) {
	userID := s.getUserID(w, r)

	var req RouteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.DepartureTime == "" {
		req.DepartureTime = "10:00"
	}

	// Calculate available time
	availableHours := 8.0 // default: 8 hours
	if req.ReturnTime != "" {
		depMin := parseTimeToMinutes(req.DepartureTime)
		retMin := parseTimeToMinutes(req.ReturnTime)
		if retMin > depMin {
			availableHours = float64(retMin-depMin) / 60
		}
	}

	// Max distance based on available time (avg 40km/h, half time for stops)
	maxDistanceKm := availableHours * 40 * 0.5

	q := dbgen.New(s.DB)
	_, _ = q.GetOrCreateUser(r.Context(), userID)

	// Get recent route hashes to avoid repetition
	recentHashes, _ := q.GetRecentRouteHashes(r.Context(), userID)
	recentHashSet := make(map[string]bool)
	for _, h := range recentHashes {
		recentHashSet[h] = true
	}

	// Get all spots
	allSpots, err := q.GetAllSpots(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Shuffle spots to add randomness
	shuffleSpots(allSpots)

	// Filter by distance
	maxOneWayDist := maxDistanceKm / 3

	var driveSpots, restaurants, restSpots []dbgen.Spot
	depMinutes := parseTimeToMinutes(req.DepartureTime)

	for _, spot := range allSpots {
		dist := haversine(req.Lat, req.Lng, spot.Latitude, spot.Longitude)
		if dist > maxOneWayDist {
			continue
		}

		switch spot.Category {
		case "drive":
			driveSpots = append(driveSpots, spot)
		case "restaurant":
			if req.IncludeRestaurant {
				restaurants = append(restaurants, spot)
			}
		case "rest":
			if req.IncludeRest {
				restSpots = append(restSpots, spot)
			}
		}
	}

	if len(driveSpots) == 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(RouteResponse{
			Stops:   []RouteStop{},
			Message: "条件に合うドライブスポットが見つかりませんでした。",
		})
		return
	}

	// Use AI to build optimal route
	route, message := s.buildRouteWithAI(req.Lat, req.Lng, driveSpots, restaurants, restSpots, req, depMinutes, availableHours, recentHashSet)

	// Save route hash to history
	if len(route.Stops) > 2 {
		var ids []int64
		for _, stop := range route.Stops {
			if stop.ID > 0 {
				ids = append(ids, stop.ID)
			}
		}
		if len(ids) > 0 {
			hash := computeRouteHash(ids)
			idsJSON, _ := json.Marshal(ids)
			q.AddRouteHistory(r.Context(), dbgen.AddRouteHistoryParams{
				UserID:    userID,
				RouteHash: hash,
				SpotIds:   string(idsJSON),
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(RouteResponse{
		Stops:           route.Stops,
		TotalDistanceKm: route.TotalDistanceKm,
		TotalTimeMin:    route.TotalTimeMin,
		DepartureTime:   req.DepartureTime,
		EstimatedReturn: route.EstimatedReturn,
		Message:         message,
	})
}

func parseTimeToMinutes(t string) int {
	parts := strings.Split(t, ":")
	if len(parts) != 2 {
		return 0
	}
	h, _ := strconv.Atoi(parts[0])
	m, _ := strconv.Atoi(parts[1])
	return h*60 + m
}

func minutesToTime(m int) string {
	h := m / 60
	min := m % 60
	return fmt.Sprintf("%02d:%02d", h, min)
}

func shuffleSpots(spots []dbgen.Spot) {
	for i := len(spots) - 1; i > 0; i-- {
		j := int(time.Now().UnixNano()) % (i + 1)
		spots[i], spots[j] = spots[j], spots[i]
	}
}

func computeRouteHash(ids []int64) string {
	// Sort and create hash
	sorted := make([]int64, len(ids))
	copy(sorted, ids)
	for i := 0; i < len(sorted)-1; i++ {
		for j := i + 1; j < len(sorted); j++ {
			if sorted[i] > sorted[j] {
				sorted[i], sorted[j] = sorted[j], sorted[i]
			}
		}
	}
	return fmt.Sprintf("%v", sorted)
}

type builtRoute struct {
	Stops           []RouteStop
	TotalDistanceKm float64
	TotalTimeMin    float64
	EstimatedReturn string
}

func (s *Server) buildRouteWithAI(startLat, startLng float64, driveSpots, restaurants, restSpots []dbgen.Spot, req RouteRequest, depMinutes int, availableHours float64, recentHashes map[string]bool) (builtRoute, string) {
	// Build candidate list for AI with randomness indicator
	randomSeed := time.Now().UnixNano() % 1000
	
	var candidateList string
	candidateList += "ドライブスポット:\n"
	for i, spot := range driveSpots {
		if i >= 20 {
			break
		}
		dist := haversine(startLat, startLng, spot.Latitude, spot.Longitude)
		desc := ""
		if spot.Description != nil {
			desc = *spot.Description
		}
		candidateList += fmt.Sprintf("  [ID:%d] %s (%.1fkm) - %s\n", spot.ID, spot.Name, dist, desc)
	}

	if len(restaurants) > 0 {
		candidateList += "\n食事スポット:\n"
		for i, spot := range restaurants {
			if i >= 15 {
				break
			}
			dist := haversine(startLat, startLng, spot.Latitude, spot.Longitude)
			desc := ""
			if spot.Description != nil {
				desc = *spot.Description
			}
			candidateList += fmt.Sprintf("  [ID:%d] %s (%.1fkm) - %s\n", spot.ID, spot.Name, dist, desc)
		}
	}

	if len(restSpots) > 0 {
		candidateList += "\n休憩スポット:\n"
		for i, spot := range restSpots {
			if i >= 15 {
				break
			}
			dist := haversine(startLat, startLng, spot.Latitude, spot.Longitude)
			desc := ""
			if spot.Description != nil {
				desc = *spot.Description
			}
			candidateList += fmt.Sprintf("  [ID:%d] %s (%.1fkm) - %s\n", spot.ID, spot.Name, dist, desc)
		}
	}

	// Build list of recent routes to avoid
	var avoidList string
	if len(recentHashes) > 0 {
		avoidList = "\n※最近提案したルートと同じ組み合わせは避けてください。\n"
	}

	prompt := fmt.Sprintf(`あなたはドライブルートのプランナーAIです。
現在地から出発して、いくつかのスポットを経由して現在地に戻る周遊ドライブルートを作成してください。

【基本情報】
現在地: 緯度%.4f, 経度%.4f
出発時刻: %s
使える時間: 約%.1f時間
ランダムシード: %d（毎回異なるルートを提案するため）
%s
【候補スポット】
%s
【要件】
1. メインの目的地（ドライブスポット）を1〜3箇所選ぶ
2. 食事スポットがあれば、昼食時間帯（11:30-13:30頃）に1箇所組み込む
3. 休憩スポットがあれば適宜組み込む（長距離の場合）
4. 効率的で無駄のないルート順序にする
5. 出発地と帰着地は同じ（現在地）
6. 各スポットの滞在時間目安: ドライブスポット30-60分、食事45-60分、休憩15-30分
7. **前回と違うルートを提案してください**

【出力形式】JSON形式で回答:
{
  "route_ids": [スポットIDを訪問順に配列。出発地・帰着地は含めない],
  "stay_durations": [各スポットの滞在時間（分）を対応する順番で配列],
  "message": "このルートの特徴や楽しみ方を2文程度で"
}
`, startLat, startLng, req.DepartureTime, availableHours, randomSeed, avoidList, candidateList)

	// Call Claude API
	routeIDs, stayDurations, message := callClaudeAPIForRouteV2(prompt)

	// Build spot map
	spotMap := make(map[int64]dbgen.Spot)
	for _, sp := range driveSpots {
		spotMap[sp.ID] = sp
	}
	for _, sp := range restaurants {
		spotMap[sp.ID] = sp
	}
	for _, sp := range restSpots {
		spotMap[sp.ID] = sp
	}

	// Build route with times
	var stops []RouteStop
	var totalDist float64
	currentTime := depMinutes

	// Start point
	stops = append(stops, RouteStop{
		ID:          0,
		Name:        "現在地",
		Category:    "start",
		Lat:         startLat,
		Lng:         startLng,
		ArrivalTime: minutesToTime(currentTime),
	})

	prevLat, prevLng := startLat, startLng

	for i, id := range routeIDs {
		spot, ok := spotMap[id]
		if !ok {
			continue
		}
		dist := haversine(prevLat, prevLng, spot.Latitude, spot.Longitude)
		totalDist += dist

		// Travel time (40km/h average)
		travelMin := int(dist / 40 * 60)
		currentTime += travelMin

		desc := ""
		if spot.Description != nil {
			desc = *spot.Description
		}

		// Get stay duration
		stayMin := 30 // default
		if i < len(stayDurations) {
			stayMin = stayDurations[i]
		} else {
			switch spot.Category {
			case "restaurant":
				stayMin = 50
			case "rest":
				stayMin = 20
			case "drive":
				stayMin = 40
			}
		}

		stops = append(stops, RouteStop{
			ID:               spot.ID,
			Name:             spot.Name,
			Description:      desc,
			Category:         spot.Category,
			Lat:              spot.Latitude,
			Lng:              spot.Longitude,
			DistanceFromPrev: math.Round(dist*10) / 10,
			ArrivalTime:      minutesToTime(currentTime),
			StayDuration:     stayMin,
		})

		currentTime += stayMin
		prevLat, prevLng = spot.Latitude, spot.Longitude
	}

	// Return to start
	returnDist := haversine(prevLat, prevLng, startLat, startLng)
	totalDist += returnDist
	returnTravelMin := int(returnDist / 40 * 60)
	currentTime += returnTravelMin

	stops = append(stops, RouteStop{
		ID:               0,
		Name:             "現在地",
		Category:         "end",
		Lat:              startLat,
		Lng:              startLng,
		DistanceFromPrev: math.Round(returnDist*10) / 10,
		ArrivalTime:      minutesToTime(currentTime),
	})

	totalTimeMin := float64(currentTime - depMinutes)

	// Fallback if AI didn't return valid route
	if len(stops) <= 2 && len(driveSpots) > 0 {
		// Pick a random drive spot
		idx := int(time.Now().UnixNano()) % len(driveSpots)
		spot := driveSpots[idx]
		dist := haversine(startLat, startLng, spot.Latitude, spot.Longitude)

		desc := ""
		if spot.Description != nil {
			desc = *spot.Description
		}

		travelMin := int(dist / 40 * 60)
		arriveTime := depMinutes + travelMin
		stayMin := 40
		returnTime := arriveTime + stayMin + travelMin

		stops = []RouteStop{
			{ID: 0, Name: "現在地", Category: "start", Lat: startLat, Lng: startLng, ArrivalTime: minutesToTime(depMinutes)},
			{ID: spot.ID, Name: spot.Name, Description: desc, Category: spot.Category, Lat: spot.Latitude, Lng: spot.Longitude, DistanceFromPrev: math.Round(dist*10) / 10, ArrivalTime: minutesToTime(arriveTime), StayDuration: stayMin},
			{ID: 0, Name: "現在地", Category: "end", Lat: startLat, Lng: startLng, DistanceFromPrev: math.Round(dist*10) / 10, ArrivalTime: minutesToTime(returnTime)},
		}
		totalDist = dist * 2
		totalTimeMin = float64(returnTime - depMinutes)
		message = "おすすめのドライブスポットを選びました。"
		currentTime = returnTime
	}

	return builtRoute{
		Stops:           stops,
		TotalDistanceKm: math.Round(totalDist*10) / 10,
		TotalTimeMin:    math.Round(totalTimeMin),
		EstimatedReturn: minutesToTime(currentTime),
	}, message
}

func callClaudeAPIForRouteV2(prompt string) ([]int64, []int, string) {
	reqBody := map[string]interface{}{
		"model":      "claude-sonnet-4-20250514",
		"max_tokens": 600,
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
		return nil, nil, ""
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
		return nil, nil, ""
	}

	if len(result.Content) == 0 {
		return nil, nil, ""
	}

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
		return nil, nil, ""
	}

	var aiResp struct {
		RouteIDs      []int64 `json:"route_ids"`
		StayDurations []int   `json:"stay_durations"`
		Message       string  `json:"message"`
	}
	if err := json.Unmarshal([]byte(text[start:end]), &aiResp); err != nil {
		slog.Error("Parse AI route JSON", "error", err, "text", text)
		return nil, nil, ""
	}

	return aiResp.RouteIDs, aiResp.StayDurations, aiResp.Message
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
