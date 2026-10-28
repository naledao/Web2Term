#!/usr/bin/env bash
# Installed root-owned at /usr/local/sbin/web2term-backend-deploy.
# The dedicated SSH key is forced to this command and cannot open a shell.
set -euo pipefail
umask 077

[[ "${SSH_ORIGINAL_COMMAND:-deploy}" == deploy ]] || { echo 'Only deployment is allowed for this key.' >&2; exit 1; }
[[ "$EUID" == 0 ]] || { echo 'Deployment requires root.' >&2; exit 1; }
exec 9>/run/lock/web2term-backend-deploy.lock
flock -w 60 9

base=/opt/web2term-backend
stage="$(mktemp -d /var/tmp/web2term-backend-deploy.XXXXXX)"
trap 'rm -f -- "$stage/bundle.tar.gz" "$stage/web2term-backend" "$stage/web2term-backend.sha256" "$stage/release-id"; rmdir -- "$stage"' EXIT
# Reject truncated/oversized bundles before touching the installed release.
head -c 104857601 > "$stage/bundle.tar.gz"
[[ "$(stat -c '%s' "$stage/bundle.tar.gz")" -le 104857600 ]] || { echo 'Bundle too large.' >&2; exit 1; }
members="$(tar -tzf "$stage/bundle.tar.gz" | LC_ALL=C sort)"
[[ "$members" == $'release-id\nweb2term-backend\nweb2term-backend.sha256' ]] || { echo 'Unexpected archive members.' >&2; exit 1; }
# Extract to stdout: archive paths, links and file permissions cannot affect the filesystem.
for name in web2term-backend web2term-backend.sha256 release-id; do
  tar -xOzf "$stage/bundle.tar.gz" "$name" > "$stage/$name"
done
release="$(cat "$stage/release-id")"
[[ "$release" =~ ^[0-9a-f]{40}-[0-9]+-[0-9]+$ ]] || { echo 'Invalid release ID.' >&2; exit 1; }
[[ "$(stat -c '%s' "$stage/web2term-backend.sha256")" -eq 83 ]]
grep -Eq '^[0-9a-f]{64}  web2term-backend$' "$stage/web2term-backend.sha256"
(cd "$stage" && sha256sum --strict -c web2term-backend.sha256)
[[ "$(uname -m)" == x86_64 ]] || { echo 'This bundle requires Linux x86_64.' >&2; exit 1; }
[[ "$(od -An -t x1 -N 4 "$stage/web2term-backend" | tr -d ' \n')" == 7f454c46 ]]
[[ "$(od -An -t u2 -j 18 -N 2 "$stage/web2term-backend" | tr -d ' \n')" == 62 ]]
[[ -s /etc/web2term-backend/backend.env ]]

destination="$base/releases/$release"
[[ ! -e "$destination" ]] || { echo 'Release already exists; run the workflow again with a new attempt.' >&2; exit 1; }
install -d -m 0755 "$destination"
install -m 0755 "$stage/web2term-backend" "$destination/web2term-backend"
previous="$(readlink "$base/current" || true)"

switch_release() {
  ln -s "$1" "$base/.current-$release"
  mv -Tf "$base/.current-$release" "$base/current"
}

rollback() {
  trap - ERR
  echo 'Deployment failed; restoring previous binary.' >&2
  if [[ -n "$previous" ]]; then
    switch_release "$previous"
    systemctl restart web2term-backend.service || true
  else
    systemctl stop web2term-backend.service || true
    [[ ! -L "$base/current" ]] || unlink "$base/current"
  fi
  systemctl status web2term-backend.service --no-pager --lines=0 || true
  echo 'SQLite was preserved. Rollback applies to the binary, not database migrations.' >&2
  exit 1
}
trap rollback ERR
switch_release "releases/$release"
systemctl enable web2term-backend.service
systemctl restart web2term-backend.service
for attempt in $(seq 1 30); do
  if systemctl is-active --quiet web2term-backend.service && \
    curl --noproxy '*' --fail --silent --max-time 2 http://127.0.0.1:10088/healthz > /dev/null; then
    echo "Deployed $release on port 10088."
    trap - ERR
    exit 0
  fi
  sleep 2
done
rollback
