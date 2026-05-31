package api

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dads/ui/internal/auth"
	"github.com/dads/ui/internal/db"
	"github.com/dads/ui/internal/imagecheck"
	"github.com/dads/ui/internal/shell"
	"github.com/dads/ui/internal/stats"
	"github.com/dads/ui/internal/workspace"
	"github.com/gorilla/websocket"
)

// ── JSON helpers ──────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

func readJSON(r *http.Request, v any) error {
	return json.NewDecoder(r.Body).Decode(v)
}

// ── Rate limiter (simple in-memory, per IP) ───────────────────────────────────

type rateLimiter struct {
	mu      sync.Mutex
	entries map[string]*rlEntry
}

type rlEntry struct {
	count     int
	resetAt   time.Time
}

var loginLimiter = &rateLimiter{entries: make(map[string]*rlEntry)}

func (rl *rateLimiter) allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	e, ok := rl.entries[ip]
	if !ok || time.Now().After(e.resetAt) {
		rl.entries[ip] = &rlEntry{count: 1, resetAt: time.Now().Add(15 * time.Minute)}
		return true
	}
	if e.count >= 5 {
		return false
	}
	e.count++
	return true
}

// ── Handlers ──────────────────────────────────────────────────────────────────

type Handler struct {
	auth          *auth.Service
	db            *db.DB
	bridge        *shell.Bridge
	workspacesDir string
	templatesDir  string
	imgCache      *imagecheck.Cache
}

func NewHandler(a *auth.Service, d *db.DB, b *shell.Bridge, workspacesDir, templatesDir string, imgCache *imagecheck.Cache) *Handler {
	return &Handler{auth: a, db: d, bridge: b, workspacesDir: workspacesDir, templatesDir: templatesDir, imgCache: imgCache}
}

// POST /api/setup  — first-run admin account creation
func (h *Handler) Setup(w http.ResponseWriter, r *http.Request) {
	required, err := h.db.IsSetupRequired()
	if err != nil || !required {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "setup already complete"})
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := readJSON(r, &body); err != nil || body.Username == "" || len(body.Password) < 8 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "username and password (min 8 chars) required"})
		return
	}
	if err := h.auth.CreateUser(body.Username, body.Password, "admin"); err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"status": "ok"})
}

// GET /api/setup/status  — is setup required?
func (h *Handler) SetupStatus(w http.ResponseWriter, r *http.Request) {
	required, err := h.db.IsSetupRequired()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"setup_required": required})
}

// POST /api/auth/login
func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	ip := r.RemoteAddr
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		ip = strings.Split(xff, ",")[0]
	}
	if !loginLimiter.allow(ip) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many attempts, try again in 15 minutes"})
		return
	}

	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	accessToken, refreshToken, err := h.auth.Login2(body.Username, body.Password)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid username or password"})
		return
	}

	setRefreshCookie(w, r, refreshToken)
	writeJSON(w, http.StatusOK, map[string]string{"token": accessToken})
}

func setRefreshCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "refresh_token",
		Value:    token,
		Path:     "/api/auth/refresh",
		HttpOnly: true,
		Secure:   r.TLS != nil,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   7 * 24 * 3600,
	})
}

// POST /api/auth/refresh — exchange refresh cookie for a new access token (rolling session)
func (h *Handler) Refresh(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie("refresh_token")
	if err != nil || cookie.Value == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no refresh token"})
		return
	}
	accessToken, newRefresh, err := h.auth.RefreshAccessToken(cookie.Value)
	if err != nil {
		// Clear invalid cookie
		http.SetCookie(w, &http.Cookie{Name: "refresh_token", Value: "", Path: "/api/auth/refresh", MaxAge: -1})
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "session expired, please log in again"})
		return
	}
	setRefreshCookie(w, r, newRefresh)
	writeJSON(w, http.StatusOK, map[string]string{"token": accessToken})
}

// POST /api/auth/logout
func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     "refresh_token",
		Value:    "",
		Path:     "/api/auth/refresh",
		HttpOnly: true,
		MaxAge:   -1,
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "logged out"})
}

// GET /api/templates  — lists available pre-built stack templates
func (h *Handler) ListTemplates(w http.ResponseWriter, r *http.Request) {
	templates, err := workspace.ListTemplates(h.templatesDir)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, templates)
}

// GET /api/templates/{name}  — returns full template (images + default env vars)
func (h *Handler) GetTemplate(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	images, envs, err := workspace.LoadTemplate(h.templatesDir, name)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"images":       images,
		"default_envs": envs,
	})
}

// WS POST /api/workspaces/create — creates workspace from wizard payload, streams bootstrap output
func (h *Handler) CreateWorkspace(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	// First message: { "token": "...", "workspace": { ...CreateRequest... } }
	var msg struct {
		Token string                  `json:"token"`
		Workspace workspace.CreateRequest `json:"workspace"`
	}
	if err := conn.ReadJSON(&msg); err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte("error: invalid request\n")) //nolint:errcheck
		return
	}

	claims, err := h.auth.ValidateToken(msg.Token)
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte("error: unauthorized\n")) //nolint:errcheck
		return
	}

	send := func(s string) { conn.WriteMessage(websocket.TextMessage, []byte(s)) } //nolint:errcheck

	send("Creating workspace " + msg.Workspace.Name + "...\n")

	// For pre-built templates, load images + default env vars and apply smart
	// secret generation BEFORE writing config.json. The generated values are
	// stored in TemplateEnvs and embedded into environments[env].env_vars inside
	// buildConfig() — that is the field env-gen.sh reads when generating .env
	// files during bootstrap. This matches what init_workspace.sh does via CLI.
	if msg.Workspace.Type == "image" {
		if msg.Workspace.Template != "" {
			// Pre-built template: load images + default env vars from template JSON
			templateImages, defaultEnvs, err := workspace.LoadTemplate(h.templatesDir, msg.Workspace.Template)
			if err != nil {
				send("\033[31mError loading template: " + err.Error() + "\033[0m\n")
				return
			}
			if len(msg.Workspace.Images) == 0 {
				msg.Workspace.Images = templateImages
			}
			if len(defaultEnvs) > 0 {
				msg.Workspace.TemplateEnvs = workspace.GenerateSmartDefaults(defaultEnvs)
			}
		} else if len(msg.Workspace.CustomEnvVars) > 0 {
			// Custom image stack: apply smart defaults to user-supplied env vars
			msg.Workspace.TemplateEnvs = workspace.GenerateSmartDefaults(msg.Workspace.CustomEnvVars)
		}
	}

	// Write config.json + run.sh (TemplateEnvs embedded in each env's env_vars block)
	if err := workspace.Create(h.workspacesDir, msg.Workspace); err != nil {
		send("\033[31mError: " + err.Error() + "\033[0m\n")
		return
	}
	send("\033[32m✓\033[0m config.json written\n")

	// Run bootstrap.sh per environment — reads env_vars from config.json
	// and writes the .env file via env-gen.sh (which now has the smart secrets).
	pr, pw := io.Pipe()
	go func() {
		buf := make([]byte, 4096)
		for {
			n, readErr := pr.Read(buf)
			if n > 0 {
				conn.WriteMessage(websocket.TextMessage, buf[:n]) //nolint:errcheck
			}
			if readErr != nil {
				break
			}
		}
	}()

	allOk := true
	for _, env := range msg.Workspace.Envs {
		if env.Name == "" {
			continue
		}
		send("\n\033[2mBootstrapping environment: " + env.Name + "\033[0m\n")
		if err := h.bridge.Bootstrap(msg.Workspace.Name, env.Name, pw, pw); err != nil {
			send("\033[31m✗ Bootstrap failed for " + env.Name + ": " + err.Error() + "\033[0m\n")
			allOk = false
		} else {
			send("\033[32m✓ " + env.Name + " bootstrapped\033[0m\n")
		}
	}
	pw.Close()

	if !allOk {
		send("\n\033[33mWorkspace created with errors — check output above.\033[0m\n")
	}

	// Audit log
	h.db.Exec( //nolint:errcheck
		"INSERT INTO audit_log (user_id, username, workspace, command, env) VALUES (?,?,?,?,?)",
		claims.UserID, claims.Username, msg.Workspace.Name, "create", "",
	)

	send("\n\033[32m✓ Workspace " + msg.Workspace.Name + " is ready!\033[0m\n")
}

// GET /api/events — SSE stream of Docker container events (auth via ?token= query param
// because the browser EventSource API does not support custom request headers).
func (h *Handler) StreamEvents(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if _, err := h.auth.ValidateToken(token); err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable nginx buffering if behind a proxy

	// Send a heartbeat comment every 25s to keep the connection alive through proxies
	ctx := r.Context()

	// Run docker events, scoped to container lifecycle events only
	cmd := exec.CommandContext(ctx, "docker", "events", //nolint:gosec
		"--format", "{{json .}}",
		"--filter", "type=container",
		"--filter", "event=start",
		"--filter", "event=die",
		"--filter", "event=stop",
		"--filter", "event=kill",
		"--filter", "event=pause",
		"--filter", "event=unpause",
		"--filter", "event=health_status",
	)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := cmd.Start(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer cmd.Process.Kill() //nolint:errcheck

	// Heartbeat ticker
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()

	// Send initial ping so the client knows it's connected
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	lines := make(chan string)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
		close(lines)
	}()

	for {
		select {
		case <-ctx.Done():
			return

		case <-ticker.C:
			fmt.Fprint(w, ": heartbeat\n\n")
			flusher.Flush()

		case line, ok := <-lines:
			if !ok {
				return
			}
			var event struct {
				Action string `json:"Action"`
				Actor  struct {
					Attributes map[string]string `json:"Attributes"`
				} `json:"Actor"`
			}
			if err := json.Unmarshal([]byte(line), &event); err != nil {
				continue
			}

			// com.docker.compose.project = "{workspace}_{env}" (set by compose-gen.sh)
			project := event.Actor.Attributes["com.docker.compose.project"]
			container := event.Actor.Attributes["name"]

			// Only forward events from managed compose stacks (project label present)
			if project == "" {
				continue
			}

			payload, _ := json.Marshal(map[string]string{
				"action":    event.Action,
				"project":   project,
				"container": container,
			})
			fmt.Fprintf(w, "event: container\ndata: %s\n\n", payload)
			flusher.Flush()
		}
	}
}

// GET /api/debug/paths — shows resolved paths and workspace dir contents (auth required)
func (h *Handler) DebugPaths(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(h.workspacesDir)
	var names []string
	if err == nil {
		for _, e := range entries {
			names = append(names, e.Name())
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"workspaces_dir":      h.workspacesDir,
		"workspaces_dir_entries": names,
		"workspaces_dir_err": func() string {
			if err != nil {
				return err.Error()
			}
			return ""
		}(),
	})
}

// GET /api/workspaces
func (h *Handler) ListWorkspaces(w http.ResponseWriter, r *http.Request) {
	workspaces, err := workspace.List(h.workspacesDir)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, workspaces)
}

// GET /api/workspaces/{name}/envs/{env}/compose  — returns docker-compose.yml content
func (h *Handler) GetCompose(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	env := r.PathValue("env")
	path := filepath.Join(h.workspacesDir, name, "envs", env, "docker-compose.yml")
	data, err := os.ReadFile(path)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "docker-compose.yml not found for env " + env})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"content": string(data)})
}

// PUT /api/workspaces/{name}/envs/{env}/compose  — writes docker-compose.yml
func (h *Handler) PutCompose(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	env := r.PathValue("env")
	var body struct {
		Content string `json:"content"`
	}
	if err := readJSON(r, &body); err != nil || body.Content == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "content required"})
		return
	}
	path := filepath.Join(h.workspacesDir, name, "envs", env, "docker-compose.yml")
	if err := os.WriteFile(path, []byte(body.Content), 0644); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	claims := auth.ClaimsFromContext(r.Context())
	if claims != nil {
		h.db.Exec("INSERT INTO audit_log (user_id, username, workspace, command, env) VALUES (?,?,?,?,?)", //nolint:errcheck
			claims.UserID, claims.Username, name, "edit-compose", env)
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// GET /api/workspaces/{name}/config  — returns full config.json
func (h *Handler) GetConfig(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	path := filepath.Join(h.workspacesDir, name, "config.json")
	data, err := os.ReadFile(path)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "config.json not found"})
		return
	}
	// Return raw JSON so the client can parse it directly
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(data) //nolint:errcheck
}

// PUT /api/workspaces/{name}/config  — writes config.json and optionally re-bootstraps
func (h *Handler) PutConfig(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var body struct {
		Content   string   `json:"content"`    // raw JSON string
		Bootstrap []string `json:"bootstrap"`  // env names to re-bootstrap after save
	}
	if err := readJSON(r, &body); err != nil || body.Content == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "content required"})
		return
	}
	// Validate it's parseable JSON before writing
	var check any
	if err := json.Unmarshal([]byte(body.Content), &check); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}
	path := filepath.Join(h.workspacesDir, name, "config.json")
	if err := os.WriteFile(path, []byte(body.Content), 0644); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	claims := auth.ClaimsFromContext(r.Context())
	if claims != nil {
		h.db.Exec("INSERT INTO audit_log (user_id, username, workspace, command, env) VALUES (?,?,?,?,?)", //nolint:errcheck
			claims.UserID, claims.Username, name, "edit-config", "")
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// GET /api/workspaces/{name}/activity  — recent audit log entries for this workspace
func (h *Handler) GetActivity(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	rows, err := h.db.Query(
		`SELECT username, command, env, created_at FROM audit_log
		 WHERE workspace = ? ORDER BY created_at DESC LIMIT 20`, name,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	type entry struct {
		Username  string `json:"username"`
		Command   string `json:"command"`
		Env       string `json:"env"`
		CreatedAt string `json:"created_at"`
	}
	var entries []entry
	for rows.Next() {
		var e entry
		rows.Scan(&e.Username, &e.Command, &e.Env, &e.CreatedAt) //nolint:errcheck
		entries = append(entries, e)
	}
	if entries == nil {
		entries = []entry{}
	}
	writeJSON(w, http.StatusOK, entries)
}

// GET /api/workspaces/{name}/envs/{env}/status  — runs docker ps and returns parsed output
func (h *Handler) GetEnvStatus(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	env := r.PathValue("env")

	var buf strings.Builder
	runErr := h.bridge.Run(shell.RunOptions{
		Workspace: name,
		Command:   "ps",
		Env:       env,
		Stdout:    &buf,
		Stderr:    &buf,
	})

	output := buf.String()
	status := parseComposeStatus(output, runErr)

	writeJSON(w, http.StatusOK, map[string]any{
		"status": status, // "running" | "partial" | "stopped" | "unknown"
		"output": output,
	})
}

// parseComposeStatus inspects docker compose ps output and returns a status string.
// docker compose ps table format has a STATUS column with values like:
//   Up 2 hours, Up (healthy), Exited (0), Exit 1, Created, Restarting
func parseComposeStatus(output string, runErr error) string {
	if runErr != nil && !strings.Contains(output, "NAME") {
		// Command failed completely — compose file may not exist yet
		return "unknown"
	}

	lines := strings.Split(output, "\n")
	total, running := 0, 0
	for _, line := range lines {
		// Skip header lines and empty lines
		if line == "" || strings.HasPrefix(line, "NAME") || strings.HasPrefix(line, "─") ||
			strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		// Any non-header line with content is a container row
		lower := strings.ToLower(line)
		if strings.Contains(lower, "up") || strings.Contains(lower, "running") ||
			strings.Contains(lower, "healthy") || strings.Contains(lower, "exit") ||
			strings.Contains(lower, "created") || strings.Contains(lower, "restarting") {
			total++
			if strings.Contains(lower, "up") || strings.Contains(lower, "running") ||
				strings.Contains(lower, "healthy") {
				running++
			}
		}
	}

	switch {
	case total == 0:
		return "stopped"
	case running == total:
		return "running"
	case running > 0:
		return "partial"
	default:
		return "stopped"
	}
}

// GET /api/workspaces/{name}
func (h *Handler) GetWorkspace(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	ws, err := workspace.Get(h.workspacesDir, name)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workspace not found"})
		return
	}
	writeJSON(w, http.StatusOK, ws)
}

// GET /api/workspaces/{name}/envs/{env}/vars  — returns env vars (masked by default, ?reveal=true for plaintext)
func (h *Handler) GetEnvVars(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	env := r.PathValue("env")
	reveal := r.URL.Query().Get("reveal") == "true"
	vars, err := workspace.EnvVars(h.workspacesDir, name, env, reveal)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, vars)
}

// PATCH /api/workspaces/{name}/envs/{env}/vars  — updates and/or deletes env vars
func (h *Handler) UpdateEnvVars(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	env := r.PathValue("env")
	var body struct {
		Updates map[string]string `json:"updates"`
		Deletes []string          `json:"deletes"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if err := workspace.UpdateEnvVars(h.workspacesDir, name, env, body.Updates, body.Deletes); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// Audit log
	claims := auth.ClaimsFromContext(r.Context())
	if claims != nil {
		h.db.Exec( //nolint:errcheck
			"INSERT INTO audit_log (user_id, username, workspace, command, env) VALUES (?,?,?,?,?)",
			claims.UserID, claims.Username, name, "env-update", env,
		)
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// DELETE /api/workspaces/{name} — permanently removes a workspace directory
func (h *Handler) DeleteWorkspace(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if name == "" || strings.ContainsAny(name, "/\\..") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workspace name"})
		return
	}

	wsPath := filepath.Join(h.workspacesDir, name)
	if _, err := os.Stat(wsPath); os.IsNotExist(err) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workspace not found"})
		return
	}

	if err := os.RemoveAll(wsPath); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to delete workspace: " + err.Error()})
		return
	}

	claims := auth.ClaimsFromContext(r.Context())
	if claims != nil {
		h.db.Exec( //nolint:errcheck
			"INSERT INTO audit_log (user_id, username, workspace, command, env) VALUES (?,?,?,?,?)",
			claims.UserID, claims.Username, name, "delete", "",
		)
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// POST /api/workspaces/{name}/action  — runs a run.sh command, streams output via WebSocket
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true }, // CORS handled at server level
}

type actionRequest struct {
	Command string   `json:"command"`
	Env     string   `json:"env"`
	Extra   []string `json:"extra"`
}

// WS /api/workspaces/{name}/action
func (h *Handler) RunAction(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	// Expect first message: { "command": "start", "env": "prod", "token": "<jwt>" }
	var req struct {
		actionRequest
		Token string `json:"token"`
	}
	if err := conn.ReadJSON(&req); err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte("error: invalid request\n")) //nolint:errcheck
		return
	}

	// Validate token from first WS message (no Authorization header over WS)
	claims, err := h.auth.ValidateToken(req.Token)
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte("error: unauthorized\n")) //nolint:errcheck
		return
	}

	// Audit log
	h.db.Exec( //nolint:errcheck
		"INSERT INTO audit_log (user_id, username, workspace, command, env) VALUES (?,?,?,?,?)",
		claims.UserID, claims.Username, name, req.Command, req.Env,
	)

	// Pipe stdout+stderr → WebSocket text frames
	// Both go through the same writer so output appears in order in the terminal.
	pr, pw := io.Pipe()
	go func() {
		buf := make([]byte, 4096)
		for {
			n, readErr := pr.Read(buf)
			if n > 0 {
				conn.WriteMessage(websocket.TextMessage, buf[:n]) //nolint:errcheck
			}
			if readErr != nil {
				break
			}
		}
	}()

	runErr := h.bridge.Run(shell.RunOptions{
		Workspace: name,
		Command:   req.Command,
		Env:       req.Env,
		Extra:     req.Extra,
		Stdout:    pw,
		Stderr:    pw, // merged: errors appear inline with output, not silently dropped
	})
	pw.Close()

	if runErr != nil {
		conn.WriteMessage(websocket.TextMessage, //nolint:errcheck
			[]byte("\n\033[31m✗ "+req.Command+" failed: "+runErr.Error()+"\033[0m\n"))
	} else {
		conn.WriteMessage(websocket.TextMessage, //nolint:errcheck
			[]byte("\n\033[32m✓ "+req.Command+" "+req.Env+" completed successfully.\033[0m\n"))
	}
}

// GET /api/stats — dashboard stats (docker info + host metrics + workspace summary)
func (h *Handler) GetStats(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, stats.Collect(h.workspacesDir))
}

// GET /api/workspaces/{name}/envs/{env}/containers — lists containers via docker compose ps
func (h *Handler) GetContainers(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	env  := r.PathValue("env")

	cfgPath := filepath.Join(h.workspacesDir, name, "config.json")
	data, err := os.ReadFile(cfgPath)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workspace not found"})
		return
	}
	var cfg struct {
		Project struct{ Name string } `json:"project"`
	}
	json.Unmarshal(data, &cfg) //nolint:errcheck
	project := cfg.Project.Name + "_" + env

	envDir := filepath.Join(h.workspacesDir, name, "envs", env)
	composePath := filepath.Join(envDir, "docker-compose.yml")

	out, err := exec.Command("docker", "compose",
		"-p", project,
		"-f", composePath,
		"ps", "--format", "json",
	).Output()

	type Container struct {
		Name    string `json:"Name"`
		Service string `json:"Service"`
		State   string `json:"State"`
		Status  string `json:"Status"`
	}

	var containers []Container
	if err == nil {
		// docker compose ps --format json outputs one JSON object per line (NDJSON)
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			if line == "" {
				continue
			}
			var c Container
			if json.Unmarshal([]byte(line), &c) == nil {
				containers = append(containers, c)
			}
		}
	}
	if containers == nil {
		containers = []Container{}
	}
	writeJSON(w, http.StatusOK, containers)
}

// GET /api/workspaces/{name}/envs/{env}/image-updates — returns cached image update check results
func (h *Handler) GetImageUpdates(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	env := r.PathValue("env")

	type response struct {
		Updates   []imagecheck.ServiceUpdate `json:"updates"`
		CheckedAt *time.Time                 `json:"checked_at,omitempty"`
		Pending   bool                       `json:"pending"` // true if no cache entry yet
	}

	entry, ok := h.imgCache.Get(name, env)
	if !ok {
		// Trigger an async check so the next poll will have results
		go func() {
			results := imagecheck.Check(h.workspacesDir, name, env)
			if results != nil {
				h.imgCache.Set(name, env, results)
			}
		}()
		writeJSON(w, http.StatusOK, response{Pending: true})
		return
	}
	writeJSON(w, http.StatusOK, response{Updates: entry.Results, CheckedAt: &entry.CheckedAt})
}

// POST /api/workspaces/{name}/export-template — export an image stack as a reusable prebuilt template
func (h *Handler) ExportTemplate(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")

	// Read config.json
	cfgPath := filepath.Join(h.workspacesDir, name, "config.json")
	cfgData, err := os.ReadFile(cfgPath)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workspace not found"})
		return
	}
	var cfg map[string]any
	if err := json.Unmarshal(cfgData, &cfg); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "invalid config.json"})
		return
	}

	projectType, _ := cfg["project"].(map[string]any)["type"].(string)
	if projectType != "image" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "only image stacks can be exported as templates"})
		return
	}

	var body struct {
		Label       string   `json:"label"`
		Description string   `json:"description"`
		Tags        []string `json:"tags"`
		Env         string   `json:"env"` // which env to read default_env_vars from
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if body.Label == "" {
		body.Label = name
	}
	if body.Env == "" {
		// pick first env
		if envs, ok := cfg["environments"].(map[string]any); ok {
			for k := range envs {
				body.Env = k
				break
			}
		}
	}

	// Collect default_env_vars from the specified environment's env_vars (masking secrets)
	defaultEnvVars := map[string]string{}
	if envs, ok := cfg["environments"].(map[string]any); ok {
		if envCfg, ok := envs[body.Env].(map[string]any); ok {
			if ev, ok := envCfg["env_vars"].(map[string]any); ok {
				for k, v := range ev {
					vs, _ := v.(string)
					// Replace generated secrets with CHANGE_ME placeholders
					ku := strings.ToUpper(k)
					isSecret := strings.Contains(ku, "PASSWORD") || strings.Contains(ku, "SECRET") ||
						strings.Contains(ku, "TOKEN") || strings.Contains(ku, "KEY") || strings.Contains(ku, "SALT")
					if isSecret {
						defaultEnvVars[k] = "CHANGE_ME"
					} else {
						defaultEnvVars[k] = vs
					}
				}
			}
		}
	}

	// Build template JSON
	tmpl := map[string]any{
		"name":             name,
		"label":            body.Label,
		"description":      body.Description,
		"tags":             body.Tags,
		"images":           cfg["images"],
		"default_env_vars": defaultEnvVars,
	}

	out, err := json.MarshalIndent(tmpl, "", "  ")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to marshal template"})
		return
	}

	// Write to templates/stacks/{name}.json
	templatesDir := filepath.Join(h.templatesDir, "stacks")
	if err := os.MkdirAll(templatesDir, 0755); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not create templates dir"})
		return
	}
	destPath := filepath.Join(templatesDir, name+".json")
	if err := os.WriteFile(destPath, out, 0644); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to write template file"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "template": name, "path": destPath})
}

// POST /api/auth/password — change current user's password
func (h *Handler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	claims := auth.ClaimsFromContext(r.Context())
	if claims == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var body struct {
		Current string `json:"current_password"`
		New     string `json:"new_password"`
	}
	if err := readJSON(r, &body); err != nil || body.Current == "" || len(body.New) < 8 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "current_password and new_password (min 8 chars) required"})
		return
	}
	if err := h.auth.ChangePassword(claims.UserID, body.Current, body.New); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "current password is incorrect"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// GET /api/backups — list all backup snapshots across all workspaces
func (h *Handler) ListBackups(w http.ResponseWriter, r *http.Request) {
	type BackupFile struct {
		Name string `json:"name"`
		Size int64  `json:"size"`
	}
	type BackupSnapshot struct {
		Workspace string       `json:"workspace"`
		Env       string       `json:"env"`
		Date      string       `json:"date"`
		SizeBytes int64        `json:"size_bytes"`
		Files     []BackupFile `json:"files"`
	}

	var results []BackupSnapshot

	wsEntries, err := os.ReadDir(h.workspacesDir)
	if err != nil {
		writeJSON(w, http.StatusOK, results)
		return
	}

	for _, wsEntry := range wsEntries {
		if !wsEntry.IsDir() {
			continue
		}
		wsName := wsEntry.Name()
		backupsRoot := filepath.Join(h.workspacesDir, wsName, "backups")

		envEntries, err := os.ReadDir(backupsRoot)
		if err != nil {
			continue // no backups dir
		}

		for _, envEntry := range envEntries {
			if !envEntry.IsDir() {
				continue
			}
			envName := envEntry.Name()
			snapshots, err := os.ReadDir(filepath.Join(backupsRoot, envName))
			if err != nil {
				continue
			}

			for _, snap := range snapshots {
				if !snap.IsDir() {
					continue
				}
				snapDir := filepath.Join(backupsRoot, envName, snap.Name())
				files, _ := os.ReadDir(snapDir)

				var bfiles []BackupFile
				var totalSize int64
				for _, f := range files {
					if f.IsDir() {
						continue
					}
					info, _ := f.Info()
					size := int64(0)
					if info != nil {
						size = info.Size()
					}
					totalSize += size
					bfiles = append(bfiles, BackupFile{Name: f.Name(), Size: size})
				}
				results = append(results, BackupSnapshot{
					Workspace: wsName,
					Env:       envName,
					Date:      snap.Name(),
					SizeBytes: totalSize,
					Files:     bfiles,
				})
			}
		}
	}

	// Sort newest first (snapshot dirs are named YYYY-MM-DD_HH-MM-SS so lexicographic desc works)
	for i, j := 0, len(results)-1; i < j; i, j = i+1, j-1 {
		results[i], results[j] = results[j], results[i]
	}

	writeJSON(w, http.StatusOK, results)
}

// WS /api/workspaces/{name}/envs/{env}/terminal — interactive shell into a container
func (h *Handler) Terminal(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	env  := r.PathValue("env")

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	// First message: {"token":"...","service":"app","cols":120,"rows":40}
	var init struct {
		Token   string `json:"token"`
		Service string `json:"service"`
		Cols    int    `json:"cols"`
		Rows    int    `json:"rows"`
	}
	if err := conn.ReadJSON(&init); err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte("\r\nerror: invalid handshake\r\n")) //nolint:errcheck
		return
	}

	if _, err := h.auth.ValidateToken(init.Token); err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte("\r\nerror: unauthorized\r\n")) //nolint:errcheck
		return
	}

	if init.Service == "" {
		conn.WriteMessage(websocket.TextMessage, []byte("\r\nerror: service name required\r\n")) //nolint:errcheck
		return
	}

	cols := init.Cols
	if cols <= 0 {
		cols = 220
	}
	rows := init.Rows
	if rows <= 0 {
		rows = 50
	}

	// Resolve compose project + compose file path
	cfgData, err := os.ReadFile(filepath.Join(h.workspacesDir, name, "config.json"))
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte("\r\nerror: workspace not found\r\n")) //nolint:errcheck
		return
	}
	var cfg struct{ Project struct{ Name string } `json:"project"` }
	json.Unmarshal(cfgData, &cfg) //nolint:errcheck
	prefix      := cfg.Project.Name + "_" + env
	composePath := filepath.Join(h.workspacesDir, name, "envs", env, "docker-compose.yml")

	// Get the container name via docker compose ps -q {service}
	qOut, err := exec.Command("docker", "compose",
		"-p", prefix, "-f", composePath,
		"ps", "-q", init.Service,
	).Output()
	containerID := strings.TrimSpace(string(qOut))
	if err != nil || containerID == "" {
		conn.WriteMessage(websocket.TextMessage, //nolint:errcheck
			[]byte(fmt.Sprintf("\r\nerror: container for service %q not found or not running\r\n", init.Service)))
		return
	}

	// Spawn an interactive shell. Set TERM + stty size so the shell behaves correctly.
	shell := fmt.Sprintf("stty cols %d rows %d 2>/dev/null; export TERM=xterm-256color; exec bash 2>/dev/null || exec sh", cols, rows)
	cmd := exec.Command("docker", "exec", "-i", containerID, "sh", "-c", shell) //nolint:gosec
	cmd.Env = os.Environ()

	stdin, err  := cmd.StdinPipe()
	stdout, err2 := cmd.StdoutPipe()
	stderr, err3 := cmd.StderrPipe()
	if err != nil || err2 != nil || err3 != nil {
		conn.WriteMessage(websocket.TextMessage, []byte("\r\nerror: could not create pipes\r\n")) //nolint:errcheck
		return
	}

	if err := cmd.Start(); err != nil {
		conn.WriteMessage(websocket.TextMessage, //nolint:errcheck
			[]byte("\r\nerror: "+err.Error()+"\r\n"))
		return
	}

	conn.WriteMessage(websocket.TextMessage, //nolint:errcheck
		[]byte(fmt.Sprintf("\r\n\x1b[32mConnected to %s/%s — type 'exit' to disconnect\x1b[0m\r\n\r\n", prefix, init.Service)))

	done := make(chan struct{})

	// stdout → WS
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				conn.WriteMessage(websocket.BinaryMessage, buf[:n]) //nolint:errcheck
			}
			if err != nil {
				break
			}
		}
		close(done)
	}()

	// stderr → WS
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stderr.Read(buf)
			if n > 0 {
				conn.WriteMessage(websocket.BinaryMessage, buf[:n]) //nolint:errcheck
			}
			if err != nil {
				break
			}
		}
	}()

	// WS → stdin  (client sends either raw bytes or JSON resize {"type":"resize","rows":r,"cols":c})
	go func() {
		for {
			mt, msg, err := conn.ReadMessage()
			if err != nil {
				break
			}
			if mt == websocket.TextMessage {
				// Check for resize control message
				var ctrl struct {
					Type string `json:"type"`
					Rows int    `json:"rows"`
					Cols int    `json:"cols"`
				}
				if json.Unmarshal(msg, &ctrl) == nil && ctrl.Type == "resize" {
					// Send stty resize command to the running shell
					fmt.Fprintf(stdin, "stty cols %d rows %d\n", ctrl.Cols, ctrl.Rows) //nolint:errcheck
					continue
				}
			}
			stdin.Write(msg) //nolint:errcheck
		}
		stdin.Close()
	}()

	// Wait for process to exit or connection to close
	<-done
	cmd.Wait() //nolint:errcheck
}
