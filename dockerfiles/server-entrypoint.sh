#!/bin/sh
# Entrypoint for the server image: give the running uid the image's `yaac`
# identity, then start the server under catatonit.
#
# The image's `yaac` user is uid 1000 (docs/arbitrary-uid-images.md), but the
# pod runs as the install host's uid. Without a passwd entry for that uid, ssh
# exits 255 ("No user exists for uid") and every ssh git fetch fails. So point
# the `yaac` entry at the running uid.
#
# workspace-bin/yaac-workspace-init does the same for workspace pods. Both
# must replace the entry rather than append one (so a later `chown yaac` hits
# our uid), and rewrite /etc/passwd in place rather than `sed -i`, which needs
# write access to /etc.
#
# A write failure only warns: only ssh needs the entry.
if [ "$(id -un 2>/dev/null)" != yaac ]; then
  if passwd_file=$(sed "s/^yaac:x:[0-9]*:[0-9]*:/yaac:x:$(id -u):$(id -g):/" /etc/passwd) \
    && printf '%s\n' "$passwd_file" > /etc/passwd
  then :; else
    echo "yaac: could not re-point the yaac passwd entry at uid $(id -u);" \
      "git over ssh will fail" >&2
  fi
fi

exec /usr/bin/catatonit -- node /opt/yaac/cli.js "$@"
