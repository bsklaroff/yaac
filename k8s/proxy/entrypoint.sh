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

# Run ssh-agent on a socket under the pod's emptyDir HOME; the proxy talks
# to it directly via SSH_AUTH_SOCK. Nothing outside this pod opens it: session
# pods reach the agent over the proxy's SSH_AGENT_PORT listener, which splices
# to this socket after authenticating the source pod (see proxy.ts).
#
# Force-remove the socket first: HOME is an emptyDir, whose lifetime is the
# POD's, not the container's, so a container restart (crash, OOM) reruns this
# script against the previous agent's leftover socket file. `ssh-agent -a`
# would then fail to bind (EADDRINUSE) and, under `set -e`, crash-loop the
# proxy — taking agent forwarding down for every session until the pod is
# deleted by hand.
rm -f "$HOME/agent.sock"
eval "$(ssh-agent -a "$HOME/agent.sock")"
export SSH_AUTH_SOCK="$HOME/agent.sock"

exec ./node_modules/.bin/tsx proxy.ts
