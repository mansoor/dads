# DADS — Product Roadmap

**Docker App Deployment Simplified**
Last updated: May 2026

This roadmap defines the next six feature areas to take DADS from a solid self-hosted toolkit to a production-grade deployment platform. Each area is broken into incremental phases that can be built and merged independently.

---

## Current State (Phases 1–5 Complete)

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | Settings — Backup Targets (S3/SFTP) & Docker Registries | ✅ Done |
| 2 | Wizard — Registry dropdown from Settings | ✅ Done |
| 3 | Wizard — Env Vars & Volumes + Backup Configuration steps | ✅ Done |
| 4 | Workspace Restore from backup snapshot | ✅ Done |
| 5 | Docker & Host OS Housekeeping | ✅ Done |

---

## Phase 6 — Observability & Alerting

**Goal:** DADS tells you when something needs attention rather than waiting to be checked.

### 6a — Alert Rules Engine
Define threshold-based rules stored in the database. Each rule has a condition, a severity, and a cooldown period to prevent alert floods.

- DB table: `alert_rules` (id, name, condition_type, threshold, workspace, env, severity, cooldown_minutes, enabled)
- Condition types: `container_down`, `restart_count`, `disk_above_pct`, `backup_failed`, `image_update_available`, `cpu_above_pct`, `memory_above_pct`
- Backend: rule evaluator runs every 60 seconds via background goroutine
- API: `GET/POST/PUT/DELETE /api/alerts/rules`
- UI: Alert Rules tab in Settings page — add/edit/delete rules, toggle enabled

### 6b — Notification Channels
Allow multiple outbound delivery methods. Each channel is tested before saving.

- DB table: `notification_channels` (id, name, type, config_json, enabled)
- Channel types: `email` (SMTP), `slack` (webhook URL), `webhook` (generic HTTP POST), `discord`
- Backend: `POST /api/alerts/channels/{id}/test` — sends a test notification
- UI: Notification Channels tab in Settings — add/edit/delete/test channels, assign to alert rules

### 6c — Alert History & Inbox
Track every fired alert so nothing is missed. Alerts are dismissible from the UI.

- DB table: `alert_events` (id, rule_id, workspace, env, message, severity, fired_at, resolved_at, dismissed)
- API: `GET /api/alerts/events` — filterable by workspace, severity, resolved
- UI: Alert bell icon in top nav with badge count; slide-out Alert Inbox panel
- Auto-resolve: when condition clears, mark event as resolved and optionally send all-clear notification

### 6d — Metrics History
Store lightweight time-series snapshots for trend graphs.

- DB table: `metrics_snapshots` (id, workspace, env, cpu_pct, memory_bytes, disk_bytes, recorded_at)
- Background collector: samples every 5 minutes per running environment using existing `docker stats`
- API: `GET /api/workspaces/{name}/envs/{env}/metrics?range=7d`
- UI: Sparkline charts on WorkspacePage env cards (CPU, memory, disk over 7/30 days)
- Retention: prune snapshots older than 90 days automatically

### 6e — Dashboard Alert Summary
Surface health status directly on the main Dashboard.

- Dashboard stat cards gain colour-coded borders (green/amber/red) based on active alerts
- New "Alerts" stat card showing total active, warning, critical counts
- Workspace table row highlights for any workspace with active critical alerts
- One-click dismiss from the dashboard row

---

## Phase 7 — Multi-Host Support

**Goal:** Manage Docker workloads across multiple servers from a single DADS instance.

### 7a — Host Registration
Store remote host connection details securely and verify connectivity.

- DB table: `hosts` (id, name, address, ssh_port, ssh_user, ssh_key_encrypted, created_at)
- SSH key stored encrypted using the JWT secret as the encryption key
- API: `GET/POST/PUT/DELETE /api/hosts`, `POST /api/hosts/{id}/test`
- UI: Hosts tab in Settings — add/edit/delete hosts, test SSH connection with live output

### 7b — Remote Workspace Discovery
Scan a registered host and import its workspaces into the DADS database.

- Backend: SSH into host, list `WORKSPACES_DIR`, read each `config.json`
- API: `POST /api/hosts/{id}/scan` — returns list of discovered workspaces
- `POST /api/hosts/{id}/import` — registers discovered workspaces under the host
- UI: "Scan Host" button in host detail — shows discovered workspaces with import checkboxes

### 7c — Host Health Dashboard
Per-host overview panel showing aggregate metrics for that server.

- API: `GET /api/hosts/{id}/stats` — runs `docker info`, `df`, `free` over SSH
- UI: Hosts page with per-host stat cards (Docker containers, images, disk, memory)
- Host status dot in sidebar (green/amber/red based on connectivity and disk)
- Summary row per host on the main Dashboard

### 7d — Cross-Host Operations
Execute workspace actions (deploy, backup, restart) on remote hosts.

- Shell bridge extended: remote operations execute via SSH rather than local subprocess
- Target host resolved from workspace metadata
- UI: WorkspacePage unchanged — host is transparent to the user
- Activity log records host name alongside workspace/env/command

### 7e — Workspace Migration
Move a workspace configuration and its latest backup from one host to another.

- API: `POST /api/workspaces/{name}/migrate` (body: `{ "target_host_id": N }`)
- Flow: backup source → transfer archive via SSH → bootstrap on target → verify
- UI: "Migrate" option in workspace Danger Zone — target host dropdown, progress stream

---

## Phase 8 — Secrets Management

**Goal:** Sensitive values are encrypted at rest and never exposed in logs or API responses by default.

### 8a — Encrypted Secret Storage
Introduce a secret flag per environment variable. Flagged values are encrypted in `config.json` using AES-256-GCM with a workspace-specific derived key.

- Encryption key derived from `JWT_SECRET + workspace_name` using HKDF
- `config.json` env_vars: values prefixed with `enc:` are encrypted blobs
- Backend: `workspace.EncryptSecret(key, plaintext)` / `DecryptSecret(key, blob)`
- Existing `GetEnvVars` API: encrypted values returned as `***` unless `?reveal=true` + valid JWT
- `UpdateEnvVars` API: values flagged as secret are encrypted before writing

### 8b — Secret Flags in Env Vars UI
Surface the secret/plain distinction cleanly in the existing env var editor.

- EnvVarsModal: lock icon toggle per row — click to flag/unflag as secret
- Flagged rows show value as `••••••••` by default; "Show values" checkbox sends `?reveal=true`
- NewWorkspacePage Step 4: key/value rows gain the same lock icon toggle
- Visual distinction: secret rows have a subtle amber left border

### 8c — Secret Rotation Workflow
Guided flow to update a secret value without exposing the old one in history.

- UI: "Rotate" action per secret row — opens a form with just the new value field
- Backend: `POST /api/workspaces/{name}/envs/{env}/rotate` — accepts `{ key, new_value }`
- After rotation: automatically restarts affected services via `deploy.sh restart`
- Audit log entry records rotation (key name only, never value)

### 8d — Secret Audit Trail
Every read and write of a secret-flagged key is recorded.

- DB table: `secret_events` (id, workspace, env, key, action, username, ip, created_at)
- Actions: `read`, `write`, `rotate`, `delete`
- API: `GET /api/workspaces/{name}/envs/{env}/secret-events`
- UI: per-key audit icon that opens an event timeline in a modal

### 8e — Vault Integration (Optional)
Use HashiCorp Vault or a compatible API as a drop-in secret backend instead of encrypted `config.json`.

- Config: `SECRETS_BACKEND=vault`, `VAULT_ADDR`, `VAULT_TOKEN` environment variables
- Backend: `internal/secrets` package with interface — `LocalBackend` (default) and `VaultBackend`
- Workspaces transparently read/write secrets through the interface regardless of backend
- UI: Settings > Secrets tab showing active backend and connection status

---

## Phase 9 — Deployment Pipelines

**Goal:** Automate the path from code push to live deployment without leaving DADS.

### 9a — Webhook Receiver
Accept inbound push events from GitHub, Gitea, or any generic webhook source.

- API: `POST /api/webhooks/receive/{token}` — token-authenticated, no JWT needed
- DB table: `webhooks` (id, name, token, workspace, pipeline_id, secret, enabled)
- Webhook token generated on creation, displayed once, stored hashed
- Validate GitHub/Gitea signature (HMAC-SHA256) when `secret` is set
- UI: Webhooks tab in Settings — create webhook, copy URL + token, view recent deliveries

### 9b — Pipeline Definition
Define multi-stage pipelines attached to a workspace. Each stage maps to an existing run.sh command or a shell script.

- DB table: `pipelines` (id, workspace, name, stages_json, created_at)
- Stage types: `build`, `push`, `deploy`, `test`, `notify`, `promote`
- Each stage: `{ type, env, command, on_failure: "stop|continue", timeout_seconds }`
- API: `GET/POST/PUT/DELETE /api/pipelines`
- UI: Pipeline editor in workspace settings — drag-to-reorder stages, per-stage config

### 9c — Pipeline Execution & Logs
Run a pipeline and stream its output stage by stage.

- API: `POST /api/pipelines/{id}/run` — triggers execution, returns run ID
- `GET /api/pipelines/runs/{run_id}` — run status + per-stage results
- Execution streams output via existing action WebSocket pattern
- DB table: `pipeline_runs` (id, pipeline_id, trigger, status, started_at, finished_at, stages_json)
- UI: Pipeline Runs list per workspace — expand to see per-stage pass/fail and logs

### 9d — Promote Gate
Add a manual approval step between staging and production deployments.

- Stage type: `gate` — pauses the pipeline and waits for approval
- API: `POST /api/pipelines/runs/{run_id}/approve` / `reject`
- UI: Pending gates surface as a notification in the top bar; one-click approve/reject with a comment field
- Timeout: gates auto-reject after a configurable period (default 24h)

### 9e — Rollback
Revert a deployment to the previous image tag with one click.

- Backend tracks the last-deployed image tag per workspace/env in `config.json` as `previous_tag`
- API: `POST /api/workspaces/{name}/envs/{env}/rollback`
- Flow: re-tag images to `previous_tag` → `deploy.sh update` → update `previous_tag` swap
- UI: "Rollback" button in env card action menu (shown only if `previous_tag` exists); confirmation modal showing old vs new tag

---

## Phase 10 — User Management & RBAC

**Goal:** Safe team access — not everyone needs (or should have) admin rights.

### 10a — User CRUD
Full user management UI instead of only allowing password changes.

- API: `GET /api/users`, `POST /api/users`, `PUT /api/users/{id}`, `DELETE /api/users/{id}`
- Fields: username, role, created_at, last_login_at
- Prevent deleting the last admin account
- UI: Users tab in Settings — table of users with role badge, add/edit/deactivate

### 10b — Role Definitions
Three built-in roles with clear capability boundaries.

| Role | Capabilities |
|------|-------------|
| `viewer` | Read workspaces, view logs, view backups. No actions. |
| `operator` | All viewer rights + deploy, restart, stop, backup, restore. Cannot create/delete workspaces or change settings. |
| `admin` | Full access including user management, settings, housekeeping, delete workspace. |

- JWT claims include `role`; middleware enforces per-endpoint
- Backend: `RequireRole("admin")` middleware helper used on destructive endpoints

### 10c — Per-Workspace ACL
Restrict which workspaces a user can see and act on.

- DB table: `workspace_acl` (user_id, workspace_name, role_override)
- `role_override` can be higher or lower than the user's global role
- `GET /api/workspaces` filters results by ACL for non-admin users
- UI: workspace settings > Access tab — assign users with role picker

### 10d — SSO Integration
Support OIDC-compatible identity providers (Google, GitHub, Okta, Authentik).

- Config: `AUTH_OIDC_ISSUER`, `AUTH_OIDC_CLIENT_ID`, `AUTH_OIDC_CLIENT_SECRET`
- Backend: standard OIDC auth code flow; maps `email` claim to a DADS user
- First OIDC login auto-provisions a user with `viewer` role (configurable default)
- UI: Login page shows "Sign in with SSO" button when OIDC is configured; local login still available

### 10e — Session Management
Give admins visibility and control over active sessions.

- DB table: `sessions` (id, user_id, ip, user_agent, created_at, last_seen_at, revoked)
- Refresh token rotation already stores tokens; extend to track sessions
- API: `GET /api/users/me/sessions`, `DELETE /api/users/me/sessions/{id}` (force logout)
- Admin: `GET /api/users/{id}/sessions` — view and revoke any user's sessions
- UI: "Active sessions" section in user profile dropdown

---

## Phase 11 — Backup Verification & Scheduling

**Goal:** Close the loop on backups — automated, verified, and visible across all workspaces.

### 11a — Automated Backup Scheduling
Use the backup configuration stored in Phase 3 (wizard Step 5) to run backups automatically.

- Background scheduler reads `config.backup.schedule` per workspace per env
- Supported values: `daily` (03:00 UTC), `weekly` (Sunday 03:00 UTC), `manual` (no auto-run)
- Uses existing `run.sh backup` via shell bridge
- Logs result to `housekeeping_log` with workspace/env context
- UI: WorkspacePage env card shows "Next backup: tomorrow 03:00" badge when schedule is active

### 11b — Backup Health Dashboard
Cross-workspace view showing backup coverage and staleness.

- API: extend `GET /api/backups` to include `last_backup_age_hours` and `expected_schedule`
- Health states: `current` (within schedule window), `stale` (overdue), `never` (no backups yet), `disabled`
- UI: New "Backup Coverage" panel in Dashboard — table showing each workspace/env with health dot, last backup date, next scheduled run
- Alert rule integration (Phase 6a): `backup_failed` and `backup_stale` condition types

### 11c — Restore Dry-Run
Validate a backup snapshot is complete and restorable before committing.

- API: `POST /api/workspaces/{name}/envs/{env}/restore-verify` (body: `{ "date": "..." }`)
- Backend: checks all expected dump files are present and non-empty; tests gzip integrity; verifies volumes exist
- Does NOT stop or modify the running environment
- Returns a report: files found/missing, integrity status, estimated restore time
- UI: "Verify" button alongside each "Restore" button in the Backup History panel — shows verification report in a modal before the user decides to proceed

### 11d — Remote Target Sync
Push local backup snapshots to the configured S3 or SFTP backup target.

- Backend: `scripts/backup-sync.sh` — reads `config.backup.target_id` and syncs to that target
- S3: uses `aws s3 cp` or `rclone` (whichever is available)
- SFTP: uses `rsync` over SSH or `sftp` batch commands
- API: `POST /api/workspaces/{name}/envs/{env}/backup-sync` — triggers sync for latest snapshot
- Sync result logged; UI shows "synced to S3" badge on backup rows that have been pushed remotely

### 11e — Backup Retention Enforcement
Apply the retention count from `config.backup.retention` automatically after each backup run.

- Post-backup hook in `backup.sh`: prune snapshots exceeding retention count (currently hard-coded to 30 days — make it count-based per workspace config)
- API: `GET /api/workspaces/{name}/envs/{env}/backup-stats` — count, total size, oldest, newest
- UI: WorkspacePage env card shows backup count and total size; retention limit shown next to it

---

## Priority Order Summary

| Phase | Feature | Complexity | Impact |
|-------|---------|------------|--------|
| 6 | Observability & Alerting | Medium | 🔥 Highest — changes operational posture |
| 7 | Multi-Host Support | High | High — unlocks fleet management |
| 8 | Secrets Management | Medium | High — security baseline for teams |
| 9 | Deployment Pipelines | High | High — removes last manual step |
| 10 | User Management & RBAC | Low-Medium | Medium — required for team use |
| 11 | Backup Verification & Scheduling | Low | Medium — completes the backup loop |

Phases 10 and 11 are low-complexity and could be implemented in parallel with any higher phase as filler work between larger efforts.
