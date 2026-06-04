package db

import (
	"database/sql"
	"fmt"
	"path/filepath"

	_ "modernc.org/sqlite"
)

type DB struct {
	*sql.DB
}

func Open(dataDir string) (*DB, error) {
	path := filepath.Join(dataDir, "dads-ui.db")
	conn, err := sql.Open("sqlite", path+"?_journal_mode=WAL&_foreign_keys=on")
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	conn.SetMaxOpenConns(1) // SQLite is single-writer
	d := &DB{conn}
	if err := d.migrate(); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return d, nil
}

func (d *DB) migrate() error {
	_, err := d.Exec(`
		CREATE TABLE IF NOT EXISTS users (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			username   TEXT    NOT NULL UNIQUE,
			password   TEXT    NOT NULL,
			role       TEXT    NOT NULL DEFAULT 'admin',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS audit_log (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id     INTEGER REFERENCES users(id),
			username    TEXT,
			workspace   TEXT,
			command     TEXT,
			env         TEXT,
			created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS backup_targets (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			name       TEXT    NOT NULL UNIQUE,
			type       TEXT    NOT NULL,
			config     TEXT    NOT NULL DEFAULT '{}',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS docker_registries (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			name       TEXT    NOT NULL UNIQUE,
			url        TEXT    NOT NULL,
			username   TEXT    NOT NULL,
			password   TEXT    NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS housekeeping_log (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			task         TEXT    NOT NULL,
			trigger      TEXT    NOT NULL DEFAULT 'manual',
			status       TEXT    NOT NULL DEFAULT 'ok',
			output       TEXT,
			freed_bytes  INTEGER DEFAULT 0,
			items_removed INTEGER DEFAULT 0,
			created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS app_settings (
			key        TEXT PRIMARY KEY,
			value      TEXT NOT NULL DEFAULT '',
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS template_usage (
			name         TEXT PRIMARY KEY,
			use_count    INTEGER  NOT NULL DEFAULT 1,
			last_used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		);

		-- ── Phase 6: Observability & Alerting ──────────────────────────────────
		-- 6a: Alert rules. A rule targets a workspace+env (specific), a workspace
		-- (all its envs), or nothing (all workspaces). condition_type drives which
		-- metric the evaluator reads; threshold is used by the numeric conditions
		-- (restart_count, *_above_pct) and ignored by the boolean ones.
		CREATE TABLE IF NOT EXISTS alert_rules (
			id               INTEGER PRIMARY KEY AUTOINCREMENT,
			name             TEXT    NOT NULL,
			condition_type   TEXT    NOT NULL,
			threshold        REAL    NOT NULL DEFAULT 0,
			workspace        TEXT    NOT NULL DEFAULT '',
			env              TEXT    NOT NULL DEFAULT '',
			severity         TEXT    NOT NULL DEFAULT 'warning',
			cooldown_minutes INTEGER NOT NULL DEFAULT 15,
			enabled          INTEGER NOT NULL DEFAULT 1,
			created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		-- 6c: Alert events (history + inbox). Rule fields are denormalised so an
		-- event survives deletion of its rule. resolved_at IS NULL ⇒ still active;
		-- dismissed=1 ⇒ acknowledged (drops out of the unread badge count).
		CREATE TABLE IF NOT EXISTS alert_events (
			id             INTEGER PRIMARY KEY AUTOINCREMENT,
			rule_id        INTEGER REFERENCES alert_rules(id) ON DELETE SET NULL,
			rule_name      TEXT    NOT NULL DEFAULT '',
			condition_type TEXT    NOT NULL DEFAULT '',
			workspace      TEXT    NOT NULL DEFAULT '',
			env            TEXT    NOT NULL DEFAULT '',
			message        TEXT    NOT NULL,
			severity       TEXT    NOT NULL DEFAULT 'warning',
			value          REAL    NOT NULL DEFAULT 0,
			fired_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
			resolved_at    DATETIME,
			dismissed      INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_alert_events_open
			ON alert_events(rule_id, workspace, env, resolved_at);
		CREATE INDEX IF NOT EXISTS idx_alert_events_inbox
			ON alert_events(dismissed, fired_at);

		-- backup_log: per-env backup outcomes. The shell-bridge backup action
		-- records success/failure here so the backup_failed alert condition has a
		-- source (audit_log only records that a backup ran, not whether it worked).
		-- Also seeds Phase 11 (Backup Verification & Scheduling).
		CREATE TABLE IF NOT EXISTS backup_log (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			workspace  TEXT    NOT NULL,
			env        TEXT    NOT NULL,
			status     TEXT    NOT NULL DEFAULT 'ok',
			message    TEXT    NOT NULL DEFAULT '',
			size_bytes INTEGER NOT NULL DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_backup_log_target
			ON backup_log(workspace, env, created_at);
	`)
	return err
}

// IsSetupRequired returns true when no users exist yet (first run).
func (d *DB) IsSetupRequired() (bool, error) {
	var count int
	err := d.QueryRow("SELECT COUNT(*) FROM users").Scan(&count)
	return count == 0, err
}
