package workspace

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

type Version struct {
	Major int `json:"major"`
	Minor int `json:"minor"`
	Patch int `json:"patch"`
	Build int `json:"build"`
}

type Project struct {
	Name     string  `json:"name"`
	Type     string  `json:"type"`
	Registry string  `json:"registry"`
	Version  Version `json:"version"`
}

type EnvConfig struct {
	Domain          string `json:"domain"`
	HTTPPort        any    `json:"http_port"`
	HTTPSPort       any    `json:"https_port"`
	Deployment      string `json:"deployment"`
	TraefikEnabled  bool   `json:"traefik_enabled"`
	SSLEnabled      bool   `json:"ssl_enabled"`
	FrontendEnabled bool   `json:"frontend_enabled"`
	Backend         string `json:"backend"`
	Frontend        string `json:"frontend"`
	Database        string `json:"database"`
}

type Config struct {
	Project      Project              `json:"project"`
	Environments map[string]EnvConfig `json:"environments"`
	Images       []ConfigImage        `json:"images"`
}

// ConfigImage is the read-only view of an image service as stored in config.json.
// Only the fields needed by the frontend (port links, names) are parsed here.
type ConfigImage struct {
	Name       string   `json:"name"`
	Image      string   `json:"image"`
	Tag        string   `json:"tag"`
	Port       int      `json:"port"`
	HostPort   string   `json:"host_port"`
	ExtraPorts []string `json:"extra_ports"`
	LinkPorts  []string `json:"link_ports"`
}

type Workspace struct {
	Name   string    `json:"name"`
	Path   string    `json:"path"`
	Config Config    `json:"config"`
	Envs   []string  `json:"envs"`
}

// List discovers all workspaces under the given root directory.
func List(workspacesDir string) ([]Workspace, error) {
	entries, err := os.ReadDir(workspacesDir)
	if err != nil {
		return []Workspace{}, fmt.Errorf("read workspaces dir: %w", err)
	}

	workspaces := []Workspace{} // never nil — encodes as [] not null
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		ws, err := load(workspacesDir, e.Name())
		if err != nil {
			fmt.Fprintf(os.Stderr, "workspace: skipping %q: %v\n", e.Name(), err)
			continue
		}
		workspaces = append(workspaces, ws)
	}
	return workspaces, nil
}

// Get returns a single workspace by name.
func Get(workspacesDir, name string) (Workspace, error) {
	return load(workspacesDir, name)
}

func load(workspacesDir, name string) (Workspace, error) {
	wsPath := filepath.Join(workspacesDir, name)
	cfgPath := filepath.Join(wsPath, "config.json")

	data, err := os.ReadFile(cfgPath)
	if err != nil {
		return Workspace{}, fmt.Errorf("read config.json: %w", err)
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Workspace{}, fmt.Errorf("parse config.json: %w", err)
	}

	// Collect environment names: union of envs/ subdirectories on disk AND
	// keys in config.json environments. This ensures a newly-added environment
	// (saved to config.json but not yet bootstrapped/Init'd) is visible on
	// the workspace page immediately after save.
	envSet := map[string]bool{}
	envsDir := filepath.Join(wsPath, "envs")
	if entries, err := os.ReadDir(envsDir); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				envSet[e.Name()] = true
			}
		}
	}
	for envName := range cfg.Environments {
		envSet[envName] = true
	}
	var envs []string
	for k := range envSet {
		envs = append(envs, k)
	}

	return Workspace{
		Name:   name,
		Path:   wsPath,
		Config: cfg,
		Envs:   envs,
	}, nil
}

// EnvVars reads .env file for a workspace+environment.
// When reveal is false, secret-looking values are masked as "••••••••".
func EnvVars(workspacesDir, name, env string, reveal bool) (map[string]string, error) {
	envFile := filepath.Join(workspacesDir, name, "envs", env, ".env")
	data, err := os.ReadFile(envFile)
	if err != nil {
		return nil, fmt.Errorf("read .env: %w", err)
	}

	result := make(map[string]string)
	for _, line := range splitLines(string(data)) {
		if len(line) == 0 || line[0] == '#' {
			continue
		}
		k, v, ok := splitKeyValue(line)
		if !ok {
			continue
		}
		if reveal {
			result[k] = v
		} else {
			result[k] = "••••••••"
		}
	}
	return result, nil
}

// UpdateEnvVars writes changed key=value pairs into the .env file and removes
// any keys listed in deletes. Other lines are preserved unchanged.
func UpdateEnvVars(workspacesDir, name, env string, updates map[string]string, deletes []string) error {
	envFile := filepath.Join(workspacesDir, name, "envs", env, ".env")
	data, err := os.ReadFile(envFile)
	if err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		// .env doesn't exist yet (new environment not yet bootstrapped).
		// Create the directory and an empty file so updates can be applied.
		if mkErr := os.MkdirAll(filepath.Dir(envFile), 0755); mkErr != nil {
			return mkErr
		}
		data = []byte{}
	}

	deleteSet := make(map[string]bool, len(deletes))
	for _, k := range deletes {
		deleteSet[k] = true
	}

	lines := splitLines(string(data))
	out := make([]string, 0, len(lines))
	written := make(map[string]bool)

	for _, line := range lines {
		if len(line) == 0 || line[0] == '#' {
			out = append(out, line)
			continue
		}
		k, _, ok := splitKeyValue(line)
		if ok {
			if deleteSet[k] {
				continue // drop the line
			}
			if newVal, changed := updates[k]; changed {
				out = append(out, k+"="+newVal)
				written[k] = true
				continue
			}
		}
		out = append(out, line)
	}

	// Append any new keys not already in the file
	for k, v := range updates {
		if !written[k] && !deleteSet[k] {
			out = append(out, k+"="+v)
		}
	}

	content := ""
	for _, l := range out {
		content += l + "\n"
	}
	return os.WriteFile(envFile, []byte(content), 0600)
}

func splitLines(s string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			lines = append(lines, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}

func splitKeyValue(line string) (string, string, bool) {
	for i := 0; i < len(line); i++ {
		if line[i] == '=' {
			return line[:i], line[i+1:], true
		}
	}
	return "", "", false
}
