#!/usr/bin/env bash
# =============================================================================
# DADS — Docker App Deployment Simplified
# One-line installer
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/mansoor/dads/main/install.sh | bash
#
# Environment variable overrides (prefix the one-liner):
#   DADS_DIR=/opt/dads        — where to clone the repo   (default: ~/dads)
#   DADS_PORT=8080            — UI host port               (default: 8080)
#   DADS_BRANCH=main          — git branch to install      (default: main)
#   DADS_REPO=<url>           — git clone URL              (default: GitHub HTTPS)
#   ACME_EMAIL=you@email.com  — Let's Encrypt contact email
#   SKIP_DOCKER=1             — skip Docker installation check
#
# Example with overrides:
#   curl -sSL https://raw.githubusercontent.com/mansoor/dads/main/install.sh \
#     | DADS_DIR=/opt/dads DADS_PORT=9090 ACME_EMAIL=admin@example.com bash
# =============================================================================

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────

DADS_REPO="${DADS_REPO:-https://github.com/mansoor/dads.git}"
DADS_DIR="${DADS_DIR:-$HOME/dads}"
DADS_PORT="${DADS_PORT:-8080}"
DADS_BRANCH="${DADS_BRANCH:-main}"
ACME_EMAIL="${ACME_EMAIL:-}"
SKIP_DOCKER="${SKIP_DOCKER:-0}"

# ── Colour helpers ─────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[DADS]${RESET}  $*"; }
success() { echo -e "${GREEN}[DADS]${RESET}  $*"; }
warn()    { echo -e "${YELLOW}[DADS]${RESET}  $*"; }
die()     { echo -e "${RED}[DADS]${RESET}  ERROR: $*" >&2; exit 1; }
step()    { echo -e "\n${BOLD}${CYAN}▶ $*${RESET}"; }

# ── OS detection ──────────────────────────────────────────────────────────────

detect_os() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "macos"
  elif [[ -f /etc/os-release ]]; then
    # shellcheck source=/dev/null
    source /etc/os-release
    case "${ID:-}" in
      ubuntu|debian|linuxmint|pop)  echo "debian" ;;
      centos|rhel|almalinux|rocky|fedora|amzn) echo "rhel" ;;
      arch|manjaro)                  echo "arch" ;;
      alpine)                        echo "alpine" ;;
      *)                             echo "unknown" ;;
    esac
  else
    echo "unknown"
  fi
}

OS=$(detect_os)
info "Detected OS: ${OS}"

# ── Privilege helper ──────────────────────────────────────────────────────────

# Use sudo only when not already root
maybe_sudo() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

# ── Dependency checks & installation ─────────────────────────────────────────

need() { command -v "$1" &>/dev/null; }

install_pkg_debian() {
  maybe_sudo apt-get update -qq
  maybe_sudo apt-get install -y -qq "$@"
}

install_pkg_rhel() {
  if need dnf; then
    maybe_sudo dnf install -y -q "$@"
  else
    maybe_sudo yum install -y -q "$@"
  fi
}

install_pkg_arch() {
  maybe_sudo pacman -Sy --noconfirm --needed "$@"
}

install_pkg_alpine() {
  maybe_sudo apk add --no-cache "$@"
}

install_pkg() {
  case "$OS" in
    debian) install_pkg_debian "$@" ;;
    rhel)   install_pkg_rhel   "$@" ;;
    arch)   install_pkg_arch   "$@" ;;
    alpine) install_pkg_alpine "$@" ;;
    macos)
      if need brew; then
        brew install "$@" 2>/dev/null || true
      else
        warn "Homebrew not found. Install it from https://brew.sh then re-run."
      fi
      ;;
    *) warn "Unknown OS — cannot auto-install $*. Please install manually." ;;
  esac
}

step "Checking required tools"

# git
if ! need git; then
  info "Installing git…"
  install_pkg git
fi
success "git $(git --version | awk '{print $3}')"

# curl
if ! need curl; then
  info "Installing curl…"
  install_pkg curl
fi
success "curl $(curl --version | head -1 | awk '{print $2}')"

# jq
if ! need jq; then
  info "Installing jq…"
  install_pkg jq
fi
success "jq $(jq --version)"

# openssl
if ! need openssl; then
  info "Installing openssl…"
  install_pkg openssl
fi
success "openssl $(openssl version | awk '{print $2}')"

# bash 4+ (macOS ships bash 3.2)
BASH_MAJ=$(bash --version | head -1 | grep -oE '[0-9]+\.[0-9]+' | head -1 | cut -d. -f1)
if [[ "${BASH_MAJ:-3}" -lt 4 && "$OS" == "macos" ]]; then
  warn "macOS ships Bash 3.2. Some DADS scripts work best with Bash 4+."
  warn "Run: brew install bash"
fi

# ── Docker ────────────────────────────────────────────────────────────────────

if [[ "$SKIP_DOCKER" != "1" ]]; then
  step "Checking Docker"

  if ! need docker; then
    info "Docker not found — installing…"
    case "$OS" in
      debian|rhel)
        # Official convenience script — works on Debian/Ubuntu/CentOS/RHEL/Fedora
        curl -fsSL https://get.docker.com | maybe_sudo sh
        ;;
      arch)
        install_pkg docker
        maybe_sudo systemctl enable --now docker
        ;;
      alpine)
        install_pkg docker
        maybe_sudo rc-update add docker default
        maybe_sudo service docker start
        ;;
      macos)
        die "Docker Desktop is required on macOS. Download from https://www.docker.com/products/docker-desktop"
        ;;
      *)
        die "Cannot auto-install Docker on this OS. Install from https://docs.docker.com/get-docker/ then re-run."
        ;;
    esac

    # Add current user to the docker group (Linux only)
    if [[ "$OS" != "macos" ]] && [[ "$(id -u)" -ne 0 ]]; then
      maybe_sudo usermod -aG docker "$USER" 2>/dev/null || true
      warn "You have been added to the 'docker' group. You may need to log out and back in for this to take effect."
      warn "For this session, subsequent docker commands will use sudo automatically."
    fi

    # Start Docker daemon (Linux)
    if [[ "$OS" != "macos" ]]; then
      if need systemctl; then
        maybe_sudo systemctl enable --now docker 2>/dev/null || true
      fi
    fi
  fi

  # Verify Docker is reachable
  if ! docker info &>/dev/null; then
    if [[ "$(id -u)" -ne 0 ]]; then
      # Try with sudo as fallback before failing
      if sudo docker info &>/dev/null; then
        warn "Docker requires sudo for this session. Consider logging out/in to apply group membership."
        DOCKER_CMD="sudo docker"
      else
        die "Docker daemon is not running. Start it with: sudo systemctl start docker"
      fi
    else
      die "Docker daemon is not running. Start it with: systemctl start docker"
    fi
  else
    DOCKER_CMD="docker"
  fi

  DOCKER_VER=$($DOCKER_CMD version --format '{{.Server.Version}}' 2>/dev/null || echo "unknown")
  success "Docker ${DOCKER_VER}"

  # ── Docker Compose v2 ──────────────────────────────────────────────────────

  step "Checking Docker Compose v2"

  if ! $DOCKER_CMD compose version &>/dev/null; then
    info "Docker Compose v2 plugin not found — installing…"
    case "$OS" in
      debian)
        install_pkg docker-compose-plugin
        ;;
      rhel)
        install_pkg docker-compose-plugin 2>/dev/null || \
          install_pkg docker-compose 2>/dev/null || true
        ;;
      arch)
        install_pkg docker-compose
        ;;
      alpine)
        install_pkg docker-compose
        ;;
      *)
        # Fallback: download the binary directly
        COMPOSE_VER=$(curl -sSf "https://api.github.com/repos/docker/compose/releases/latest" \
          | grep '"tag_name"' | head -1 | grep -oE 'v[0-9.]+')
        COMPOSE_ARCH=$(uname -m | sed 's/x86_64/x86_64/;s/aarch64/aarch64/;s/armv7l/armv7/')
        COMPOSE_URL="https://github.com/docker/compose/releases/download/${COMPOSE_VER}/docker-compose-linux-${COMPOSE_ARCH}"
        PLUGIN_DIR="${HOME}/.docker/cli-plugins"
        mkdir -p "$PLUGIN_DIR"
        curl -sSfL "$COMPOSE_URL" -o "${PLUGIN_DIR}/docker-compose"
        chmod +x "${PLUGIN_DIR}/docker-compose"
        ;;
    esac
  fi

  if ! $DOCKER_CMD compose version &>/dev/null; then
    die "Docker Compose v2 is required but could not be installed. See https://docs.docker.com/compose/install/"
  fi

  COMPOSE_VER=$($DOCKER_CMD compose version --short 2>/dev/null || echo "installed")
  success "Docker Compose v${COMPOSE_VER}"
else
  DOCKER_CMD="docker"
fi

# ── Clone or update repo ──────────────────────────────────────────────────────

step "Setting up DADS in ${DADS_DIR}"

if [[ -d "${DADS_DIR}/.git" ]]; then
  info "Repository already exists — pulling latest changes on branch ${DADS_BRANCH}…"
  git -C "$DADS_DIR" fetch --quiet origin
  git -C "$DADS_DIR" checkout --quiet "${DADS_BRANCH}"
  git -C "$DADS_DIR" pull --quiet --ff-only origin "${DADS_BRANCH}" || \
    warn "Could not fast-forward; your local changes may conflict."
  success "Repository updated"
else
  info "Cloning ${DADS_REPO} → ${DADS_DIR}…"
  git clone --quiet --branch "${DADS_BRANCH}" "${DADS_REPO}" "${DADS_DIR}"
  success "Repository cloned"
fi

# ── Generate configuration ────────────────────────────────────────────────────

ENV_FILE="${DADS_DIR}/dads-ui/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  step "Generating configuration"

  JWT_SECRET=$(openssl rand -hex 32)

  cat > "$ENV_FILE" <<EOF
# Auto-generated by DADS installer — $(date -u '+%Y-%m-%d %H:%M UTC')

# Port to expose the DADS UI on the host
DADS_UI_PORT=${DADS_PORT}

# JWT signing secret — do not share or commit this value
JWT_SECRET=${JWT_SECRET}

# Let's Encrypt contact email (required for SSL certificates on workspace domains)
ACME_EMAIL=${ACME_EMAIL:-your@email.com}
EOF

  success "Configuration written to ${ENV_FILE}"
  [[ -z "$ACME_EMAIL" ]] && warn "ACME_EMAIL not set — edit ${ENV_FILE} before using SSL certificates"
else
  info "Configuration file already exists — skipping generation"
  # Ensure DADS_UI_PORT is up to date if user passed a custom port
  if [[ "$DADS_PORT" != "8080" ]]; then
    sed -i.bak "s/^DADS_UI_PORT=.*/DADS_UI_PORT=${DADS_PORT}/" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  fi
fi

# ── Docker network ────────────────────────────────────────────────────────────

step "Ensuring traefik_net network exists"

if ! $DOCKER_CMD network inspect traefik_net &>/dev/null; then
  $DOCKER_CMD network create traefik_net
  success "Created traefik_net network"
else
  success "traefik_net network already exists"
fi

# ── Build and start ───────────────────────────────────────────────────────────

step "Building and starting DADS"

# The toolkit scripts are baked into the image (Phase 6.5d) — the build context
# is the repo root, so no separate scripts mount is needed.
cd "${DADS_DIR}/dads-ui"
$DOCKER_CMD compose up --build -d

# ── Install the `dads` CLI wrapper ────────────────────────────────────────────

step "Installing the dads CLI"

if [[ -f "${DADS_DIR}/dads.sh" ]]; then
  chmod +x "${DADS_DIR}/dads.sh"
  if maybe_sudo ln -sf "${DADS_DIR}/dads.sh" /usr/local/bin/dads 2>/dev/null; then
    success "Installed 'dads' CLI to /usr/local/bin/dads"
  else
    warn "Could not install to /usr/local/bin — run DADS commands with: ${DADS_DIR}/dads.sh"
  fi
fi

# ── Post-install summary ──────────────────────────────────────────────────────

HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}') || HOST_IP="localhost"

echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}${BOLD}║          DADS installed successfully!                    ║${RESET}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${BOLD}Local access:${RESET}     http://localhost:${DADS_PORT}"
echo -e "  ${BOLD}Network access:${RESET}   http://${HOST_IP}:${DADS_PORT}"
echo ""
echo -e "  ${BOLD}Installation:${RESET}     ${DADS_DIR}"
echo -e "  ${BOLD}Configuration:${RESET}    ${ENV_FILE}"
echo ""
echo -e "  On first visit, you will be prompted to create an admin account."
echo ""
echo -e "  ${YELLOW}Note:${RESET} Traefik is running and listening on ports 80 and 443."
echo -e "  Ensure these ports are available if you plan to use domain routing."
echo ""
echo -e "  ${BOLD}CLI:${RESET}              dads login  →  dads start <workspace> <env>   (run 'dads help')"
echo ""
echo -e "  ${BOLD}Useful commands:${RESET}"
echo -e "    Stop:    cd ${DADS_DIR}/dads-ui && docker compose down"
echo -e "    Start:   cd ${DADS_DIR}/dads-ui && docker compose up -d"
echo -e "    Update:  cd ${DADS_DIR} && git pull && cd dads-ui && docker compose up --build -d"
echo -e "    Logs:    cd ${DADS_DIR}/dads-ui && docker compose logs -f dads-ui"
echo ""
