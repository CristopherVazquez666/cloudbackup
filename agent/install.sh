#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  install.sh \
    --orchestrator-url https://backups.example.com \
    --server-slug my-server \
    --shared-secret SECRET \
    --remote-host 203.0.113.10 \
    --remote-user root \
    --remote-base-path /srv/bovedix-storage

Optional:
  --remote-port 22
  --poll-interval 15
  --install-dir /opt/bovedix-agent
  --local-temp-dir /var/tmp/bovedix-agent
  --pkgacct-path /scripts/pkgacct
  --insecure-tls
  --repo-owner CristopherVazquez666
  --repo-name cloudbackup
  --ref main
EOF
}

ORCHESTRATOR_URL=""
SERVER_SLUG=""
SHARED_SECRET=""
REMOTE_HOST=""
REMOTE_USER="root"
REMOTE_PORT="22"
REMOTE_BASE_PATH="/srv/bovedix-storage"
POLL_INTERVAL="15"
INSTALL_DIR="/opt/bovedix-agent"
LOCAL_TEMP_DIR="/var/tmp/bovedix-agent"
PKGACCT_PATH="/scripts/pkgacct"
TLS_REJECT_UNAUTHORIZED="1"
REPO_OWNER="CristopherVazquez666"
REPO_NAME="cloudbackup"
REF="main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --orchestrator-url) ORCHESTRATOR_URL="$2"; shift 2 ;;
    --server-slug) SERVER_SLUG="$2"; shift 2 ;;
    --shared-secret) SHARED_SECRET="$2"; shift 2 ;;
    --remote-host) REMOTE_HOST="$2"; shift 2 ;;
    --remote-user) REMOTE_USER="$2"; shift 2 ;;
    --remote-port) REMOTE_PORT="$2"; shift 2 ;;
    --remote-base-path) REMOTE_BASE_PATH="$2"; shift 2 ;;
    --poll-interval) POLL_INTERVAL="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --local-temp-dir) LOCAL_TEMP_DIR="$2"; shift 2 ;;
    --pkgacct-path) PKGACCT_PATH="$2"; shift 2 ;;
    --insecure-tls) TLS_REJECT_UNAUTHORIZED="0"; shift 1 ;;
    --repo-owner) REPO_OWNER="$2"; shift 2 ;;
    --repo-name) REPO_NAME="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$ORCHESTRATOR_URL" || -z "$SERVER_SLUG" || -z "$SHARED_SECRET" || -z "$REMOTE_HOST" ]]; then
  echo "Missing required arguments." >&2
  usage
  exit 1
fi

for cmd in curl node rsync ssh ssh-keygen systemctl; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Missing required command: $cmd" >&2
    exit 1
  }
done

NODE_BIN="$(command -v node)"

if [[ ! -x "$PKGACCT_PATH" ]]; then
  echo "pkgacct was not found at $PKGACCT_PATH" >&2
  exit 1
fi

RAW_BASE="https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REF}/agent"
BIN_DIR="${INSTALL_DIR}/bin"
ETC_DIR="${INSTALL_DIR}/etc"
KEY_DIR="${INSTALL_DIR}/keys"
LOG_DIR="${INSTALL_DIR}/var"
CONFIG_PATH="${ETC_DIR}/config.json"
AGENT_PATH="${BIN_DIR}/agent.js"
SERVICE_PATH="/etc/systemd/system/bovedix-agent.service"
KEY_PATH="${KEY_DIR}/id_ed25519"

mkdir -p "$BIN_DIR" "$ETC_DIR" "$KEY_DIR" "$LOG_DIR" "$LOCAL_TEMP_DIR"
chmod 700 "$ETC_DIR" "$KEY_DIR"

curl -fsSL "${RAW_BASE}/agent.js" -o "$AGENT_PATH"
chmod 755 "$AGENT_PATH"

if [[ ! -f "$KEY_PATH" ]]; then
  ssh-keygen -t ed25519 -N "" -f "$KEY_PATH" >/dev/null
fi
chmod 600 "$KEY_PATH"
chmod 644 "${KEY_PATH}.pub"

cat > "$CONFIG_PATH" <<EOF
{
  "orchestrator_url": "${ORCHESTRATOR_URL}",
  "server_slug": "${SERVER_SLUG}",
  "shared_secret": "${SHARED_SECRET}",
  "poll_interval_seconds": ${POLL_INTERVAL},
  "pkgacct_path": "${PKGACCT_PATH}",
  "local_temp_dir": "${LOCAL_TEMP_DIR}",
  "remote_host": "${REMOTE_HOST}",
  "remote_user": "${REMOTE_USER}",
  "remote_port": ${REMOTE_PORT},
  "remote_base_path": "${REMOTE_BASE_PATH}",
  "ssh_key_path": "${KEY_PATH}"
}
EOF
chmod 600 "$CONFIG_PATH"

cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=Bovedix Trial Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${AGENT_PATH}
WorkingDirectory=${INSTALL_DIR}
Restart=always
RestartSec=5
Environment=BOVEDIX_AGENT_CONFIG=${CONFIG_PATH}
Environment=NODE_TLS_REJECT_UNAUTHORIZED=${TLS_REJECT_UNAUTHORIZED}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable bovedix-agent >/dev/null

echo
echo "Bovedix agent installed."
echo "Config: ${CONFIG_PATH}"
echo "SSH public key:"
cat "${KEY_PATH}.pub"
echo
echo "Start the service with:"
echo "  systemctl start bovedix-agent"
echo
echo "Check the status with:"
echo "  systemctl status bovedix-agent --no-pager"
echo "  journalctl -u bovedix-agent -n 100 --no-pager"
