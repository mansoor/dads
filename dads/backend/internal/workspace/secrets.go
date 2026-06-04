package workspace

import (
	"crypto/rand"
	"encoding/hex"
	"math/big"
	"strings"
)

// GenerateSmartDefaults takes a template's default_env_vars map and replaces
// any placeholder values with auto-generated secure defaults.
//
// Rules:
//   - If the value does NOT look like a placeholder, keep it as-is.
//   - If the key suggests a secret (PASSWORD, TOKEN, SECRET, KEY, SALT),
//     generate a random value of the appropriate type.
//   - Everything else (ports, hostnames, database names, usernames, domains)
//     is kept even if it looks like a placeholder — those need human input.
func GenerateSmartDefaults(envs map[string]string) map[string]string {
	out := make(map[string]string, len(envs))
	for k, v := range envs {
		out[k] = smartValue(k, v)
	}
	return out
}

func smartValue(key, value string) string {
	if !isPlaceholder(value) {
		return value // non-placeholder: keep exactly as specified in template
	}

	ku := strings.ToUpper(key)

	// Explicitly skip non-secret keys even when they have placeholder values
	for _, skip := range []string{"PORT", "HOST", "URL", "DOMAIN", "PATH", "DIR", "MODE", "ENABLED", "DB_NAME", "DATABASE", "DB_USER", "USERNAME"} {
		if strings.Contains(ku, skip) {
			return value // keep template value — user should configure these
		}
	}

	// Generate by key type
	switch {
	case strings.Contains(ku, "ROOT_PASSWORD") || strings.Contains(ku, "MASTER_PASSWORD"):
		// Root / master passwords: extra long hex
		return "dads-" + mustHex(20)

	case strings.Contains(ku, "PASSWORD") || strings.Contains(ku, "PASSWD"):
		// Regular passwords: readable prefix + random suffix
		return "dads-" + mustHex(12)

	case strings.Contains(ku, "ADMIN_TOKEN") || strings.Contains(ku, "ADMIN_SECRET"):
		// Admin tokens: very long (Vaultwarden ADMIN_TOKEN etc.)
		return mustHex(32)

	case strings.Contains(ku, "TOKEN"):
		return mustHex(24)

	case strings.Contains(ku, "SECRET"):
		return mustHex(20)

	case strings.Contains(ku, "KEY") && !strings.Contains(ku, "_ID"):
		// API keys, encryption keys, etc. (not KEY_ID which is an identifier)
		return mustHex(16)

	case strings.Contains(ku, "SALT"):
		return mustHex(16)

	default:
		return value // unknown placeholder — keep as-is, let user fill it in
	}
}

// isPlaceholder returns true when the value is clearly a stand-in that was
// never meant to be used in production.
func isPlaceholder(v string) bool {
	v = strings.TrimSpace(v)
	vu := strings.ToUpper(v)
	return v == "" ||
		strings.Contains(vu, "CHANGE_ME") ||
		strings.Contains(vu, "CHANGEME") ||
		strings.Contains(vu, "CHANGE-ME") ||
		strings.Contains(vu, "YOUR_") ||
		strings.Contains(vu, "REPLACE_ME") ||
		strings.Contains(vu, "REPLACE-ME") ||
		strings.HasPrefix(vu, "CHANGE") ||
		strings.EqualFold(v, "secret") ||
		strings.EqualFold(v, "password") ||
		strings.EqualFold(v, "changeme") ||
		strings.EqualFold(v, "todo") ||
		strings.EqualFold(v, "fixme")
}

// mustHex returns n random bytes encoded as lowercase hex (2n chars).
// Panics only on catastrophic OS entropy failure, which should never happen.
func mustHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// randomAlphaNum returns a random alphanumeric string of length n.
// Kept for potential future use.
func randomAlphaNum(n int) string { //nolint:unused
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, n)
	for i := range b {
		idx, _ := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
		b[i] = chars[idx.Int64()]
	}
	return string(b)
}
