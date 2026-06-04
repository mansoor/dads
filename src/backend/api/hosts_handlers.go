package api

import (
	"net/http"
	"strings"

	"github.com/dads/ui/internal/crypto"
	"github.com/dads/ui/internal/remotehost"
	"github.com/dads/ui/internal/settings"
)

// hostBody is the create/update payload. ssh_key is the plaintext PEM private
// key; it is encrypted at rest and never returned. An empty ssh_key on update
// keeps the existing key.
type hostBody struct {
	Name    string `json:"name"`
	Address string `json:"address"`
	SSHPort int    `json:"ssh_port"`
	SSHUser string `json:"ssh_user"`
	SSHKey  string `json:"ssh_key"`
}

// GET /api/hosts
func (h *Handler) ListHosts(w http.ResponseWriter, r *http.Request) {
	hosts, err := settings.ListHosts(h.db)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, hosts)
}

// POST /api/hosts
func (h *Handler) CreateHost(w http.ResponseWriter, r *http.Request) {
	var b hostBody
	if err := readJSON(r, &b); err != nil || b.Name == "" || b.Address == "" || b.SSHUser == "" || b.SSHKey == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name, address, ssh_user and ssh_key are required"})
		return
	}
	keyEnc, err := crypto.Encrypt(h.cryptoKey, []byte(b.SSHKey))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "encrypt key: " + err.Error()})
		return
	}
	host, err := settings.CreateHost(h.db, b.Name, b.Address, b.SSHPort, b.SSHUser, keyEnc)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "a host with that name already exists"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, host)
}

// PUT /api/hosts/{id}
func (h *Handler) UpdateHost(w http.ResponseWriter, r *http.Request) {
	id, err := parseSettingsID(r.URL.Path, "/api/hosts/")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid id"})
		return
	}
	var b hostBody
	if err := readJSON(r, &b); err != nil || b.Name == "" || b.Address == "" || b.SSHUser == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name, address and ssh_user are required"})
		return
	}
	keyEnc := ""
	if b.SSHKey != "" {
		if keyEnc, err = crypto.Encrypt(h.cryptoKey, []byte(b.SSHKey)); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "encrypt key: " + err.Error()})
			return
		}
	}
	host, err := settings.UpdateHost(h.db, id, b.Name, b.Address, b.SSHPort, b.SSHUser, keyEnc)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if host == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	writeJSON(w, http.StatusOK, host)
}

// DELETE /api/hosts/{id}
func (h *Handler) DeleteHost(w http.ResponseWriter, r *http.Request) {
	id, err := parseSettingsID(r.URL.Path, "/api/hosts/")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid id"})
		return
	}
	if err := settings.DeleteHost(h.db, id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// POST /api/hosts/{id}/test — SSH-connect and run `docker version` on the host.
// On a first successful connect the TOFU host fingerprint is persisted.
func (h *Handler) TestHost(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimSuffix(r.URL.Path, "/test")
	id, err := parseSettingsID(path, "/api/hosts/")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid id"})
		return
	}
	rh, err := h.dialHost(id)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"status": "error", "error": err.Error()})
		return
	}
	defer rh.Close()

	out, err := rh.RunCombined(`docker version --format '{{.Server.Version}}' 2>&1 || docker version`)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"status": "error",
			"error": "connected, but docker not reachable on host: " + strings.TrimSpace(out)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok",
		"message": "Connected — Docker " + strings.TrimSpace(out)})
}

// dialHost loads a host, decrypts its key, dials it, and persists the TOFU
// fingerprint on first connect. Caller must Close the returned client.
func (h *Handler) dialHost(id int64) (*remotehost.Client, error) {
	host, err := settings.GetHost(h.db, id)
	if err != nil || host == nil {
		return nil, errHostNotFound
	}
	keyPEM, err := crypto.Decrypt(h.cryptoKey, host.SSHKeyEnc)
	if err != nil {
		return nil, err
	}
	client, err := remotehost.Dial(remotehost.Host{
		ID: host.ID, Name: host.Name, Address: host.Address,
		Port: host.SSHPort, User: host.SSHUser,
		PrivateKey: keyPEM, HostKey: host.SSHHostKey,
	})
	if err != nil {
		return nil, err
	}
	if host.SSHHostKey == "" && client.HostKey != "" {
		_ = settings.SetHostKey(h.db, host.ID, client.HostKey) // persist TOFU fingerprint
	}
	return client, nil
}

var errHostNotFound = errString("host not found")

type errString string

func (e errString) Error() string { return string(e) }
