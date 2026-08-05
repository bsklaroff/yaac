#!/bin/bash
# The configuration the plan proposes, and the one that decides the go/no-go:
# repo/.git on the SHARED filesystem, the worktree NODE-LOCAL. Measures whether
# the split recovers the write-path cost that all-shared gives up, and checks
# that git tolerates the gitdir pointer crossing a filesystem boundary.
#
# Also asserts the EXDEV the plan predicts for a cross-tier link(2), which is
# why the pnpm store has to live in the same tier as the module dirs.
#
# Run: kubectl exec <pod> -- bash /tmp/hybrid.sh
# Driven by run-all.sh; not meant to be run from the host directly.
SRC=/baseline/src.git
REPO=/shared/hy/repo          # shared tier
WT=/baseline/hy/wt            # node-local tier
rm -rf /shared/hy /baseline/hy; mkdir -p /shared/hy /baseline/hy

ms() { python3 -c "import time;print('%.0f' % (time.time()*1000))"; }
t0=0; start() { t0=$(ms); }; stop() { echo "  $(printf '%-42s' "$1") $(( $(ms) - t0 )) ms"; }

echo "======== hybrid: repo/.git shared, worktree node-local ========"
git clone --no-hardlinks --quiet "$SRC" "$REPO" 2>/dev/null
cd "$REPO" || exit 1
git config user.email probe@example.com; git config user.name probe

start; git worktree add --quiet -b hy-wt "$WT" HEAD 2>/dev/null; stop "git worktree add (repo shared -> wt local)"

echo -n "  cross-fs gitdir pointer                    "
[ -f "$WT/.git" ] && echo "OK  ($(cat "$WT/.git"))" || echo FAIL
echo -n "  git status from the node-local worktree    "
git -C "$WT" status --porcelain >/dev/null 2>&1 && echo OK || echo FAIL

start; git -C "$WT" status --porcelain >/dev/null 2>&1; stop "git status in worktree (warm)"
H=$(git -C "$WT" rev-parse HEAD); P=$(git -C "$WT" rev-parse HEAD~25)
start; git -C "$WT" checkout --quiet "$P" 2>/dev/null; stop "git checkout back 25 (objects shared)"
start; git -C "$WT" checkout --quiet "$H" 2>/dev/null; stop "git checkout forward 25"

echo -n "  commit from worktree lands in shared repo  "
( cd "$WT" && git checkout --quiet -B hy-wt "$H" 2>/dev/null && echo hy > hy.txt && \
  git add hy.txt && git commit --quiet -m "hybrid probe commit" >/dev/null 2>&1 )
git -C "$REPO" log --oneline hy-wt 2>/dev/null | head -1 | grep -q "hybrid probe commit" && echo OK || echo FAIL
echo -n "  git worktree list sees the node-local wt   "
git -C "$REPO" worktree list 2>/dev/null | grep -q "$WT" && echo OK || echo FAIL

mkdir -p /baseline/hy/store/pkg /baseline/hy/mods
for i in $(seq 1 200); do echo "c$i" > /baseline/hy/store/pkg/f$i; done
start; ok=1
for i in $(seq 1 200); do ln /baseline/hy/store/pkg/f$i /baseline/hy/mods/f$i 2>/dev/null || ok=0; done
stop "pnpm link(2) x200 (both node-local)"
echo -n "  node-local link(2)                         "
[ "$ok" = 1 ] && echo "OK (no EXDEV)" || echo FAIL
echo -n "  link(2) across tiers (shared -> local)     "
ln "$REPO/HEAD" /baseline/hy/xdev 2>/dev/null && echo "unexpectedly SUCCEEDED" || echo "EXDEV as expected"
echo
