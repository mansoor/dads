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
	Docker    DockerStats    `json:"docker"`
	Host      HostStats      `json:"host"`
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
	MemTotalMB    int64   `json:"mem_total_mb"`
	MemAvailMB    int64   `json:"mem_avail_mb"`
	MemUsedPct    float64 `json:"mem_used_pct"`
	DiskTotalGB   float64 `json:"disk_total_gb"`
	DiskUsedGB    float64 `json:"disk_used_gb"`
	DiskUsedPct   float64 `json:"disk_used_pct"`
	UptimeSeconds float64 `json:"uptime_seconds"`
}

type WorkspaceSummary struct {
	Total       int                 `json:"total"`
	ByType      map[string]int      `json:"by_type"`
	Workspaces  []WorkspaceInfo     `json:"workspaces"`
}

type WorkspaceInfo struct {
	Name  string   `json:"name"`
	Type  string   `json:"type"`
	Envs  []string `json:"envs"`
}

// Collect gathers all stats.
func Collect(workspacesDir string) Stats {
	return Stats{
		Docker:     collectDocker(),
		Host:       collectHost(),
		Workspaces: collectWorkspaces(workspacesDir),
	}
}

// ── Docker ─────────────────────────────────────────────────────────────────────

func collectDocker() DockerStats {
	out, err := exec.Command("docker", "info", "--format", "{{json .}}").Output()
	if err != nil {
		return DockerStats{Error: "docker info failed: " + err.Error()}
	}

	var info struct {
		ServerVersion string `json:"ServerVersion"`
		Containers    int    `json:"Containers"`
		ContainersRunning int `json:"ContainersRunning"`
		ContainersPaused  int `json:"ContainersPaused"`
		ContainersStopped int `json:"ContainersStopped"`
		Images        int    `json:"Images"`
		Driver        string `json:"Driver"`
		DockerRootDir string `json:"DockerRootDir"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(out), &info); err != nil {
		return DockerStats{Error: "parse error: " + err.Error()}
	}

	volumes := countDockerVolumes()
	networks := countDockerNetworks()

	return DockerStats{
		ServerVersion:     info.ServerVersion,
		ContainersRunning: info.ContainersRunning,
		ContainersStopped: info.ContainersStopped,
		ContainersPaused:  info.ContainersPaused,
		ImagesTotal:       info.Images,
		VolumesTotal:      volumes,
		NetworksTotal:     networks,
		StorageDriver:     info.Driver,
		DockerRootDir:     info.DockerRootDir,
	}
}

func countDockerVolumes() int {
	out, err := exec.Command("docker", "volume", "ls", "-q").Output()
	if err != nil {
		return 0
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return 0
	}
	return len(lines)
}

func countDockerNetworks() int {
	out, err := exec.Command("docker", "network", "ls", "-q").Output()
	if err != nil {
		return 0
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return 0
	}
	return len(lines)
}

// ── Host ───────────────────────────────────────────────────────────────────────

func collectHost() HostStats {
	h := HostStats{
		OS:   readOSName(),
		Arch: runCmd("uname", "-m"),
		CPUs: countCPUs(),
	}

	// Memory from /proc/meminfo
	memTotal, memAvail := readMeminfo()
	h.MemTotalMB = memTotal / 1024
	h.MemAvailMB = memAvail / 1024
	if memTotal > 0 {
		h.MemUsedPct = float64(memTotal-memAvail) / float64(memTotal) * 100
	}

	// Disk — stat on /
	var stat syscall.Statfs_t
	if err := syscall.Statfs("/", &stat); err == nil {
		total := stat.Blocks * uint64(stat.Bsize)
		avail := stat.Bavail * uint64(stat.Bsize)
		used  := total - avail
		h.DiskTotalGB = float64(total) / 1e9
		h.DiskUsedGB  = float64(used) / 1e9
		if total > 0 {
			h.DiskUsedPct = float64(used) / float64(total) * 100
		}
	}

	// Uptime from /proc/uptime
	if data, err := os.ReadFile("/proc/uptime"); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) > 0 {
			h.UptimeSeconds, _ = strconv.ParseFloat(fields[0], 64)
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

func collectWorkspaces(workspacesDir string) WorkspaceSummary {
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
			Environments map[string]json.RawMessage `json:"environments"`
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

		summary.Total++
		summary.ByType[wsType]++
		summary.Workspaces = append(summary.Workspaces, WorkspaceInfo{
			Name: wsName,
			Type: wsType,
			Envs: envNames,
		})
	}
	return summary
}
