package srv

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

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

// SetupDatabase initializes the database connection and runs migrations
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

// Serve starts the HTTP server with the configured routes
func (s *Server) Serve(addr string) error {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.HandleRoot)
	mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir(s.StaticDir))))

	// API routes
	mux.HandleFunc("GET /api/spots", s.HandleGetSpots)
	mux.HandleFunc("POST /api/spots", s.HandleCreateSpot)
	mux.HandleFunc("DELETE /api/spots/{id}", s.HandleDeleteSpot)
	mux.HandleFunc("DELETE /api/spots/clear", s.HandleClearAllSpots)
	mux.HandleFunc("GET /api/nearby", s.HandleGetNearbySpots)

	slog.Info("starting server", "addr", addr)
	return http.ListenAndServe(addr, mux)
}

// API Handlers
func (s *Server) HandleGetSpots(w http.ResponseWriter, r *http.Request) {
	q := dbgen.New(s.DB)
	category := r.URL.Query().Get("category")

	var spots []dbgen.Spot
	var err error

	if category != "" {
		spots, err = q.GetSpotsByCategory(r.Context(), category)
	} else {
		spots, err = q.GetAllSpots(r.Context())
	}

	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(spots)
}

func (s *Server) HandleCreateSpot(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        string  `json:"name"`
		Description string  `json:"description"`
		Category    string  `json:"category"`
		Latitude    float64 `json:"latitude"`
		Longitude   float64 `json:"longitude"`
		Address     string  `json:"address"`
		ImageURL    string  `json:"image_url"`
		Rating      float64 `json:"rating"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	userID := strings.TrimSpace(r.Header.Get("X-ExeDev-UserID"))

	q := dbgen.New(s.DB)
	spot, err := q.CreateSpot(r.Context(), dbgen.CreateSpotParams{
		Name:        req.Name,
		Description: &req.Description,
		Category:    req.Category,
		Latitude:    req.Latitude,
		Longitude:   req.Longitude,
		Address:     &req.Address,
		ImageUrl:    &req.ImageURL,
		Rating:      &req.Rating,
		CreatedBy:   &userID,
	})

	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(spot)
}

func (s *Server) HandleDeleteSpot(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	q := dbgen.New(s.DB)
	if err := q.DeleteSpot(r.Context(), id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) HandleClearAllSpots(w http.ResponseWriter, r *http.Request) {
	_, err := s.DB.ExecContext(r.Context(), "DELETE FROM spots")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) HandleGetNearbySpots(w http.ResponseWriter, r *http.Request) {
	latStr := r.URL.Query().Get("lat")
	lngStr := r.URL.Query().Get("lng")
	limitStr := r.URL.Query().Get("limit")

	lat, err := strconv.ParseFloat(latStr, 64)
	if err != nil {
		http.Error(w, "Invalid latitude", http.StatusBadRequest)
		return
	}

	lng, err := strconv.ParseFloat(lngStr, 64)
	if err != nil {
		http.Error(w, "Invalid longitude", http.StatusBadRequest)
		return
	}

	limit := int64(10)
	if limitStr != "" {
		if l, err := strconv.ParseInt(limitStr, 10, 64); err == nil {
			limit = l
		}
	}

	q := dbgen.New(s.DB)
	spots, err := q.GetNearbySpots(r.Context(), dbgen.GetNearbySpotsParams{
		RADIANS:   lat,
		RADIANS_2: lng,
		RADIANS_3: lat,
		Limit:     limit,
	})

	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(spots)
}
