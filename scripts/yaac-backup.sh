#!/bin/sh
# Dump and restore a yaac data dir (~/.yaac, or $YAAC_DATA_DIR).
#
#   scripts/yaac-backup.sh dump    [-o out.tgz] [--force]
#   scripts/yaac-backup.sh restore <archive.tgz> [-d target-dir] [--force]
#
# The data dir is the only durable state a yaac install has: the PGlite
# database, .credentials/, the project git clones and per-session
# worktrees, the agent homes and transcripts, and the proxy MITM CA under
# run/proxy-data. Everything in Kubernetes and podman is rebuilt from it —
# `yaac cluster delete` says so explicitly — so restoring is
# "unpack, then re-run `yaac cluster install`".
#
# Three things this CANNOT capture, reported by `dump` and reprinted by
# `restore`:
#   1. The cluster itself. Re-run `yaac cluster install` on the new host.
#   2. ssh private keys. .credentials/github.json stores a privateKeyPath
#      pointing anywhere on the host; the key file is not in the data dir.
#      Likewise any host path named by `bindMounts` in a yaac-config.json.
#   3. ~/.gitconfig (git identity).
#
# And one it drops on purpose: projects/*/sessions, per-session state that
# does not outlive the pod it belonged to — including the yaac-in-yaac data
# dirs. See the exclusion list in `cmd_dump` for what that costs.
#
# Restore to the SAME absolute path. Every yaac object in the cluster is
# labelled with sha256(dataDir) (dataDirHash, packages/server/src/platform/k8s/kubectl.ts),
# per-project registry names hash it too, and the webapp session cookie is
# keyed on it. A different path means the server cannot see its own cluster
# objects and browser sessions are invalidated.
#
# This script is standalone POSIX sh with no repo or node dependency, so it
# can be copied to a bare host to run the restore half.
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

# The server holds the PGlite dir single-writer and checkpoints on close, so a
# hot copy of db/ can capture a torn write-ahead log. Liveness here matches
# isLockLive()'s cheap half: the lock exists and its pid is alive.
#
# `kill -0` reports failure with EPERM for a process owned by another uid, so
# a server running as a different user reads as "not running". Acceptable for
# a single-user tool: the data dir it is serving is not one you could read to
# archive anyway.
server_is_live() {
  lock="$1/.server.lock"
  [ -f "${lock}" ] || return 1
  pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "${lock}")"
  [ -n "${pid}" ] || return 1
  kill -0 "${pid}" 2>/dev/null
}

# Report host state the archive cannot contain. Deliberately a grep, not a
# parse: this is a "go look at these" list, not an input to anything.
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

  # Always dropped: dead process state. The locks name a pid and port that
  # will not exist on the new host, and login-* are mkdtemp scratch dirs
  # from OAuth flows.
  #
  # projects/*/sessions goes too. It is per-session state yaac's own cleanup
  # and orphan GC remove wholesale, and the pod it belonged to does not
  # survive a restore anyway: the tmux socket is dead without its kernel,
  # and the staged skills/bin are re-copied on the next create. Worktrees
  # are NOT in here — they are the sibling projects/*/worktrees, always
  # kept.
  #
  # An inner yaac running in a worktree keeps its own data dir under that
  # worktree's checkout, so back it up from inside the worktree if you
  # need its state.
  #
  # cache/ and models/ are re-fetched rather than carried: the Calico
  # manifest by `yaac cluster install` (checksum-verified), and the ~333MB
  # title-gen GGUF on first use — that one needs huggingface.co egress, so
  # an air-gapped host has no titles until it can reach it.
  set -- --exclude=./.server.lock --exclude=./.auth-daemon.lock --exclude='./login-*' \
    --exclude=./cache --exclude=./models
  # One literal exclude per project rather than `./projects/*/sessions`.
  # tar's exclude patterns default to --no-anchored --wildcards
  # --wildcards-match-slash, so that `*` spans `/` and the pattern also
  # matches any directory named `sessions` at any depth — silently deleting
  # a `src/sessions/` from a user's checked-out code. A pattern with no
  # wildcard is compared literally, which is exactly what we want here.
  for sess in "${dir}"/projects/*/sessions; do
    [ -d "${sess}" ] || continue
    slug="$(basename "$(dirname "${sess}")")"
    set -- "$@" --exclude="./projects/${slug}/sessions"
  done

  meta="$(mktemp -d)"
  trap 'rm -rf "${meta}"' EXIT
  # Provenance, so restore can flag a path change rather than silently
  # producing an install whose dataDirHash no longer matches its cluster.
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

  # Member name varies by tar flavour: GNU stores it bare, others normalise
  # to a ./ prefix. Try both rather than depend on --wildcards, which bsdtar
  # spells differently.
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

  # Unpack into a sibling and rename into place, so an interrupted restore
  # never leaves a half-populated data dir that the server would happily
  # start against (migrations run, missing state gets recreated). The
  # sibling shares a filesystem with the target, so the rename is atomic.
  staging="${target}.restore-tmp"
  rm -rf "${staging}"
  mkdir -p "$(dirname "${target}")" "${staging}"
  trap 'rm -rf "${staging}"' EXIT
  # -p restores the recorded modes instead of masking them through the umask:
  # db/ and .credentials/ are 0700, the credential and token files 0600.
  # Without it a umask 022 extract makes every stored token world-readable.
  # -o (--no-same-owner) because both GNU tar and bsdtar restore the archived
  # uid when extracting as root: under sudo that would chown everything to
  # the origin host's uid, while session images are rebuilt with *this*
  # server's uid (YAAC_UID). Files must belong to whoever runs the server.
  echo "restoring ${archive} -> ${target}"
  tar -xzpof "${archive}" -C "${staging}"
  rm -f "${staging}/.yaac-dump-meta"

  # Replace rather than merge: unpacking over a populated dir would leave
  # everything the archive does not contain, producing a hybrid the restored
  # DB knows nothing about (projects deleted before the dump reappearing).
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
