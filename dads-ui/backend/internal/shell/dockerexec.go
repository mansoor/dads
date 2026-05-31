// Package shell — Docker exec client using the daemon's Unix socket API.
// Calling `docker exec -it` from Go fails with "the input device is not a TTY"
// because Go's StdinPipe is a pipe, not a real TTY. The Docker daemon API
// however allocates a PTY inside the container regardless of what the caller's
// stdin is. We talk to the daemon directly over /var/run/docker.sock.
package shell

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
)

// DockerExec wraps a hijacked Docker exec session (PTY allocated in container).
type DockerExec struct {
	conn   net.Conn     // raw TCP connection to the Docker daemon (hijacked)
	reader *bufio.Reader // bufio wrapper so we drain leftover HTTP bytes first
	execID string
	socket string
}

// NewDockerExec creates and starts an exec session in the given container.
// cols/rows set the initial PTY dimensions.
func NewDockerExec(containerID string, cols, rows int, socketPath string) (*DockerExec, error) {
	if socketPath == "" {
		socketPath = "/var/run/docker.sock"
	}

	// ── Step 1: POST /containers/{id}/exec — allocate exec with Tty:true ────
	conn1, err := net.Dial("unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("docker socket: %w", err)
	}

	// Build the shell command: set TERM + PS1 then exec bash (fallback to sh)
	shellCmd := fmt.Sprintf(
		"export TERM=xterm-256color COLUMNS=%d LINES=%d PS1='\\u@\\h:\\w\\$ '; exec bash -i 2>/dev/null || exec sh -i",
		cols, rows,
	)
	cmdJSON, _ := json.Marshal(shellCmd)
	execBody := fmt.Sprintf(
		`{"AttachStdin":true,"AttachStdout":true,"AttachStderr":true,"Tty":true,"Cmd":["sh","-c",%s]}`,
		string(cmdJSON),
	)

	fmt.Fprintf(conn1,
		"POST /v1.41/containers/%s/exec HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s",
		containerID, len(execBody), execBody,
	)

	r1 := bufio.NewReader(conn1)
	resp1, err := http.ReadResponse(r1, nil)
	if err != nil {
		conn1.Close()
		return nil, fmt.Errorf("exec create response: %w", err)
	}
	var execResp struct {
		ID string `json:"Id"`
	}
	json.NewDecoder(resp1.Body).Decode(&execResp) //nolint:errcheck
	resp1.Body.Close()
	conn1.Close()

	if execResp.ID == "" {
		return nil, fmt.Errorf("empty exec ID — container may not be running")
	}

	// ── Step 2: POST /exec/{id}/start — hijack the connection ────────────────
	conn2, err := net.Dial("unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("docker socket (start): %w", err)
	}

	startBody := `{"Detach":false,"Tty":true}`
	fmt.Fprintf(conn2,
		"POST /v1.41/exec/%s/start HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: %d\r\nUpgrade: tcp\r\nConnection: Upgrade\r\n\r\n%s",
		execResp.ID, len(startBody), startBody,
	)

	r2 := bufio.NewReader(conn2)
	resp2, err := http.ReadResponse(r2, nil)
	if err != nil {
		conn2.Close()
		return nil, fmt.Errorf("exec start response: %w", err)
	}
	// 101 Switching Protocols — connection is now a raw PTY stream
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusSwitchingProtocols && resp2.StatusCode != http.StatusOK {
		conn2.Close()
		return nil, fmt.Errorf("unexpected exec start status: %d", resp2.StatusCode)
	}

	return &DockerExec{conn: conn2, reader: r2, execID: execResp.ID, socket: socketPath}, nil
}

// Read reads from the container's PTY output (goes through bufio to drain
// any HTTP bytes that were already buffered before the protocol switch).
func (e *DockerExec) Read(p []byte) (int, error) {
	return e.reader.Read(p)
}

// Write sends bytes to the container's PTY stdin.
func (e *DockerExec) Write(p []byte) (int, error) {
	return e.conn.Write(p)
}

// Close terminates the exec session.
func (e *DockerExec) Close() error {
	return e.conn.Close()
}

// Resize sends a PTY resize request to the Docker daemon.
func (e *DockerExec) Resize(rows, cols int) {
	conn, err := net.Dial("unix", e.socket)
	if err != nil {
		return
	}
	defer conn.Close()
	fmt.Fprintf(conn,
		"POST /v1.41/exec/%s/resize?h=%d&w=%d HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
		e.execID, rows, cols,
	)
	// Drain the response so the daemon processes it
	r := bufio.NewReader(conn)
	resp, err := http.ReadResponse(r, nil)
	if err == nil {
		resp.Body.Close()
	}
}
