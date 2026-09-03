#!/bin/sh
# Entrypoint for the server image: give the running uid the image's `yaac`
# identity, then start the server under catatonit.
#
# The image is uid-agnostic (docs/arbitrary-uid-images.md) — its `yaac` user is
# a fixed uid 1000 — while the pod runs as the install host's uid, whatever
# that is. getpwuid() then has no answer for the running uid, and ssh does not
# degrade when it gets none: it exits 255 with "No user exists for uid", which
# would take out every git fetch of an ssh-remote project. So re-point the
# existing `yaac` entry at the uid we are actually running as. /etc/passwd is
# group-0 writable (see the Dockerfile) precisely so this can happen.
#
# The same rewrite runs for worktree pods at the top of
# worktree-bin/yaac-worktree-init; a Deployment has no postStart hook to carry
# it, so the two copies are the price of one contract. Both must keep the same
# two properties:
#
#   REPLACE the entry, never append a second one. getpwnam("yaac") and
#   getpwuid(running uid) have to resolve to each other, or a later `chown
#   yaac` silently lands on uid 1000 instead of on us.
#
#   Truncate in place rather than `sed -i`, which writes a temp file and
#   renames it over /etc/passwd — that needs write permission on /etc, which
#   we deliberately do not have.
#
# A no-op on a host whose uid is 1000, which is every ordinary Linux first
# user. A failure to write is a warning, not a fatal: everything except ssh
# works without the entry, and a server that will not boot is worse.
if [ "$(id -un 2>/dev/null)" != yaac ]; then
  if passwd_file=$(sed "s/^yaac:x:[0-9]*:[0-9]*:/yaac:x:$(id -u):$(id -g):/" /etc/passwd) \
    && printf '%s\n' "$passwd_file" > /etc/passwd
  then :; else
    echo "yaac: could not re-point the yaac passwd entry at uid $(id -u);" \
      "git over ssh will fail" >&2
  fi
fi

exec /usr/bin/catatonit -- node /opt/yaac/cli.js "$@"
