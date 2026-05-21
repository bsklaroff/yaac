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
exec ./node_modules/.bin/tsx proxy.ts
