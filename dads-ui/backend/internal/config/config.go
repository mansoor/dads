package config

import (
	"os"
	"path/filepath"
)

type Config struct {
	// Server
	ListenAddr string
	// Paths
	ToolkitRoot    string
	WorkspacesDir  string
	DataDir        string // for SQLite DB and other persistent data
	// Auth
	JWTSecret      string
	JWTExpiry      int // minutes
	RefreshExpiry  int // days
}

func Load() *Config {
	toolkit := getenv("TOOLKIT_ROOT", "/toolkit")
	return &Config{
		ListenAddr:    getenv("LISTEN_ADDR", ":8080"),
		ToolkitRoot:   toolkit,
		WorkspacesDir: getenv("WORKSPACES_DIR", filepath.Join(toolkit, "workspaces")),
		DataDir:       getenv("DATA_DIR", "/data"),
		JWTSecret:     getenv("JWT_SECRET", "change-me-in-production"),
		JWTExpiry:     15,
		RefreshExpiry: 7,
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
