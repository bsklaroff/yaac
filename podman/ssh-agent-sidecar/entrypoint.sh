#!/bin/sh
set -e

# Remove stale socket from previous runs (volume persists across restarts)
rm -f /ssh-agent/socket

# Start ssh-agent with a known socket path for volume sharing
eval $(ssh-agent -a /ssh-agent/socket)

# Force ssh-add to use SSH_ASKPASS (which is /bin/false) so passphrase-
# protected keys fail immediately instead of hanging on stdin.
export DISPLAY=none:0
export SSH_ASKPASS=/bin/false
export SSH_ASKPASS_REQUIRE=force

for key in /ssh-keys/id_*; do
  [ -f "$key" ] || continue
  case "$key" in *.pub) continue ;; esac
  if ssh-add "$key" 2>/dev/null; then
    echo "Loaded: $(basename "$key")"
  else
    echo "Skipped (passphrase?): $(basename "$key")"
  fi
done

ssh-add -l 2>/dev/null || echo "(no keys loaded)"
exec sleep infinity
