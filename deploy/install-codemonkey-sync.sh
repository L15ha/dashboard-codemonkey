#!/usr/bin/env bash
# =============================================================================
#  Switches the /progress/ data source from the LMS API to CodeMonkey's API
#  (codemonkey-cm.timer, every 5 minutes). Both jobs write the same snapshot file, so the
#  LMS timer is stopped here.
#
#  Usage (run on the EC2 host, after install-progress-sync.sh):
#    sudo bash deploy/install-codemonkey-sync.sh
#    sudo CM_CM_CREATED_FROM=2026-09-01 bash deploy/install-codemonkey-sync.sh
#                                   # only show one cohort (accounts created on/after the date)
#    sudo bash deploy/install-codemonkey-sync.sh --rollback   # back to the LMS job
#
#  Needs CM_CODEMONKEY_KEY in /etc/codemonkey/api.env (root-only, mode 600).
#  Optional: /etc/codemonkey/roster.csv (school/province), hidden-names.txt.
# =============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE=/etc/codemonkey/api.env
OPT_FILE=/etc/codemonkey/cm-sync.env

if [ "${1:-}" = "--rollback" ]; then
  echo "==> Switching back to the LMS sync"
  systemctl disable --now codemonkey-cm.timer 2>/dev/null || true
  rm -f /var/lib/codemonkey/cm-state.json
  systemctl enable --now codemonkey-progress.timer
  systemctl start codemonkey-progress.service
  journalctl -u codemonkey-progress.service -n 2 --no-pager -o cat
  exit 0
fi

grep -q '^CM_CODEMONKEY_KEY=' "$ENV_FILE" || { echo "!! CM_CODEMONKEY_KEY missing in $ENV_FILE" >&2; exit 1; }
id cmsync >/dev/null 2>&1 || { echo "!! run install-progress-sync.sh first (creates user cmsync)" >&2; exit 1; }

echo "==> Installing sync script"
install -D -m 755 "$REPO_DIR/deploy/sync-codemonkey.py" /usr/local/bin/codemonkey-sync-cm
# non-secret options, kept between runs; only the variables given on this run are replaced
touch "$OPT_FILE"; chmod 644 "$OPT_FILE"
for v in CM_CM_USERS_PATH CM_CM_CREATED_FROM; do
  if [ -n "${!v+x}" ]; then
    sed -i "/^$v=/d" "$OPT_FILE"
    printf '%s=%s\n' "$v" "${!v}" >> "$OPT_FILE"
  fi
done

echo "==> Writing systemd units"
cat > /etc/systemd/system/codemonkey-cm.service <<UNIT
[Unit]
Description=Sync Code Monkey course progress from CodeMonkey API
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=cmsync
EnvironmentFile=$ENV_FILE
EnvironmentFile=-$OPT_FILE
ExecStart=/usr/local/bin/codemonkey-sync-cm
TimeoutStartSec=30min
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

cat > /etc/systemd/system/codemonkey-cm.timer <<'UNIT'
[Unit]
Description=Sync Code Monkey course progress from CodeMonkey every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
echo "==> Running first sync (full; may take several minutes)"
if systemctl start codemonkey-cm.service; then
  journalctl -u codemonkey-cm.service -n 3 --no-pager -o cat
  echo "==> Switching timers: LMS off, CodeMonkey on"
  systemctl disable --now codemonkey-progress.timer 2>/dev/null || true
  systemctl enable --now codemonkey-cm.timer
  echo "==> Done. Rollback: sudo bash deploy/install-codemonkey-sync.sh --rollback"
else
  journalctl -u codemonkey-cm.service -n 20 --no-pager -o cat
  echo "!! First sync failed - LMS sync left running, nothing switched." >&2
  exit 1
fi
