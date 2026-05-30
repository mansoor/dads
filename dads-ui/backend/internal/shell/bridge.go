package shell

import (
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
)

// Allowlisted run.sh commands. Nothing outside this list can be executed.
var allowedCommands = map[string]bool{
	"start":   true,
	"stop":    true,
	"restart": true,
	"ps":      true,
	"logs":    true,
	"refresh": true,
	"backup":  true,
	"init":    true,
	"version": true,
}

// Bridge executes run.sh commands for a given workspace.
type Bridge struct {
	workspacesDir string
}

func NewBridge(workspacesDir string) *Bridge {
	return &Bridge{workspacesDir: workspacesDir}
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

// Run executes a run.sh command, streaming output to the provided writers.
// It returns an error if the command is not allowlisted, the workspace doesn't
// exist, or the process exits non-zero.
func (b *Bridge) Run(opts RunOptions) error {
	if !allowedCommands[opts.Command] {
		return fmt.Errorf("command %q is not permitted", opts.Command)
	}

	runSh := filepath.Join(b.workspacesDir, opts.Workspace, "run.sh")

	// Build argv — never use shell=true or string interpolation
	argv := []string{runSh, opts.Command}
	if opts.Env != "" {
		argv = append(argv, opts.Env)
	}
	argv = append(argv, opts.Extra...)

	cmd := exec.Command("bash", argv...) //nolint:gosec // argv is allowlisted
	cmd.Dir = filepath.Join(b.workspacesDir, opts.Workspace)
	cmd.Stdout = opts.Stdout
	cmd.Stderr = opts.Stderr

	return cmd.Run()
}

// RunStreaming is like Run but returns an *exec.Cmd already started, so the
// caller can stream output via cmd.Stdout/Stderr pipes before calling Wait().
func (b *Bridge) Start(opts RunOptions) (*exec.Cmd, error) {
	if !allowedCommands[opts.Command] {
		return nil, fmt.Errorf("command %q is not permitted", opts.Command)
	}

	runSh := filepath.Join(b.workspacesDir, opts.Workspace, "run.sh")
	argv := []string{runSh, opts.Command}
	if opts.Env != "" {
		argv = append(argv, opts.Env)
	}
	argv = append(argv, opts.Extra...)

	cmd := exec.Command("bash", argv...) //nolint:gosec
	cmd.Dir = filepath.Join(b.workspacesDir, opts.Workspace)

	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmd, nil
}
