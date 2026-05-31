// Package imagecheck queries Docker Hub to detect available image updates
// for image-stack workspaces. Results are cached and refreshed hourly by
// a background goroutine started in main.go.
package imagecheck

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// ServiceUpdate describes the update status of one service image.
type ServiceUpdate struct {
	Service   string `json:"service"`
	Image     string `json:"image"`
	Tag       string `json:"tag"`
	HasUpdate bool   `json:"has_update"`
	NewerTag  string `json:"newer_tag,omitempty"` // for pinned tags: newest available
	Error     string `json:"error,omitempty"`
}

// CacheEntry holds check results and when they were fetched.
type CacheEntry struct {
	Results   []ServiceUpdate
	CheckedAt time.Time
}

// Cache stores image-check results keyed by "workspace/env".
type Cache struct {
	mu      sync.RWMutex
	entries map[string]*CacheEntry
}

func NewCache() *Cache {
	return &Cache{entries: make(map[string]*CacheEntry)}
}

func (c *Cache) Get(ws, env string) (*CacheEntry, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.entries[ws+"/"+env]
	return e, ok
}

func (c *Cache) Set(ws, env string, results []ServiceUpdate) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[ws+"/"+env] = &CacheEntry{Results: results, CheckedAt: time.Now()}
}

// ── Docker Hub API helpers ─────────────────────────────────────────────────────

func hubToken(repo string) string {
	url := fmt.Sprintf("https://auth.docker.io/token?service=registry.docker.io&scope=repository:%s:pull", repo)
	resp, err := http.Get(url) //nolint:gosec,noctx
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	var v struct{ Token string }
	json.NewDecoder(resp.Body).Decode(&v) //nolint:errcheck
	return v.Token
}

func normaliseRepo(image string) string {
	if !strings.Contains(image, "/") {
		return "library/" + image
	}
	return image
}

// remoteDigest fetches the manifest digest for image:tag from Docker Hub.
func remoteDigest(image, tag string) string {
	repo := normaliseRepo(image)
	token := hubToken(repo)
	if token == "" {
		return ""
	}
	url := fmt.Sprintf("https://registry-1.docker.io/v2/%s/manifests/%s", repo, tag)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.docker.distribution.manifest.v2+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		return ""
	}
	resp.Body.Close()
	return resp.Header.Get("Docker-Content-Digest")
}

// localDigest gets the local image digest via docker CLI.
func localDigest(imageRef string) string {
	out, err := exec.Command("docker", "image", "inspect",
		"--format", "{{index .RepoDigests 0}}", imageRef).Output()
	if err != nil {
		return ""
	}
	s := strings.TrimSpace(string(out))
	if idx := strings.Index(s, "@"); idx >= 0 {
		return s[idx+1:]
	}
	return s
}

// newerSemverTag queries Docker Hub tags list and returns the latest semver
// tag that sorts after currentTag, or "" if none.
func newerSemverTag(image, currentTag string) string {
	repo := normaliseRepo(image)
	token := hubToken(repo)
	if token == "" {
		return ""
	}

	url := fmt.Sprintf("https://registry-1.docker.io/v2/%s/tags/list", repo)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		return ""
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var result struct{ Tags []string }
	json.Unmarshal(body, &result) //nolint:errcheck

	// Filter to semver-looking tags
	var semver []string
	for _, t := range result.Tags {
		if len(t) > 0 && (t[0] >= '0' && t[0] <= '9' || t[0] == 'v') {
			semver = append(semver, t)
		}
	}
	sort.Strings(semver)

	// Find tags that come after the current one
	found := false
	var newer string
	for _, t := range semver {
		if found {
			newer = t
		}
		if t == currentTag {
			found = true
		}
	}
	return newer
}

// ── Main check function ────────────────────────────────────────────────────────

// Check reads config.json for the workspace and checks each image for updates.
func Check(workspacesDir, wsName, env string) []ServiceUpdate {
	cfgPath := filepath.Join(workspacesDir, wsName, "config.json")
	data, err := os.ReadFile(cfgPath)
	if err != nil {
		return nil
	}

	var cfg struct {
		Project struct{ Type string } `json:"project"`
		Images  []struct {
			Name  string `json:"name"`
			Image string `json:"image"`
			Tag   string `json:"tag"`
		} `json:"images"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil || cfg.Project.Type != "image" {
		return nil
	}

	var results []ServiceUpdate
	for _, img := range cfg.Images {
		tag := img.Tag
		if tag == "" {
			tag = "latest"
		}
		fullRef := img.Image + ":" + tag
		upd := ServiceUpdate{Service: img.Name, Image: img.Image, Tag: tag}

		if tag == "latest" {
			local := localDigest(fullRef)
			remote := remoteDigest(img.Image, tag)
			if remote == "" {
				upd.Error = "could not reach registry"
			} else if local == "" || local != remote {
				upd.HasUpdate = true
				upd.NewerTag = "latest (new digest)"
			}
		} else {
			newer := newerSemverTag(img.Image, tag)
			if newer != "" {
				upd.HasUpdate = true
				upd.NewerTag = newer
			}
		}

		results = append(results, upd)
	}
	return results
}

// RunBackground starts a goroutine that checks all image-stack workspaces
// every hour. Results are stored in cache.
func RunBackground(cache *Cache, workspacesDir string) {
	go func() {
		checkAll(cache, workspacesDir)
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			checkAll(cache, workspacesDir)
		}
	}()
}

func checkAll(cache *Cache, workspacesDir string) {
	entries, err := os.ReadDir(workspacesDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		wsName := e.Name()
		cfgPath := filepath.Join(workspacesDir, wsName, "config.json")
		data, err := os.ReadFile(cfgPath)
		if err != nil {
			continue
		}
		var cfg struct {
			Project      struct{ Type string }      `json:"project"`
			Environments map[string]json.RawMessage `json:"environments"`
		}
		if json.Unmarshal(data, &cfg) != nil || cfg.Project.Type != "image" {
			continue
		}
		for envName := range cfg.Environments {
			results := Check(workspacesDir, wsName, envName)
			if results != nil {
				cache.Set(wsName, envName, results)
			}
		}
	}
}
