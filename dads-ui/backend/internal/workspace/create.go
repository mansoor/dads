package workspace

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

var validName = regexp.MustCompile(`^[a-z0-9][a-z0-9\-]{0,62}$`)

// CreateRequest is the payload sent from the wizard.
type CreateRequest struct {
	Name         string            `json:"name"`
	Registry     string            `json:"registry"`
	Type         string            `json:"type"`         // "image" or "custom"
	Template     string            `json:"template"`     // pre-built template name (image type)
	Images       []ImageDef        `json:"images"`       // populated from template or manual entry
	Backend      string            `json:"backend"`      // laravel | nodejs (custom type)
	Frontend     string            `json:"frontend"`     // none | nextjs | react (custom type)
	Database     string            `json:"database"`     // postgres | mysql | none (custom type)
	Redis        bool              `json:"redis"`
	Garage       bool              `json:"garage"`
	Envs         []EnvRequest      `json:"environments"`
	Versions     map[string]string `json:"versions"`
	TemplateEnvs map[string]string `json:"-"` // default env vars from template (not in JSON payload)
}

type ImageDef struct {
	Name       string            `json:"name"`
	Image      string            `json:"image"`
	Tag        string            `json:"tag"`
	Port       int               `json:"port"`
	HostPort   string            `json:"host_port"`
	Volumes    []string          `json:"volumes"`
	EnvVars    map[string]string `json:"env_vars"`
	DependsOn  []string          `json:"depends_on"`
	ExtraPorts []string          `json:"extra_ports"`
	Healthcheck string           `json:"healthcheck"`
	HealthcheckConfig map[string]string `json:"healthcheck_config"`
}

type EnvRequest struct {
	Name       string `json:"name"`
	Domain     string `json:"domain"`
	HTTPPort   int    `json:"http_port"`
	HTTPSPort  int    `json:"https_port"`
	Traefik    bool   `json:"traefik"`
	TraefikNet string `json:"traefik_network"`
	Deployment string `json:"deployment"`
	BEReplicas int    `json:"backend_replicas"`
	FEReplicas int    `json:"frontend_replicas"`
	GitEnabled bool   `json:"git_enabled"`
	GitRepo    string `json:"git_repo"`
	GitBranch  string `json:"git_branch"`
}

// defaultVersions are the fallback image tags for custom stacks.
var defaultVersions = map[string]string{
	"postgres":     "15-alpine",
	"mysql":        "8.0",
	"redis":        "7-alpine",
	"garage":       "v1.0.1",
	"garage_webui": "latest",
	"nginx":        "1.25-alpine",
	"node":         "20-alpine",
	"php":          "8.3-fpm-alpine",
	"composer":     "2.7",
}

// Create validates the request, writes the workspace directory, config.json,
// and run.sh. It does NOT run bootstrap — the caller does that to stream output.
func Create(workspacesDir string, req CreateRequest) error {
	if !validName.MatchString(req.Name) {
		return fmt.Errorf("invalid workspace name %q: use lowercase letters, numbers, hyphens only", req.Name)
	}

	wsPath := filepath.Join(workspacesDir, req.Name)
	if _, err := os.Stat(wsPath); err == nil {
		return fmt.Errorf("workspace %q already exists", req.Name)
	}

	if err := os.MkdirAll(wsPath, 0755); err != nil {
		return fmt.Errorf("create workspace dir: %w", err)
	}

	cfg, err := buildConfig(req)
	if err != nil {
		os.RemoveAll(wsPath) //nolint:errcheck
		return err
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		os.RemoveAll(wsPath) //nolint:errcheck
		return err
	}

	if err := os.WriteFile(filepath.Join(wsPath, "config.json"), data, 0644); err != nil {
		os.RemoveAll(wsPath) //nolint:errcheck
		return err
	}

	// Copy run.sh from the toolkit template — it must exist before bootstrap runs
	if err := copyRunSh(workspacesDir, wsPath); err != nil {
		os.RemoveAll(wsPath) //nolint:errcheck
		return fmt.Errorf("copy run.sh: %w", err)
	}

	return nil
}

// copyRunSh copies scripts/run.sh.template (relative to toolkit root, which is
// two directories above workspacesDir) into the workspace as run.sh.
func copyRunSh(workspacesDir, wsPath string) error {
	// toolkit root = parent of workspaces directory
	toolkitRoot := filepath.Dir(workspacesDir)
	tmpl := filepath.Join(toolkitRoot, "scripts", "run.sh.template")

	src, err := os.ReadFile(tmpl)
	if err != nil {
		return fmt.Errorf("run.sh.template not found at %s: %w", tmpl, err)
	}

	dest := filepath.Join(wsPath, "run.sh")
	if err := os.WriteFile(dest, src, 0755); err != nil {
		return err
	}
	return nil
}

func buildConfig(req CreateRequest) (map[string]any, error) {
	// Merge versions
	versions := make(map[string]string)
	for k, v := range defaultVersions {
		versions[k] = v
	}
	for k, v := range req.Versions {
		if v != "" {
			versions[k] = v
		}
	}

	// Build environments map
	if len(req.Envs) == 0 {
		return nil, fmt.Errorf("at least one environment is required")
	}
	environments := map[string]any{}
	for _, e := range req.Envs {
		envName := e.Name
		if envName == "" {
			continue
		}
		bePeers := e.BEReplicas
		if bePeers < 1 {
			bePeers = 1
		}
		fePeers := e.FEReplicas
		if fePeers < 1 {
			fePeers = 1
		}
		traefik := e.TraefikNet
		if traefik == "" {
			traefik = "traefik_net"
		}
		deployment := e.Deployment
		if deployment == "" {
			deployment = "compose"
		}
		frontend := req.Frontend
		if frontend == "" {
			frontend = "none"
		}
		database := req.Database
		if database == "" {
			database = "none"
		}
		httpPort := e.HTTPPort
		if httpPort == 0 {
			httpPort = 8080
		}
		httpsPort := e.HTTPSPort
		if httpsPort == 0 {
			httpsPort = 8443
		}

		envBlock := map[string]any{
			"domain":           e.Domain,
			"http_port":        httpPort,
			"https_port":       httpsPort,
			"backend":          req.Backend,
			"frontend_enabled": frontend != "none",
			"frontend":         frontend,
			"database":         database,
			"redis_enabled":    req.Redis,
			"garage_enabled":   req.Garage,
			"deployment":       deployment,
			"traefik_enabled":  e.Traefik,
			"traefik_network":  traefik,
			"git": map[string]any{
				"enabled":        e.GitEnabled,
				"repo":           e.GitRepo,
				"branch":         e.GitBranch,
				"backend_path":   "./src/backend",
				"frontend_path":  "./src/frontend",
			},
			"replicas": map[string]any{
				"backend":  bePeers,
				"frontend": fePeers,
			},
		}

		// Write template env vars (with smart secrets) into environments[env].env_vars.
		// env-gen.sh reads this field when generating the .env file for image stacks —
		// matching how init_workspace.sh stores them for CLI-based workspace creation.
		if len(req.TemplateEnvs) > 0 {
			envBlock["env_vars"] = req.TemplateEnvs
		}

		environments[envName] = envBlock
	}

	cfg := map[string]any{
		"project": map[string]any{
			"name":     req.Name,
			"type":     req.Type,
			"registry": req.Registry,
			"version": map[string]any{
				"major": 1, "minor": 0, "patch": 0, "build": 0,
			},
		},
		"versions":     versions,
		"environments": environments,
	}

	// Image stacks include the images array
	if req.Type == "image" && len(req.Images) > 0 {
		cfg["images"] = req.Images
	}

	return cfg, nil
}

// TemplateInfo is a summary of a stack template for the API.
type TemplateInfo struct {
	Name        string   `json:"name"`
	Label       string   `json:"label"`
	Description string   `json:"description"`
	Tags        []string `json:"tags"`
	ImageCount  int      `json:"image_count"`
}

// ListTemplates reads all JSON files in templates/stacks/ and returns summaries.
func ListTemplates(templatesDir string) ([]TemplateInfo, error) {
	stacksDir := filepath.Join(templatesDir, "stacks")
	entries, err := os.ReadDir(stacksDir)
	if err != nil {
		return []TemplateInfo{}, nil // no templates dir is not fatal
	}

	var templates []TemplateInfo
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(stacksDir, e.Name()))
		if err != nil {
			continue
		}
		var raw struct {
			Name        string   `json:"name"`
			Label       string   `json:"label"`
			Description string   `json:"description"`
			Tags        []string `json:"tags"`
			Images      []any    `json:"images"`
		}
		if err := json.Unmarshal(data, &raw); err != nil {
			continue
		}
		templates = append(templates, TemplateInfo{
			Name:        raw.Name,
			Label:       raw.Label,
			Description: raw.Description,
			Tags:        raw.Tags,
			ImageCount:  len(raw.Images),
		})
	}
	return templates, nil
}

// LoadTemplate reads a template JSON and returns its images and default env vars.
func LoadTemplate(templatesDir, name string) ([]ImageDef, map[string]string, error) {
	path := filepath.Join(templatesDir, "stacks", name+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, fmt.Errorf("template %q not found", name)
	}

	var raw struct {
		Images      []ImageDef        `json:"images"`
		DefaultEnvs map[string]string `json:"default_env_vars"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, nil, err
	}
	return raw.Images, raw.DefaultEnvs, nil
}
