#!/bin/sh
set -e
if [ "$USE_TOR" = "1" ]; then
  mkdir -p /data/tor
  tor -f /etc/tor/torrc &
  for _ in $(seq 1 60); do
    if grep -q "Bootstrapped 100" /data/tor/notices.log 2>/dev/null; then
      touch /data/tor-ready
      break
    fi
    sleep 1
  done
fi

# Start ssh-agent at a known socket path inside the shared /ssh-agent volume
# so session containers can connect to it. Force-remove a stale socket from
# a prior run (the volume persists across restarts).
rm -f /ssh-agent/socket
eval "$(ssh-agent -a /ssh-agent/socket)"
export SSH_AUTH_SOCK=/ssh-agent/socket

exec ./node_modules/.bin/tsx proxy.ts
