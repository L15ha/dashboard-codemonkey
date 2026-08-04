#!/usr/bin/env bash
# =============================================================================
#  One-time server setup for the Code Monkey dashboard on Ubuntu (EC2).
#  Installs nginx + certbot, deploys the site, and issues a TLS certificate.
#
#  Usage (run on the EC2 instance as a sudo-capable user):
#    sudo DOMAIN=dashboard.example.com EMAIL=you@example.com bash setup-server.sh
#
#  If you don't have a domain yet, you can skip TLS by omitting DOMAIN; the
#  site will serve over HTTP only (not recommended for production).
# =============================================================================
set -euo pipefail

APP_DIR="/var/www/codemonkey"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Updating packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx ufw fail2ban rsync

echo "==> Deploying site files to ${APP_DIR}"
mkdir -p "$APP_DIR" /var/www/certbot
rsync -a --delete \
  --exclude '.git' --exclude 'deploy' --exclude '.github' \
  --exclude 'README.md' --exclude '*.md' \
  "$REPO_DIR"/ "$APP_DIR"/
chown -R www-data:www-data "$APP_DIR"
find "$APP_DIR" -type d -exec chmod 755 {} \;
find "$APP_DIR" -type f -exec chmod 644 {} \;

echo "==> Configuring nginx"
SITE=/etc/nginx/sites-available/codemonkey
cp "$REPO_DIR/deploy/nginx.conf" "$SITE"
if [ -n "${DOMAIN:-}" ]; then
  sed -i "s/DOMAIN_PLACEHOLDER/${DOMAIN}/g" "$SITE"
else
  echo "!! No DOMAIN set — installing HTTP-only config"
  # strip the HTTPS server block; keep a plain HTTP server
  cat > "$SITE" <<'HTTPONLY'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    root /var/www/codemonkey;
    index index.html;
    server_tokens off;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    location ~ /\.(?!well-known) { deny all; }
    location / { try_files $uri $uri/ =404; }
}
HTTPONLY
fi
ln -sf "$SITE" /etc/nginx/sites-enabled/codemonkey
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
systemctl enable nginx

echo "==> Applying firewall + SSH hardening"
bash "$REPO_DIR/deploy/harden.sh"

if [ -n "${DOMAIN:-}" ] && [ -n "${EMAIL:-}" ]; then
  echo "==> Issuing TLS certificate via Let's Encrypt for ${DOMAIN}"
  apt-get install -y certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --non-interactive --redirect || {
    echo "!! certbot failed — check that ${DOMAIN} points to this server's public IP and port 80 is open."
  }
  systemctl reload nginx
else
  echo "!! Skipping TLS (need both DOMAIN and EMAIL). Re-run with them set once DNS is ready."
fi

echo "==> Done. Site is live."
