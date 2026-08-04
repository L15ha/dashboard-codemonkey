#!/usr/bin/env bash
# =============================================================================
#  Update deploy: sync the latest site files into the web root and reload.
#  Run on the EC2 host after `git pull` (or called by CI over SSH).
# =============================================================================
set -euo pipefail

APP_DIR="/var/www/codemonkey"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Syncing ${REPO_DIR} -> ${APP_DIR}"
sudo rsync -a --delete \
  --exclude '.git' --exclude 'deploy' --exclude '.github' \
  --exclude 'README.md' --exclude '*.md' \
  "$REPO_DIR"/ "$APP_DIR"/

sudo chown -R www-data:www-data "$APP_DIR"
sudo find "$APP_DIR" -type d -exec chmod 755 {} \;
sudo find "$APP_DIR" -type f -exec chmod 644 {} \;

echo "==> Reloading nginx"
sudo nginx -t && sudo systemctl reload nginx
echo "==> Deployed."
