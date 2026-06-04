package config

import (
	"os"
	"path/filepath"
)

type Config struct {
	// Server
	ListenAddr string
	// Paths
	ToolkitRoot   string
	WorkspacesDir string
	TemplatesDir  string
	DataDir       string
	// Auth
	JWTSecret     string
	JWTExpiry     int
	RefreshExpiry int
	// Notifications
	AppriseURL string // base URL of the Apprise API sidecar (Phase 6b)
}

func Load() *Config {
	toolkit := getenv("TOOLKIT_ROOT", "/toolkit")
	return &Config{
		ListenAddr:    getenv("LISTEN_ADDR", ":8080"),
		ToolkitRoot:   toolkit,
		WorkspacesDir: getenv("WORKSPACES_DIR", filepath.Join(toolkit, "workspaces")),
		TemplatesDir:  getenv("TEMPLATES_DIR", filepath.Join(toolkit, "templates")),
		DataDir:       getenv("DATA_DIR", "/data"),
		JWTSecret:     getenv("JWT_SECRET", "change-me-in-production"),
		JWTExpiry:     15,
		RefreshExpiry: 7,
		AppriseURL:    getenv("APPRISE_URL", "http://apprise:8000"),
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
