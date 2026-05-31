// Package stats collects Docker and host system metrics for the dashboard.
package stats

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// Stats is the full dashboard payload.
type Stats struct {
	Docker     DockerStats      `json:"docker"`
	Host       HostStats        `json:"host"`
	Workspaces WorkspaceSummary `json:"workspaces"`
}

type DockerStats struct {
	ServerVersion     string `json:"server_version"`
	ContainersRunning int    `json:"containers_running"`
	ContainersStopped int    `json:"containers_stopped"`
	ContainersPaused  int    `json:"containers_paused"`
	ImagesTotal       int    `json:"images_total"`
	VolumesTotal      int    `json:"volumes_total"`
	NetworksTotal     int    `json:"networks_total"`
	StorageDriver     string `json:"storage_driver"`
	DockerRootDir     string `json:"docker_root_dir"`
	Error             string `json:"error,omitempty"`
}

type HostStats struct {
	OS            string  `json:"os"`
	Arch          string  `json:"arch"`
	CPUs          int     `json:"cpus"`
	MemTotalMB    float64 `json:"mem_total_mb"`
	MemAvailMB    float64 `json:"mem_avail_mb"`
	MemUsedPct    float64 `json:"mem_used_pct"`
	DiskTotalGB   float64 `json:"disk_total_gb"`
	DiskUsedGB    float64 `json:"disk_used_gb"`
	DiskFreeGB    float64 `json:"disk_free_gb"`
	DiskUsedPct   float64 `json:"disk_used_pct"`
	UptimeSeconds float64 `json:"uptime_seconds"`
}

type WorkspaceSummary struct {
	Total      int             `json:"total"`
	ByType     map[string]int  `json:"by_type"`
	Workspaces []WorkspaceInfo `json:"workspaces"`
}

type WorkspaceInfo struct {
	Name              string   `json:"name"`
	Type              string   `json:"type"`
	Envs              []string `json:"envs"`
	ImageCount        int      `json:"image_count"`
	RunningContainers int      `json:"running_containers"`
	DiskMB            float64  `json:"disk_mb"`   // workspace directory size
	MemMB             float64  `json:"mem_mb"`    // sum of container RSS across all envs
}

// Collect gathers all stats.
func Collect(workspacesDir string) Stats {
	projectContainers := getRunningContainersByProject()
	projectMemory     := containerMemByProject()

	return Stats{
		Docker:     collectDocker(),
		Host:       collectHost(),
		Workspaces: collectWorkspaces(workspacesDir, projectContainers, projectMemory),
	}
}

// ── Docker ─────────────────────────────────────────────────────────────────────

func collectDocker() DockerStats {
	out, err := exec.Command("docker", "info", "--format", "{{json .}}").Output()
	if err != nil {
		return DockerStats{Error: "docker info failed: " + err.Error()}
	}

	var info struct {
		ServerVersion     string `json:"ServerVersion"`
		ContainersRunning int    `json:"ContainersRunning"`
		ContainersPaused  int    `json:"ContainersPaused"`
		ContainersStopped int    `json:"ContainersStopped"`
		Images            int    `json:"Images"`
		Driver            string `json:"Driver"`
		DockerRootDir     string `json:"DockerRootDir"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(out), &info); err != nil {
		return DockerStats{Error: "parse error: " + err.Error()}
	}

	return DockerStats{
		ServerVersion:     info.ServerVersion,
		ContainersRunning: info.ContainersRunning,
		ContainersStopped: info.ContainersStopped,
		ContainersPaused:  info.ContainersPaused,
		ImagesTotal:       info.Images,
		VolumesTotal:      countDockerObjects("volume"),
		NetworksTotal:     countDockerObjects("network"),
		StorageDriver:     info.Driver,
		DockerRootDir:     info.DockerRootDir,
	}
}

func countDockerObjects(kind string) int {
	out, err := exec.Command("docker", kind, "ls", "-q").Output()
	if err != nil {
		return 0
	}
	s := strings.TrimSpace(string(out))
	if s == "" {
		return 0
	}
	return len(strings.Split(s, "\n"))
}

// workspaceDiskMB returns the disk usage of a workspace directory in MB.
func workspaceDiskMB(wsPath string) float64 {
	out, err := exec.Command("du", "-sk", wsPath).Output()
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(out))
	if len(fields) == 0 {
		return 0
	}
	kb, _ := strconv.ParseFloat(fields[0], 64)
	return kb / 1024.0
}

// containerMemByProject returns a map of compose project → total memory in MB.
func containerMemByProject() map[string]float64 {
	result := make(map[string]float64)

	// Get container IDs with their compose project label
	psOut, err := exec.Command("docker", "ps", "--format", "{{.ID}} {{.Labels}}").Output()
	if err != nil {
		return result
	}
	projectByID := make(map[string]string)
	scanner := bufio.NewScanner(strings.NewReader(string(psOut)))
	for scanner.Scan() {
		parts := strings.SplitN(scanner.Text(), " ", 2)
		if len(parts) < 2 {
			continue
		}
		id := parts[0]
		for _, kv := range strings.Split(parts[1], ",") {
			kv = strings.TrimSpace(kv)
			if strings.HasPrefix(kv, "com.docker.compose.project=") {
				projectByID[id] = strings.TrimPrefix(kv, "com.docker.compose.project=")
			}
		}
	}

	if len(projectByID) == 0 {
		return result
	}

	// Get memory stats per container
	statsOut, err := exec.Command("docker", "stats", "--no-stream", "--format", "{{.ID}} {{.MemUsage}}").Output()
	if err != nil {
		return result
	}
	scanner = bufio.NewScanner(strings.NewReader(string(statsOut)))
	for scanner.Scan() {
		parts := strings.Fields(scanner.Text())
		if len(parts) < 2 {
			continue
		}
		// ID may be shortened — match prefix
		shortID := parts[0]
		var project string
		for id, p := range projectByID {
			if strings.HasPrefix(id, shortID) || strings.HasPrefix(shortID, id[:min(len(id), 12)]) {
				project = p
				break
			}
		}
		if project == "" {
			continue
		}
		// MemUsage is like "123MiB / 4GiB" — parse the first value
		memStr := parts[1]
		result[project] += parseMem(memStr)
	}
	return result
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// parseMem parses Docker memory strings like "123MiB", "1.5GiB", "512KiB" → MB.
func parseMem(s string) float64 {
	s = strings.TrimSpace(s)
	if strings.HasSuffix(s, "GiB") {
		v, _ := strconv.ParseFloat(strings.TrimSuffix(s, "GiB"), 64)
		return v * 1024
	}
	if strings.HasSuffix(s, "MiB") {
		v, _ := strconv.ParseFloat(strings.TrimSuffix(s, "MiB"), 64)
		return v
	}
	if strings.HasSuffix(s, "KiB") {
		v, _ := strconv.ParseFloat(strings.TrimSuffix(s, "KiB"), 64)
		return v / 1024
	}
	if strings.HasSuffix(s, "MB") {
		v, _ := strconv.ParseFloat(strings.TrimSuffix(s, "MB"), 64)
		return v
	}
	if strings.HasSuffix(s, "GB") {
		v, _ := strconv.ParseFloat(strings.TrimSuffix(s, "GB"), 64)
		return v * 1024
	}
	return 0
}

// getRunningContainersByProject returns a map of compose project → running container count.
// It calls docker ps once and parses the com.docker.compose.project label.
func getRunningContainersByProject() map[string]int {
	result := make(map[string]int)
	out, err := exec.Command("docker", "ps", "--format", "{{.Labels}}").Output()
	if err != nil {
		return result
	}
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		for _, kv := range strings.Split(scanner.Text(), ",") {
			kv = strings.TrimSpace(kv)
			if strings.HasPrefix(kv, "com.docker.compose.project=") {
				project := strings.TrimPrefix(kv, "com.docker.compose.project=")
				result[project]++
			}
		}
	}
	return result
}

// ── Host ───────────────────────────────────────────────────────────────────────

func collectHost() HostStats {
	h := HostStats{
		OS:   readOSName(),
		Arch: runCmd("uname", "-m"),
		CPUs: countCPUs(),
	}

	memTotal, memAvail := readMeminfo()
	h.MemTotalMB = float64(memTotal) / 1024.0
	h.MemAvailMB = float64(memAvail) / 1024.0
	if memTotal > 0 {
		h.MemUsedPct = float64(memTotal-memAvail) / float64(memTotal) * 100.0
	}

	var stat syscall.Statfs_t
	if err := syscall.Statfs("/", &stat); err == nil {
		bsize  := uint64(stat.Bsize)
		total  := stat.Blocks * bsize
		free   := stat.Bavail * bsize
		used   := total - free
		h.DiskTotalGB = float64(total) / 1e9
		h.DiskUsedGB  = float64(used) / 1e9
		h.DiskFreeGB  = float64(free) / 1e9
		if total > 0 {
			h.DiskUsedPct = float64(used) / float64(total) * 100.0
		}
	}

	if data, err := os.ReadFile("/proc/uptime"); err == nil {
		if f := strings.Fields(string(data)); len(f) > 0 {
			h.UptimeSeconds, _ = strconv.ParseFloat(f[0], 64)
		}
	}

	return h
}

func readOSName() string {
	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return "Linux"
	}
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
		}
	}
	return "Linux"
}

func countCPUs() int {
	data, err := os.ReadFile("/proc/cpuinfo")
	if err != nil {
		return 0
	}
	count := 0
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		if strings.HasPrefix(scanner.Text(), "processor") {
			count++
		}
	}
	return count
}

// readMeminfo returns MemTotal and MemAvailable in kB.
func readMeminfo() (total, available int64) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return
	}
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		val, _ := strconv.ParseInt(fields[1], 10, 64)
		switch fields[0] {
		case "MemTotal:":
			total = val
		case "MemAvailable:":
			available = val
		}
	}
	return
}

func runCmd(name string, args ...string) string {
	out, err := exec.Command(name, args...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// ── Workspaces ─────────────────────────────────────────────────────────────────

func collectWorkspaces(workspacesDir string, projectContainers map[string]int, projectMemory map[string]float64) WorkspaceSummary {
	summary := WorkspaceSummary{
		ByType:     make(map[string]int),
		Workspaces: []WorkspaceInfo{},
	}

	entries, err := os.ReadDir(workspacesDir)
	if err != nil {
		return summary
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
			Images       []json.RawMessage           `json:"images"`
			Environments map[string]json.RawMessage  `json:"environments"`
		}
		if json.Unmarshal(data, &cfg) != nil {
			continue
		}

		wsType := cfg.Project.Type
		if wsType == "" {
			wsType = "custom"
		}

		envNames := make([]string, 0, len(cfg.Environments))
		for k := range cfg.Environments {
			envNames = append(envNames, k)
		}

		// Aggregate per-env metrics across all environments
		runningTotal := 0
		memTotal     := 0.0
		for _, env := range envNames {
			project := wsName + "_" + env
			runningTotal += projectContainers[project]
			memTotal     += projectMemory[project]
		}

		wsPath := filepath.Join(workspacesDir, wsName)

		summary.Total++
		summary.ByType[wsType]++
		summary.Workspaces = append(summary.Workspaces, WorkspaceInfo{
			Name:              wsName,
			Type:              wsType,
			Envs:              envNames,
			ImageCount:        len(cfg.Images),
			RunningContainers: runningTotal,
			DiskMB:            workspaceDiskMB(wsPath),
			MemMB:             memTotal,
		})
	}
	return summary
}
