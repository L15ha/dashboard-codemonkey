#!/usr/bin/env bash
# =============================================================================
#  Installs the LMS progress sync job (systemd timer, every 15 minutes).
#
#  Usage (run on the EC2 host, once):
#    sudo bash deploy/install-progress-sync.sh      # prompts for the API key
#
#  - API key is stored in /etc/codemonkey/api.env (root-only, mode 600) and is
#    never copied into the web root.
#  - The job runs as an unprivileged system user and writes the anonymised
#    snapshot to /var/lib/codemonkey/progress.json, which nginx serves at
#    /progress/data/progress.json (see nginx.conf).
#  Re-running is safe; omit CM_API_KEY to keep the key already installed.
# =============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE=/etc/codemonkey/api.env

echo "==> Installing sync script"
apt-get install -y python3 >/dev/null
install -D -m 755 "$REPO_DIR/deploy/sync-progress.py" /usr/local/bin/codemonkey-sync-progress
id cmsync >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin cmsync

echo "==> Storing API key"
# dir is world-readable so cmsync can read hidden-names.txt; the key file itself stays 600 root
install -d -m 755 /etc/codemonkey
if [ -z "${CM_API_KEY:-}" ] && [ ! -f "$ENV_FILE" ]; then
  # prompt instead of passing the key on the command line (keeps it out of shell history)
  read -rsp "LMS API key: " CM_API_KEY; echo
fi
if [ -n "${CM_API_KEY:-}" ]; then
  umask 077
  printf 'CM_API_KEY=%s\n' "$CM_API_KEY" > "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

echo "==> Writing systemd units"
cat > /etc/systemd/system/codemonkey-progress.service <<UNIT
[Unit]
Description=Sync Code Monkey course progress from LMS
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=cmsync
EnvironmentFile=$ENV_FILE
ExecStart=/usr/local/bin/codemonkey-sync-progress
StateDirectory=codemonkey
StateDirectoryMode=0755
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6
UNIT

cat > /etc/systemd/system/codemonkey-progress.timer <<'UNIT'
[Unit]
Description=Sync Code Monkey course progress every 15 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now codemonkey-progress.timer
echo "==> Running first sync"
systemctl start codemonkey-progress.service
journalctl -u codemonkey-progress.service -n 3 --no-pager
echo "==> Done. Snapshot: /var/lib/codemonkey/progress.json"
