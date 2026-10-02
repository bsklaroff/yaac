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

# Run ssh-agent on a socket in the pod's emptyDir HOME. Only the proxy opens
# it; workspace pods reach it through the proxy's SSH_AGENT_PORT listener
# (see ssh-agent-relay.ts).
#
# HOME outlives a container restart, so remove any leftover socket first.
# Otherwise `ssh-agent -a` fails with EADDRINUSE and the proxy crash-loops.
rm -f "$HOME/agent.sock"
eval "$(ssh-agent -a "$HOME/agent.sock")"
export SSH_AUTH_SOCK="$HOME/agent.sock"

exec ./node_modules/.bin/tsx main.ts
