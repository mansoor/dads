package shell

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/dads/ui/internal/backup"
	"github.com/dads/ui/internal/builder"
	"github.com/dads/ui/internal/dockerops"
	"github.com/dads/ui/internal/version"
	"github.com/dads/ui/internal/workspace"
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
	"build":   true,
	"promote": true,
}

// Bridge executes run.sh commands for a given workspace.
type Bridge struct {
	workspacesDir string
	toolkitRoot   string
}

func NewBridge(workspacesDir, toolkitRoot string) *Bridge {
	return &Bridge{workspacesDir: workspacesDir, toolkitRoot: toolkitRoot}
}

// Bootstrap scaffolds a workspace environment natively in Go (Phase 6.5 finish —
// replaces scripts/bootstrap.sh). Used during workspace creation and by the
// `init` command. stdout/stderr are the same stream in practice; progress is
// written to stdout.
func (b *Bridge) Bootstrap(workspaceName, env string, stdout, stderr io.Writer) error {
	return b.bootstrap(workspaceName, env, false, stdout)
}

func (b *Bridge) bootstrap(workspaceName, env string, regenEnv bool, out io.Writer) error {
	templatesDir := filepath.Join(b.toolkitRoot, "templates")
	return workspace.Bootstrap(b.workspacesDir, templatesDir, workspaceName, env, regenEnv, out)
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

// first returns the first element of s, or "" if empty.
func first(s []string) string {
	if len(s) > 0 {
		return s[0]
	}
	return ""
}

// contains reports whether s contains v.
func contains(s []string, v string) bool {
	for _, e := range s {
		if e == v {
			return true
		}
	}
	return false
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

// Run executes a workspace command, streaming output to the provided writers.
// Returns an error if the command is not allowlisted or exits non-zero.
//
// Phase 6.5b: compose-lifecycle commands (start/stop/down/restart/update/ps/
// logs/refresh) run natively in Go via dockerops — no shell. Everything else
// (backup/restore/init/version), swarm deployments, and any case dockerops
// can't handle fall back to the legacy bash run.sh.
func (b *Bridge) Run(opts RunOptions) error {
	if !allowedCommands[opts.Command] {
		return fmt.Errorf("command %q is not permitted", opts.Command)
	}

	// Phase 6.5 finish: init re-bootstraps an environment natively in Go.
	// run.sh passed EXTRA to bootstrap.sh; --regen-env forces .env regeneration.
	if opts.Command == "init" || opts.Command == "bootstrap" {
		return b.bootstrap(opts.Workspace, opts.Env, contains(opts.Extra, "--regen-env"), opts.Stdout)
	}

	// Phase 6.5 finish: version is managed natively in Go (config.json edit).
	// run.sh maps `version <sub> <arg>` to the ENV/Extra slots, so do the same.
	if version.Handles(opts.Command) {
		_, err := version.Run(version.Options{
			WorkspacesDir: b.workspacesDir,
			Workspace:     opts.Workspace,
			Subcommand:    opts.Env,
			Arg:           first(opts.Extra),
			Stdout:        opts.Stdout,
		})
		return err
	}

	// Phase 6.5 finish: build/promote (image build/push, retag-and-redeploy) run
	// natively in Go. Env/Extra carry the run.sh argument layout.
	if builder.Handles(opts.Command) {
		_, err := builder.Run(builder.Options{
			WorkspacesDir: b.workspacesDir,
			Workspace:     opts.Workspace,
			Command:       opts.Command,
			Env:           opts.Env,
			Extra:         opts.Extra,
			EnvVars:       shellEnv(),
			Stdout:        opts.Stdout,
			Stderr:        opts.Stderr,
		})
		return err
	}

	if dockerops.Handles(opts.Command) {
		handled, err := dockerops.Run(dockerops.Options{
			WorkspacesDir: b.workspacesDir,
			Workspace:     opts.Workspace,
			Command:       opts.Command,
			Env:           opts.Env,
			Extra:         opts.Extra,
			EnvVars:       shellEnv(),
			Stdout:        opts.Stdout,
			Stderr:        opts.Stderr,
		})
		if handled {
			return err
		}
		// not handled (swarm / unreadable config) — fall through to bash
	}

	// Phase 6.5c: backup/restore run natively in Go (SQL dump + volume archive).
	if backup.Handles(opts.Command) {
		handled, err := backup.Run(backup.Options{
			WorkspacesDir: b.workspacesDir,
			Workspace:     opts.Workspace,
			Command:       opts.Command,
			Env:           opts.Env,
			Extra:         opts.Extra,
			EnvVars:       shellEnv(),
			Stdout:        opts.Stdout,
			Stderr:        opts.Stderr,
			Timestamp:     time.Now().UTC().Format("2006-01-02_15-04-05"),
		})
		if handled {
			return err
		}
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
