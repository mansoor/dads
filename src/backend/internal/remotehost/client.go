// Package remotehost connects to registered remote hosts over SSH (Phase 7
// Multi-Host Support). It provides a pure-Go SSH client (no `ssh` binary in the
// image), an executor.Executor implementation that runs docker commands on the
// remote, and tar-over-SSH file transfer — so the control plane can operate
// workspaces that live on remote hosts.
package remotehost

import (
	"encoding/base64"
	"fmt"
	"net"
	"strconv"
	"time"

	"golang.org/x/crypto/ssh"
)

// Host carries the connection details for one remote host (decrypted key).
type Host struct {
	ID         int64
	Name       string
	Address    string
	Port       int
	User       string
	PrivateKey []byte // PEM private key (already decrypted)
	// HostKey is the base64 of the known SSH host public key. "" enables
	// trust-on-first-use: any key is accepted and recorded in Client.HostKey.
	HostKey string
}

// Client is a live SSH connection to a remote host.
type Client struct {
	ssh  *ssh.Client
	host Host
	// HostKey is the base64-marshaled host public key observed at connect time
	// (used by callers to persist the TOFU fingerprint on first connect).
	HostKey string
}

// Dial opens an SSH connection. With Host.HostKey set it verifies the server key
// (TOFU); empty accepts and records the key for the caller to store.
func Dial(h Host) (*Client, error) {
	signer, err := ssh.ParsePrivateKey(h.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("parse private key: %w", err)
	}
	var observed string
	cb := func(_ string, _ net.Addr, key ssh.PublicKey) error {
		observed = base64.StdEncoding.EncodeToString(key.Marshal())
		if h.HostKey == "" {
			return nil // trust-on-first-use
		}
		if observed != h.HostKey {
			return fmt.Errorf("host key mismatch for %s — refusing to connect (possible MITM)", h.Address)
		}
		return nil
	}
	port := h.Port
	if port == 0 {
		port = 22
	}
	cfg := &ssh.ClientConfig{
		User:            h.User,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: cb,
		Timeout:         10 * time.Second,
	}
	conn, err := ssh.Dial("tcp", net.JoinHostPort(h.Address, strconv.Itoa(port)), cfg)
	if err != nil {
		return nil, err
	}
	return &Client{ssh: conn, host: h, HostKey: observed}, nil
}

// Close terminates the SSH connection.
func (c *Client) Close() error {
	if c.ssh == nil {
		return nil
	}
	return c.ssh.Close()
}

// RunCombined runs a single command and returns its combined stdout+stderr. Used
// for connectivity tests and small remote queries.
func (c *Client) RunCombined(cmd string) (string, error) {
	sess, err := c.ssh.NewSession()
	if err != nil {
		return "", err
	}
	defer sess.Close()
	out, err := sess.CombinedOutput(cmd)
	return string(out), err
}
