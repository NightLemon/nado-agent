#!/bin/sh
set -eu

umask 077

control_uid=1000
control_gid=1000

initialize_volume() {
  target=$1
  marker="$target/.nado-volume-owner-v1"

  mkdir -p "$target"
  if [ ! -f "$marker" ]; then
    chown 0:0 "$target"
    chmod u+rwx "$target"
    : > "$marker"
    chown -R "$control_uid:$control_gid" "$target"
  fi
}

if [ "$(id -u)" -eq 0 ]; then
  initialize_volume /data/control
  initialize_volume /data/audit
  export HOME=/home/node
  export USER=node
  export LOGNAME=node
  exec setpriv \
    --reuid="$control_uid" \
    --regid="$control_gid" \
    --init-groups \
    --bounding-set=-all \
    --inh-caps=-all \
    --ambient-caps=-all \
    --no-new-privs \
    node ./src/cli.js "$@"
fi

for target in /data/control /data/audit; do
  if [ ! -w "$target" ]; then
    echo "nado-control: $target is not writable by uid $(id -u)" >&2
    exit 70
  fi
done

exec node ./src/cli.js "$@"
