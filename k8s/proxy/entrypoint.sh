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

# Run ssh-agent on a private socket; the proxy talks to it directly via
# SSH_AUTH_SOCK. Force-remove stale sockets from a prior run (the volume
# persists across restarts).
rm -f /ssh-agent/socket /ssh-agent/agent.sock
eval "$(ssh-agent -a /ssh-agent/agent.sock)"
export SSH_AUTH_SOCK=/ssh-agent/agent.sock

# Bridge a world-connectable socket for session pods. They run in user
# namespaces, so the agent socket (owned by the proxy's host uid) shows up
# as owned by an unmapped uid inside them and a 0600 socket would be
# unreachable; a 0666 bridge is connectable regardless of the owner remap.
# `fork` gives each session connection its own relay to the agent.
socat "UNIX-LISTEN:/ssh-agent/socket,fork,mode=0666" "UNIX-CONNECT:/ssh-agent/agent.sock" &

exec ./node_modules/.bin/tsx proxy.ts
