# Legacy-compat shims in the tree

The running inventory of shims, backfills, compatibility windows and
legacy-describing prose that exist only because an older install can still be
out there. Every one of them gets an entry here when it is added, so the next
cleanup pass starts from a list instead of a grep, and so the handful with a
real ordering constraint are not deleted in the wrong order.

There is no version-floor scheme behind this and none is wanted. Nothing
records which version last wrote a data dir or ensured a cluster, and the
intent is not to build that: these get deleted as they come up. An install
that skipped many releases and upgrades straight to head may lose data or need
a manual step, and that is an accepted cost — an entry says which items carry
it so the choice is made knowingly, not so it is avoided.

An entry says three things: what it reads, what breaks *silently* if it is
deleted too early, and how to tell it is finally safe to remove. If it has to
go in a particular order relative to something else, that ordering is the point
of the entry.

## The tap's `yaac-kind` redirect and the brew migration steps

`homebrew/tap_migrations.json` maps the retired `yaac-kind` formula (a kind
build pinned past kind#4203, from before kind v0.33.0 shipped the fix) to
core `kind`. The "Migrating an existing install" section of
`homebrew/README.md`, and the two commands in the root README that point at
it, tell an older tap install how to get from `yaac-kind` to core `kind` and
from the `libkrun/krun` tap's deleted `virglrenderer` to
`virglrenderer-krun`. Brew does neither by itself.

**What it reads:** a stale `bsklaroff/yaac/yaac-kind` name, from an old
script or doc. The prose serves a Mac that still has the `yaac-kind` keg or
the old `virglrenderer` keg installed.

**What breaks silently if it goes too early:** nothing. A stale name fails
loudly with "No available formula", and an unmigrated install hits a
conflict error it can search for. It just loses the recipe.

**How to tell it is safe to remove:** a season after the first release
that depends on core `kind`. The redirect and the prose go together.

## Queueing under a worktree with no recorded base branch

`queueWorktree` (`domain/worktrees/queued-worktrees.ts`) stores a queued
worktree's branch concretely, defaulting to the parent's
`worktrees.baseBranch`. A create now records that column with the row, but a
row written before it was recorded at creation may have none: an interrupted
create, or a claimed spare whose upstream could not be read. For such a
parent, `referenceBranch` answers what a create in the project would fork
from. (The same function also serves a parent whose create is still in
flight and has no row yet; that use is not legacy and stays.)

**What it reads:** `worktrees.baseBranch IS NULL` on the parent row.

**What breaks silently if it goes too early:** queueing under such a parent
fails (or, depending on how it is removed, stores an empty branch that fails
at launch).

**How to tell it is safe to remove:** nothing retires a legacy null — a
resume never writes `baseBranch` and no stop deletes a row — so it is safe
once `SELECT count(*) FROM worktrees WHERE base_branch IS NULL AND NOT spare`
is 0 on the installs we support (they have deleted those worktrees or their
projects).

## A note on evidence

No test here can fail. The suite runs against a database and disk it just
created — the state in which every one of these is already a no-op — so green
says nothing about any of them, and prose entries have no executable form at
all. That is the reason this is a list rather than a check.
