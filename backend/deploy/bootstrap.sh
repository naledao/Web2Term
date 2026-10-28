#!/usr/bin/env bash
# Run once as root with a directory containing this script, deploy.sh,
# web2term-backend.service, deploy-key.pub, and backend.env.
set -euo pipefail
umask 077
[[ "$EUID" == 0 ]] || { echo 'Run bootstrap as root.' >&2; exit 1; }
source_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
for command in systemctl install useradd flock curl tar sha256sum; do
  command -v "$command" > /dev/null || { echo "Required command missing: $command" >&2; exit 1; }
done
[[ "$(uname -m)" == x86_64 ]] || { echo 'Expected Linux x86_64.' >&2; exit 1; }
[[ -s "$source_dir/backend.env" ]]
read -r key_type key_data key_comment < "$source_dir/deploy-key.pub"
[[ "$key_type" == ssh-ed25519 && "$key_data" =~ ^[A-Za-z0-9+/=]+$ ]] || { echo 'Invalid deployment public key.' >&2; exit 1; }
if ! id web2term-backend > /dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/web2term-backend --shell /usr/sbin/nologin web2term-backend
fi
install -d -m 0755 /opt/web2term-backend /opt/web2term-backend/releases
install -d -m 0700 -o web2term-backend -g web2term-backend /var/lib/web2term-backend
install -d -m 0700 /etc/web2term-backend
# Repeat bootstrap never replaces a deployed database, JWT secret or SMTP configuration.
if [[ ! -e /etc/web2term-backend/backend.env ]]; then
  install -m 0600 "$source_dir/backend.env" /etc/web2term-backend/backend.env
fi
install -m 0755 "$source_dir/deploy.sh" /usr/local/sbin/web2term-backend-deploy
install -m 0644 "$source_dir/web2term-backend.service" /etc/systemd/system/web2term-backend.service
install -d -m 0700 /root/.ssh
touch /root/.ssh/authorized_keys
chmod 0600 /root/.ssh/authorized_keys
if ! grep -Fq -- "$key_data" /root/.ssh/authorized_keys; then
  printf 'restrict,command="/usr/local/sbin/web2term-backend-deploy" %s %s github-actions-web2term-backend\n' "$key_type" "$key_data" >> /root/.ssh/authorized_keys
fi
systemctl daemon-reload
echo 'Bootstrap complete: key restricted to deployment; service has not been started.'
