#!/bin/bash
# Correctness + timing for the operations a yaac session actually performs on
# project state: clone, status, checkout, gc, `git worktree add` (and the
# gitdir pointer it depends on), pnpm-style link(2), and transcript append/tail.
#
# Runs INSIDE a probe pod, against whichever mount it is pointed at, so the
# same script produces every cell of the arm matrix (gVisor/runc x NFS/ext4).
# The clone source is always on the ext4 baseline, so the only variable is
# where the writes land.
#
# Run: kubectl exec <pod> -- bash /tmp/gitprobe.sh <target-dir> "<label>"
# Driven by run-all.sh; not meant to be run from the host directly.
SRC=/baseline/src.git
T=$1
LABEL=$2

rm -rf "$T"; mkdir -p "$T"

ms() { python3 -c "import time;print('%.0f' % (time.time()*1000))"; }
t0=0
start() { t0=$(ms); }
stop()  { echo "  $(printf '%-42s' "$1") $(( $(ms) - t0 )) ms"; }

echo "======== git/pnpm: $LABEL  ($T) ========"

# --no-hardlinks so a same-filesystem clone cannot cheat by linking objects.
start; git clone --no-hardlinks --quiet "$SRC" "$T/repo" 2>/dev/null; stop "git clone"

cd "$T/repo" || exit 1
git config user.email probe@example.com; git config user.name probe

start; git status --porcelain >/dev/null 2>&1; stop "git status (cold)"
start; git status --porcelain >/dev/null 2>&1; stop "git status (warm)"

HEAD_SHA=$(git rev-parse HEAD)
PREV=$(git rev-parse HEAD~25)
start; git checkout --quiet "$PREV" 2>/dev/null; stop "git checkout back 25 commits"
start; git checkout --quiet "$HEAD_SHA" 2>/dev/null; stop "git checkout forward 25 commits"
git checkout --quiet -B main "$HEAD_SHA" 2>/dev/null

start; git log --oneline -n 200 >/dev/null 2>&1; stop "git log -n 200"
start; git gc --quiet 2>/dev/null; stop "git gc"

# Plan invariant 2: /workspace/.git must point at repo/.git/worktrees/<sid>,
# and both sides must be reachable wherever git runs.
start; git worktree add --quiet -b probe-wt "$T/worktrees/sid1" HEAD 2>/dev/null; stop "git worktree add"
echo -n "  worktree gitdir pointer                    "
if [ -f "$T/worktrees/sid1/.git" ]; then echo "OK  ($(cat "$T/worktrees/sid1/.git"))"; else echo "FAIL"; fi
echo -n "  git ops from inside the worktree           "
git -C "$T/worktrees/sid1" status --porcelain >/dev/null 2>&1 \
  && git -C "$T/worktrees/sid1" rev-parse HEAD >/dev/null 2>&1 && echo OK || echo FAIL
echo -n "  commit in worktree lands in shared repo    "
( cd "$T/worktrees/sid1" && echo probe > probe.txt && git add probe.txt && \
  git commit --quiet -m "probe commit" >/dev/null 2>&1 )
git -C "$T/repo" log --oneline probe-wt 2>/dev/null | head -1 | grep -q "probe commit" && echo OK || echo FAIL
echo -n "  git worktree list from the main repo       "
git -C "$T/repo" worktree list 2>/dev/null | grep -q sid1 && echo OK || echo FAIL

# Plan invariant 3: pnpm links modules out of its store, so store and modules
# must share a filesystem or link(2) returns EXDEV.
mkdir -p "$T/store/pkg" "$T/modules"
for i in $(seq 1 200); do echo "content-$i" > "$T/store/pkg/f$i"; done
start; ok=1
for i in $(seq 1 200); do ln "$T/store/pkg/f$i" "$T/modules/f$i" 2>/dev/null || ok=0; done
stop "pnpm-style link(2) x200"
echo -n "  link(2) within the mount                   "
[ "$ok" = 1 ] && echo "OK (no EXDEV)" || echo "FAIL (EXDEV)"

start
for i in $(seq 1 300); do echo "{\"i\":$i,\"msg\":\"transcript line\"}" >> "$T/transcript.jsonl"; done
stop "transcript: 300 appends"
start; tail -n 50 "$T/transcript.jsonl" >/dev/null; stop "transcript: tail -n 50"
echo
