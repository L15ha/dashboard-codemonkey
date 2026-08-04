#!/usr/bin/env bash
# =============================================================================
#  Security hardening for the EC2 host: firewall, fail2ban, SSH lockdown.
#  Called by setup-server.sh, or run standalone with sudo.
#
#  NOTE: This disables SSH password login. Make sure your SSH *key* works
#  BEFORE running, or you can lock yourself out. (On a fresh EC2 Ubuntu AMI
#  key-only login is already the default, so this just enforces it.)
# =============================================================================
set -euo pipefail

echo "==> Firewall (UFW): allow SSH, HTTP, HTTPS; deny everything else"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp   comment 'SSH'
ufw allow 80/tcp   comment 'HTTP'
ufw allow 443/tcp  comment 'HTTPS'
ufw --force enable
ufw status verbose

echo "==> fail2ban: ban brute-force SSH attempts"
cat > /etc/fail2ban/jail.local <<'JAIL'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[sshd]
enabled = true
port    = ssh
JAIL
systemctl enable fail2ban
systemctl restart fail2ban

echo "==> SSH hardening"
SSHD=/etc/ssh/sshd_config.d/99-hardening.conf
cat > "$SSHD" <<'SSHD'
# Managed by harden.sh — key-only, no root login
PermitRootLogin no
PasswordAuthentication no
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2
SSHD
# Validate config before reloading so we never break sshd
if sshd -t; then
  systemctl reload ssh || systemctl reload sshd || true
  echo "   SSH hardened."
else
  echo "!! sshd config test failed — leaving SSH untouched. Review $SSHD"
  rm -f "$SSHD"
fi

echo "==> Enable automatic security updates"
DEBIAN_FRONTEND=noninteractive apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades || true

echo "==> Hardening complete."
