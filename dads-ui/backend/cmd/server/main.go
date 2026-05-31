package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/dads/ui/api"
	"github.com/dads/ui/internal/auth"
	"github.com/dads/ui/internal/config"
	"github.com/dads/ui/internal/db"
	"github.com/dads/ui/internal/imagecheck"
	"github.com/dads/ui/internal/shell"
)

//go:embed all:dist
var frontendFS embed.FS

func main() {
	cfg := config.Load()

	// ── Database ──────────────────────────────────────────────────────────────
	database, err := db.Open(cfg.DataDir)
	if err != nil {
		log.Fatalf("db: %v", err)
	}

	// ── Services ──────────────────────────────────────────────────────────────
	authSvc := auth.NewService(database, cfg.JWTSecret, cfg.JWTExpiry)
	bridge := shell.NewBridge(cfg.WorkspacesDir, cfg.ToolkitRoot)

	// Sync run.sh to all existing workspaces from the canonical template.
	// This ensures any new commands added to run.sh.template propagate on restart.
	syncRunSh(cfg.ToolkitRoot, cfg.WorkspacesDir)

	// Image update cache — populated by hourly background checker
	imgCache := imagecheck.NewCache()
	imagecheck.RunBackground(imgCache, cfg.WorkspacesDir)

	handler := api.NewHandler(authSvc, database, bridge, cfg.WorkspacesDir, cfg.TemplatesDir, imgCache)

	// ── Router ────────────────────────────────────────────────────────────────
	mux := http.NewServeMux()

	// Setup / auth (no JWT required)
	mux.HandleFunc("GET /api/setup/status", handler.SetupStatus)
	mux.HandleFunc("POST /api/setup", handler.Setup)
	mux.HandleFunc("POST /api/auth/login", handler.Login)
	mux.HandleFunc("POST /api/auth/logout", handler.Logout)
	mux.Handle("POST /api/auth/password", authSvc.Middleware(http.HandlerFunc(handler.ChangePassword)))

	// Protected API routes (JWT middleware applied per-route group)
	protected := authSvc.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "GET" && r.URL.Path == "/api/templates":
			handler.ListTemplates(w, r)
		case r.Method == "GET" && matchPrefix(r.URL.Path, "/api/templates/"):
			r.SetPathValue("name", pathSegment(r.URL.Path, 2))
			handler.GetTemplate(w, r)
		case r.Method == "GET" && r.URL.Path == "/api/debug/paths":
			handler.DebugPaths(w, r)
		case r.Method == "GET" && r.URL.Path == "/api/stats":
			handler.GetStats(w, r)
		case r.Method == "GET" && r.URL.Path == "/api/backups":
			handler.ListBackups(w, r)
		case r.Method == "GET" && r.URL.Path == "/api/workspaces":
			handler.ListWorkspaces(w, r)
		case r.Method == "GET" && matchPrefix(r.URL.Path, "/api/workspaces/") && !hasSuffix(r.URL.Path, "/action"):
			// parts[2]=name, parts[3]=sub (activity|envs), parts[4]=env, parts[5]=subsub (status|vars)
			name := pathSegment(r.URL.Path, 2)
			sub := pathSegment(r.URL.Path, 3)  // activity | envs | config
			env := pathSegment(r.URL.Path, 4)  // env name (when sub=envs)
			subsub := pathSegment(r.URL.Path, 5) // vars | status | compose
			r.SetPathValue("name", name)
			r.SetPathValue("env", env)
			switch {
			case sub == "activity":
				handler.GetActivity(w, r)
			case sub == "config":
				handler.GetConfig(w, r)
			case sub == "envs" && subsub == "status":
				handler.GetEnvStatus(w, r)
			case sub == "envs" && subsub == "vars":
				handler.GetEnvVars(w, r)
			case sub == "envs" && subsub == "compose":
				handler.GetCompose(w, r)
			case sub == "envs" && subsub == "image-updates":
				handler.GetImageUpdates(w, r)
			default:
				handler.GetWorkspace(w, r)
			}
		case r.Method == "POST" && matchPrefix(r.URL.Path, "/api/workspaces/") && hasSuffix(r.URL.Path, "/export-template"):
			r.SetPathValue("name", pathSegment(r.URL.Path, 2))
			handler.ExportTemplate(w, r)
		case r.Method == "PUT" && matchPrefix(r.URL.Path, "/api/workspaces/"):
			name := pathSegment(r.URL.Path, 2)
			sub := pathSegment(r.URL.Path, 3)
			env := pathSegment(r.URL.Path, 4)
			subsub := pathSegment(r.URL.Path, 5)
			r.SetPathValue("name", name)
			r.SetPathValue("env", env)
			switch {
			case sub == "config":
				handler.PutConfig(w, r)
			case sub == "envs" && subsub == "compose":
				handler.PutCompose(w, r)
			default:
				http.NotFound(w, r)
			}
		case r.Method == "PATCH" && matchPrefix(r.URL.Path, "/api/workspaces/"):
			name := pathSegment(r.URL.Path, 2)
			env := pathSegment(r.URL.Path, 4)
			r.SetPathValue("name", name)
			r.SetPathValue("env", env)
			handler.UpdateEnvVars(w, r)
		default:
			http.NotFound(w, r)
		}
	}))

	mux.Handle("/api/debug/", protected)
	mux.Handle("/api/workspaces", protected)
	mux.Handle("/api/workspaces/", protected)

	// SSE: Docker container events (auth via ?token= query param)
	mux.HandleFunc("/api/events", handler.StreamEvents)

	// WebSocket: create workspace (streams bootstrap output)
	mux.HandleFunc("/api/workspaces/create", handler.CreateWorkspace)

	// Backups (cross-workspace listing)
	mux.Handle("/api/backups", protected)

	// Templates
	mux.Handle("/api/templates", protected)
	mux.Handle("/api/templates/", protected)

	// WebSocket action endpoint — auth via token in first WS message
	mux.HandleFunc("/api/workspaces/{name}/action", func(w http.ResponseWriter, r *http.Request) {
		handler.RunAction(w, r)
	})

	// ── Static frontend (SPA) ────────────────────────────────────────────────
	distFS, err := fs.Sub(frontendFS, "dist")
	if err != nil {
		log.Fatalf("embed fs: %v", err)
	}
	spa := spaHandler{fs: http.FS(distFS)}
	mux.Handle("/", spa)

	// ── Start server ──────────────────────────────────────────────────────────
	log.Printf("DADS UI listening on %s", cfg.ListenAddr)
	log.Printf("Toolkit root : %s", cfg.ToolkitRoot)
	log.Printf("Workspaces   : %s", cfg.WorkspacesDir)

	if err := http.ListenAndServe(cfg.ListenAddr, mux); err != nil {
		log.Fatalf("server: %v", err)
	}
}

// spaHandler serves the React SPA: known assets are served directly;
// everything else falls back to index.html for client-side routing.
type spaHandler struct{ fs http.FileSystem }

func (s spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f, err := s.fs.Open(r.URL.Path)
	if err != nil {
		// Serve index.html for any unknown path (client-side routing)
		r.URL.Path = "/"
		http.FileServer(s.fs).ServeHTTP(w, r)
		return
	}
	f.Close()
	http.FileServer(s.fs).ServeHTTP(w, r)
}

// ── URL helpers ───────────────────────────────────────────────────────────────

func matchPrefix(path, prefix string) bool {
	return len(path) >= len(prefix) && path[:len(prefix)] == prefix
}

func hasSuffix(path, suffix string) bool {
	return len(path) >= len(suffix) && path[len(path)-len(suffix):] == suffix
}

func pathSegment(path string, n int) string {
	parts := splitPath(path)
	if n < len(parts) {
		return parts[n]
	}
	return ""
}

// syncRunSh copies scripts/run.sh.template into every workspace as run.sh.
// Called on startup so command additions in the template propagate automatically.
func syncRunSh(toolkitRoot, workspacesDir string) {
	tmpl := filepath.Join(toolkitRoot, "scripts", "run.sh.template")
	src, err := os.ReadFile(tmpl)
	if err != nil {
		log.Printf("syncRunSh: template not found at %s: %v", tmpl, err)
		return
	}
	entries, err := os.ReadDir(workspacesDir)
	if err != nil {
		return
	}
	updated := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dest := filepath.Join(workspacesDir, e.Name(), "run.sh")
		if err := os.WriteFile(dest, src, 0755); err != nil {
			log.Printf("syncRunSh: failed to write %s: %v", dest, err)
		} else {
			updated++
		}
	}
	log.Printf("syncRunSh: updated run.sh in %d workspace(s)", updated)
}

func splitPath(path string) []string {
	var parts []string
	cur := ""
	for _, c := range path {
		if c == '/' {
			if cur != "" {
				parts = append(parts, cur)
				cur = ""
			}
		} else {
			cur += string(c)
		}
	}
	if cur != "" {
		parts = append(parts, cur)
	}
	return parts
}
