package shell

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
)

// Allowlisted run.sh commands. Nothing outside this list can be executed.
var allowedCommands = map[string]bool{
	"start":   true,
	"stop":    true,
	"down":    true,
	"restart": true,
	"update":  true,
	"ps":      true,
	"logs":    true,
	"refresh": true,
	"backup":  true,
	"restore": true,
	"init":    true,
	"version": true,
}

// Bridge executes run.sh commands for a given workspace.
type Bridge struct {
	workspacesDir string
	toolkitRoot   string
}

func NewBridge(workspacesDir, toolkitRoot string) *Bridge {
	return &Bridge{workspacesDir: workspacesDir, toolkitRoot: toolkitRoot}
}

// Bootstrap runs scripts/bootstrap.sh directly for a workspace environment.
// This is used during workspace creation — run.sh doesn't exist yet at that
// point (bootstrap.sh is what generates it), so we can't go through run.sh.
func (b *Bridge) Bootstrap(workspaceName, env string, stdout, stderr io.Writer) error {
	bootstrapSh := filepath.Join(b.toolkitRoot, "scripts", "bootstrap.sh")
	workspaceDir := filepath.Join(b.workspacesDir, workspaceName)

	cmd := exec.Command("bash", bootstrapSh, env) //nolint:gosec
	cmd.Dir = workspaceDir

	// Bootstrap needs WORKSPACE_ROOT exported — lib.sh derives all paths from it
	cmdEnv := shellEnv()
	cmdEnv = filterEnv(cmdEnv, "WORKSPACE_ROOT")
	cmdEnv = append(cmdEnv, "WORKSPACE_ROOT="+workspaceDir)
	// Suppress the standalone hint that bootstrap.sh prints when not called from init_workspace.sh
	cmdEnv = append(cmdEnv, "_INIT_SH_RUNNING=true")
	cmd.Env = cmdEnv

	cmd.Stdout = stdout
	cmd.Stderr = stderr
	return cmd.Run()
}

// RunOptions configures a command execution.
type RunOptions struct {
	Workspace string
	Command   string
	Env       string
	Extra     []string // additional args (e.g. "db" for backup, "minor" for version bump)
	Stdout    io.Writer
	Stderr    io.Writer
}

// shellEnv builds the environment for child processes.
// We inherit the server's env (which has PATH, HOME, etc.) and overlay
// a few critical variables to ensure docker compose and toolkit scripts work
// correctly regardless of how the server process was started.
func shellEnv() []string {
	env := os.Environ() // inherit everything from the server process

	// Ensure HOME is set — docker needs it to locate ~/.docker/config.json
	if os.Getenv("HOME") == "" {
		env = append(env, "HOME=/root")
	}

	// Ensure the Alpine tool paths are present — apk installs to these locations
	path := os.Getenv("PATH")
	if path == "" {
		path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	}
	// Add docker CLI plugin path so 'docker compose' resolves the plugin
	const pluginPath = "/usr/lib/docker/cli-plugins"
	if !containsStr(path, pluginPath) {
		path = pluginPath + ":" + path
	}
	// Replace PATH in env slice
	env = filterEnv(env, "PATH")
	env = append(env, "PATH="+path)

	// Ensure docker socket is reachable
	if os.Getenv("DOCKER_HOST") == "" {
		env = append(env, "DOCKER_HOST=unix:///var/run/docker.sock")
	}

	// Suppress interactive prompts — scripts should never block waiting for input
	env = append(env, "DEBIAN_FRONTEND=noninteractive")
	env = append(env, "TERM=xterm-256color") // enables colour output from lib.sh

	return env
}

func filterEnv(env []string, key string) []string {
	prefix := key + "="
	out := env[:0:len(env)]
	for _, e := range env {
		if len(e) < len(prefix) || e[:len(prefix)] != prefix {
			out = append(out, e)
		}
	}
	return out
}

func containsStr(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub ||
		len(s) > len(sub) && (s[:len(sub)] == sub || s[len(s)-len(sub):] == sub ||
			func() bool {
				for i := 1; i < len(s)-len(sub); i++ {
					if s[i:i+len(sub)] == sub {
						return true
					}
				}
				return false
			}()))
}

func buildCmd(runSh, workspaceDir string, opts RunOptions) *exec.Cmd {
	argv := []string{runSh, opts.Command}
	if opts.Env != "" {
		argv = append(argv, opts.Env)
	}
	argv = append(argv, opts.Extra...)

	cmd := exec.Command("bash", argv...) //nolint:gosec // argv is allowlisted
	cmd.Dir = workspaceDir
	cmd.Env = shellEnv()
	return cmd
}

// Run executes a run.sh command, streaming output to the provided writers.
// Returns an error if the command is not allowlisted or exits non-zero.
func (b *Bridge) Run(opts RunOptions) error {
	if !allowedCommands[opts.Command] {
		return fmt.Errorf("command %q is not permitted", opts.Command)
	}

	workspaceDir := filepath.Join(b.workspacesDir, opts.Workspace)
	runSh := filepath.Join(workspaceDir, "run.sh")

	cmd := buildCmd(runSh, workspaceDir, opts)
	cmd.Stdout = opts.Stdout
	cmd.Stderr = opts.Stderr

	return cmd.Run()
}

// Start spawns the command and returns immediately so the caller can stream
// output before calling Wait().
func (b *Bridge) Start(opts RunOptions) (*exec.Cmd, error) {
	if !allowedCommands[opts.Command] {
		return nil, fmt.Errorf("command %q is not permitted", opts.Command)
	}

	workspaceDir := filepath.Join(b.workspacesDir, opts.Workspace)
	runSh := filepath.Join(workspaceDir, "run.sh")

	cmd := buildCmd(runSh, workspaceDir, opts)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmd, nil
}
