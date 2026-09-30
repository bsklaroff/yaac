#!/bin/sh
# Dump and restore a yaac data dir (~/.yaac, or $YAAC_DATA_DIR).
#
#   scripts/yaac-backup.sh dump    [-o out.tgz] [--force]
#   scripts/yaac-backup.sh restore <archive.tgz> [-d target-dir] [--force]
#
# The data dir is the only durable state a yaac install has: the PGlite
# database, .credentials/, the project git clones and workspaces, and the
# agent homes and transcripts. Kubernetes and podman state is rebuilt from
# it, so restoring means unpacking and re-running `yaac cluster install`.
# The proxy MITM CA lives in the cluster, so a restore mints a new one.
#
# Three things this cannot capture, reported by `dump` and `restore`:
#   1. The cluster itself. Re-run `yaac cluster install` on the new host.
#   2. ssh private keys. .credentials/github.json stores a privateKeyPath
#      pointing anywhere on the host; the key file is not in the data dir.
#      Likewise any host path named by `bindMounts` in a yaac-config.json.
#   3. ~/.gitconfig (git identity).
#
# Per-session state (projects/*/sessions) is dropped on purpose; see the
# exclusion list in `cmd_dump`.
#
# Restore to the same absolute path. Every yaac cluster object is labelled
# with a hash of the data dir path (dataDirHash in
# packages/server/src/drivers/k8s/substrate/kubectl.ts), and per-project
# registry names use it too, so a different path hides the server's own
# cluster objects.
#
# Standalone POSIX sh with no repo or node dependency, so it can be copied
# to a bare host for the restore.
set -eu

usage() {
  cat >&2 <<'EOF'
usage:
  yaac-backup.sh dump    [-o <archive.tgz>] [--force]
  yaac-backup.sh restore <archive.tgz> [-d <target-dir>] [--force]

dump options:
  -o <file>   output archive (default ./yaac-backup-<host>-<date>.tgz)
  --force     dump even while the server is running (risks a torn PGlite WAL)

restore options:
  -d <dir>    target data dir (default $YAAC_DATA_DIR or ~/.yaac)
  --force     replace a non-empty target dir (the old one is renamed to
              <dir>.replaced-<timestamp> rather than deleted)
EOF
  exit 2
}

# Mirrors getDataDir() in packages/shared/src/paths.ts.
default_data_dir() {
  if [ -n "${YAAC_DATA_DIR:-}" ]; then
    printf '%s' "${YAAC_DATA_DIR}"
  else
    printf '%s' "${HOME}/.yaac"
  fi
}

# A copy of db/ taken while the server runs can capture a torn write-ahead
# log. Liveness matches the cheap half of isLockLive(): the lock exists and
# its pid is alive. `kill -0` fails for another user's process, but that
# user's data dir would not be readable anyway.
server_is_live() {
  lock="$1/.server.lock"
  [ -f "${lock}" ] || return 1
  pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "${lock}")"
  [ -n "${pid}" ] || return 1
  kill -0 "${pid}" 2>/dev/null
}

# Report host state the archive cannot contain. A rough grep is enough:
# the output is a checklist for a human.
report_external_state() {
  dir="$1"
  gh="${dir}/.credentials/github.json"
  if [ -f "${gh}" ]; then
    keys="$(grep -o '"privateKeyPath"[[:space:]]*:[[:space:]]*"[^"]*"' "${gh}" 2>/dev/null |
      sed 's/.*"\([^"]*\)"$/\1/' || true)"
    if [ -n "${keys}" ]; then
      echo "  ssh private keys referenced by .credentials/github.json:"
      echo "${keys}" | sed 's/^/    /'
    fi
  fi
  mounts="$(find "${dir}/projects" -maxdepth 3 -name yaac-config.json 2>/dev/null |
    xargs grep -l '"bindMounts"' 2>/dev/null || true)"
  if [ -n "${mounts}" ]; then
    echo "  bindMounts (host paths) declared in:"
    echo "${mounts}" | sed 's/^/    /'
  fi
  [ -f "${HOME}/.gitconfig" ] && echo "  ~/.gitconfig (git identity)"
  for c in "${HOME}/.cache/yaac/bin" "${HOME}/.cache/yaac/llama-cpp"; do
    [ -d "${c}" ] && echo "  ${c} (re-downloaded if absent; copy to save the fetch)"
  done
  return 0
}

cmd_dump() {
  out=''
  force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      -o) [ $# -ge 2 ] || usage; out="$2"; shift 2 ;;
      --force) force=1; shift ;;
      *) usage ;;
    esac
  done

  dir="$(default_data_dir)"
  [ -d "${dir}" ] || { echo "no yaac data dir at ${dir}" >&2; exit 1; }
  if [ -z "${out}" ]; then
    out="yaac-backup-$(hostname -s 2>/dev/null || echo host)-$(date +%Y%m%d-%H%M%S).tgz"
  fi

  if server_is_live "${dir}"; then
    if [ "${force}" -eq 0 ]; then
      echo "the yaac server is running — stop it first so PGlite checkpoints:" >&2
      echo "    yaac server stop" >&2
      echo "(or pass --force to dump anyway, risking a torn WAL in db/)" >&2
      exit 1
    fi
    echo "warning: dumping a live install; db/ may be inconsistent" >&2
  fi

  # Dropped: the locks (their pid and port won't exist on the new host),
  # login-* OAuth scratch dirs, and projects/*/sessions, which holds the
  # staged skills and bin for pods that won't survive a restore. The
  # workspaces themselves (projects/*/workspaces) are kept.
  #
  # cache/ and models/ are re-fetched: the Calico manifest by
  # `yaac cluster install`, and the ~333MB title-gen model on first use
  # (which needs huggingface.co access).
  set -- --exclude=./.server.lock --exclude=./.auth-daemon.lock --exclude='./login-*' \
    --exclude=./cache --exclude=./models
  # One literal exclude per project, not `./projects/*/sessions`: tar's
  # default wildcard matching is unanchored and lets `*` span `/`, so that
  # pattern would also drop any `sessions/` dir inside a user's checkout.
  for sess in "${dir}"/projects/*/sessions; do
    [ -d "${sess}" ] || continue
    slug="$(basename "$(dirname "${sess}")")"
    set -- "$@" --exclude="./projects/${slug}/sessions"
  done

  meta="$(mktemp -d)"
  trap 'rm -rf "${meta}"' EXIT
  # Recorded so restore can warn when the data dir path changes.
  cat > "${meta}/.yaac-dump-meta" <<EOF
origin_data_dir=${dir}
origin_host=$(hostname 2>/dev/null || echo unknown)
created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

  echo "dumping ${dir} -> ${out}"
  # Members are stored relative to the data dir (./db, ./projects, …) rather
  # than under its basename, so restore can target a differently-named dir.
  tar -czf "${out}" "$@" -C "${dir}" . -C "${meta}" .yaac-dump-meta
  echo "wrote ${out} ($(du -h "${out}" | cut -f1))"
  echo
  echo "NOT in this archive — copy or recreate by hand:"
  report_external_state "${dir}"
  echo "  the cluster itself: run 'yaac cluster install' on the new host"
}

cmd_restore() {
  archive=''
  target=''
  force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      -d) [ $# -ge 2 ] || usage; target="$2"; shift 2 ;;
      --force) force=1; shift ;;
      -*) usage ;;
      *) [ -z "${archive}" ] || usage; archive="$1"; shift ;;
    esac
  done
  [ -n "${archive}" ] || usage
  [ -f "${archive}" ] || { echo "no such archive: ${archive}" >&2; exit 1; }
  [ -n "${target}" ] || target="$(default_data_dir)"

  # GNU tar stores the member name bare, others with a ./ prefix.
  origin="$( { tar -xzOf "${archive}" .yaac-dump-meta 2>/dev/null ||
    tar -xzOf "${archive}" ./.yaac-dump-meta 2>/dev/null || true; } |
    sed -n 's/^origin_data_dir=//p')"
  if [ -n "${origin}" ] && [ "${origin}" != "${target}" ]; then
    echo "warning: this dump came from ${origin}, restoring to ${target}." >&2
    echo "  yaac keys cluster objects and webapp cookies on sha256(dataDir)," >&2
    echo "  so the new install will not recognise objects made by the old one," >&2
    echo "  and browser sessions will need re-authenticating." >&2
    echo "  Prefer restoring to ${origin}, or set YAAC_DATA_DIR to it." >&2
  fi

  occupied=0
  if [ -d "${target}" ] && [ -n "$(ls -A "${target}" 2>/dev/null)" ]; then
    occupied=1
    if [ "${force}" -eq 0 ]; then
      echo "${target} exists and is not empty — refusing to replace it." >&2
      echo "move it aside, or pass --force (which moves it aside for you)." >&2
      exit 1
    fi
    if server_is_live "${target}"; then
      echo "the yaac server is running against ${target} — stop it first:" >&2
      echo "    yaac server stop" >&2
      exit 1
    fi
  fi

  # Unpack into a sibling dir and rename it into place (atomic on one
  # filesystem), so an interrupted restore never leaves a half-populated
  # data dir the server would start against.
  staging="${target}.restore-tmp"
  rm -rf "${staging}"
  mkdir -p "$(dirname "${target}")" "${staging}"
  trap 'rm -rf "${staging}"' EXIT
  # -p keeps the recorded modes (0700 dirs, 0600 token files) instead of
  # applying the umask, which would make tokens world-readable. -o keeps
  # files owned by the user running the restore; as root, tar would
  # otherwise restore the origin host's uid.
  echo "restoring ${archive} -> ${target}"
  tar -xzpof "${archive}" -C "${staging}"
  rm -f "${staging}/.yaac-dump-meta"

  # Replace rather than merge, so files the restored DB knows nothing about
  # don't survive.
  if [ "${occupied}" -eq 1 ]; then
    aside="${target}.replaced-$(date +%Y%m%d-%H%M%S)"
    mv "${target}" "${aside}"
    echo "previous data dir moved aside: ${aside}" >&2
  else
    rm -rf "${target}"
  fi
  mv "${staging}" "${target}"
  trap - EXIT

  echo "restored ${target}"
  echo
  echo "still to do on this host:"
  echo "  yaac cluster install      # kind cluster, registry, netd, proxy, gVisor, images"
  report_external_state "${target}"
  echo "  then: yaac server start"
}

[ $# -ge 1 ] || usage
sub="$1"
shift
case "${sub}" in
  dump) cmd_dump "$@" ;;
  restore) cmd_restore "$@" ;;
  *) usage ;;
esac
