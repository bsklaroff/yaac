# Node-local checkouts

On a byo install, checkouts live on the shared tier (`yaac-global`, NFS).
That is correct but about 10x slower on git write paths: an NFS-under-gVisor
spike measured checkout creation at 7.6s vs 0.75s on node disk, and `git
checkout` at 4.0s vs 0.57s. Opencode's SQLite already runs on a node-local
working copy of a shared checkpoint (docs/workspace-storage.md "opencode");
this does the same for checkouts.

## Proposal

A checkout is a clone whose `.git` borrows every object from the main clone
through `objects/info/alternates` (`createCheckout` in `#domain/git`,
docs/server-git.md). The main clone stays shared. The server stages the
checkout's `.git`, and a workspace init container places it and checks out
into a node-local directory. Cleanup and GC then need to know the checkout
lives on one node (the node-pinned sweep pattern of `reapNodeLocal`).

Nodes are disposable, so a node-local checkout must be a working copy of a
checkpoint. On stop and on a timer, commit a snapshot of the tree (tracked,
untracked and staged) to `refs/yaac/checkpoint/<id>` on the shared tier. The
init container restores from it when the node-local directory is missing.
Without that, checkouts stay shared: slow is acceptable, losing an hour of
edits to a node upgrade is not.

The file editor (docs/file-editor.md) reads and writes the checkout through
the server's filesystem, so a node-local checkout also needs an in-pod path
for it. A stopped workspace's files are then reachable only through the
checkpoint.

## Measure on a real network first

The spike numbers are single-host best cases. Before building this, measure
checkout creation, `git checkout` and workspace `pnpm install` from a
workspace node on EFS (`infra/aws-eks`), to size the win and to look for
`actimeo=1` staleness bugs on the shared tier.

`cluster check`'s NFS reachability probe should run on EFS as part of that.
It dials the server the global volume names, but an EFS volume names a file
system ID instead, so the probe is skipped there
(`sharedVolumeNfsServer` in `install/check.ts`). It should resolve and dial
the file system's mount targets.
