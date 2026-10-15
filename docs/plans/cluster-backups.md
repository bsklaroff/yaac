# Automated backups for a cluster install

A `k8s` install keeps its durable state in two tiers (docs/server-in-cluster.md
"Storage claims"): GLOBAL, the RWX claim every workspace mounts, and
SERVER-LOCAL, the RWO claim only the server mounts. Nothing copies either one
off the cluster. On Hetzner neither can be snapshotted by the provider: Cloud
volumes have no snapshots, and server backups skip attached volumes. This plan
adds scheduled, encrypted, deduplicated backups of both tiers to an S3 object
store, configured from the CLI, and a restore that brings them back into a
fresh install. Containerless installs are out of scope.

## What is backed up

| Tier | Kept | Left out (rebuildable) |
|---|---|---|
| GLOBAL | checkouts, main clones, agent history, ACP logs, tool homes, opencode checkpoints, project config | `projects/*/cache-volumes/`, `projects/*/history/*/codex-sqlite/` |
| SERVER-LOCAL | a dump of the database, `secret.key`, `hosted-repos/`, `users/*/build/` | the live `db/` dir, `models/`, `run/`, `git-fetched/`, `.server.lock` |

codex's SQLite state (`CODEX_SQLITE_HOME`) is an index that codex rebuilds,
so it is left out rather than captured. codex keeps each conversation in its
rollout JSONL, which is backed up with the rest of `history/<id>/codex/`. It
keeps thread names in `session_index.jsonl` in the project's codex home,
which is also backed up. A fresh state database starts with its backfill
pending, and codex fills its threads table by scanning the rollouts. Looking
up a thread to resume it falls back to searching the rollout files when the
database lacks it. A restored workspace therefore starts codex with an
empty state dir and loses only database-only metadata, such as pinned
threads, which yaac does not use.

Copying the database instead would be worse than leaving it out. It runs in
WAL mode, so a live copy can capture the database and its WAL from different
moments. A torn copy that still opens may record its backfill as complete
while missing threads, and codex would not rebuild it. An opencode-style
checkpoint would avoid that, but it would mean running an exec in every
running codex workspace for an index that rebuilds itself. opencode needs its
checkpoint only because its database holds the conversations themselves.

NODE-LOCAL, the registries and the npm cache are caches and are not backed up.
Neither are cluster objects: a restore is a fresh `yaac cluster install`
followed by putting the tiers back, and the server rebuilds its objects from
the rows. So for yaac's data this replaces the k3s datastore backup that
infra/hetzner-k3s/README.md asks for.

## Tool: restic

restic gives every run a complete, independently restorable snapshot while
uploading only new data. It does this with content-defined chunking,
client-side encryption, and retention through `restic forget --prune`. Its
16 MiB pack files keep request counts far below Hetzner's 750 requests/s
per-bucket limit, and avoid the slow small-object uploads reported against
Hetzner Object Storage.
After the first run, it reads only files whose size or mtime changed, which is
what keeps a run short enough not to disturb workspaces (below).

The restic image is upstream, pinned by digest, and mirrored into the main
registry like the other upstream images (CLAUDE.md "Test Image Management"),
so the e2e global setup prebuilds it.

## CLI

- `yaac cluster backup configure --endpoint <url> --bucket <name>
  --access-key <id> --secret-key <secret> [--schedule <cron>]
  [--keep-last N --keep-daily N --keep-weekly N --keep-monthly N
  --keep-yearly N]`: stores the
  target in a `yaac-backup` Secret in the install namespace. On first use it
  initializes the restic repository with a generated password and prints the
  password once.
- `yaac cluster backup run`: start a run now.
- `yaac cluster backup status`: the last run's time, result, size added and
  duration, the repository's total size, and the next scheduled run.
- `yaac cluster backup list`: the runs the repository holds.
- `yaac cluster restore <run>`: into a fresh install only; see "Restore".

The defaults are a run every 6 hours and `--keep-last 12 --keep-daily 7
--keep-weekly 5 --keep-monthly 12 --keep-yearly 10`: three days of 6-hourly
runs, then a grandfather-father-son tail reaching back ten years.

The repository password encrypts everything, including `secret.key`, so the
user must keep it outside the cluster, as with `state_passphrase` in the
Hetzner stack. The Secret's copy lets scheduled runs work, but it is lost
together with the cluster.

## A run

The server owns the schedule as a reconcile step, so `status` and the webapp
can report on runs and the step can sequence work that has to happen inside
the server process. A run has three steps, in this order:

1. **Dump the database.** `dumpDataDir` on the open PGlite handle writes a
   consistent tarball to `server-local/backup/`. The server's queries wait
   for about a second while it runs.
2. **restic pass 1, everything except git objects.** Both tiers, minus the
   exclusions above and minus every `.git/objects` dir (checkouts and main
   clones) and every `hosted-repos/*.git/objects`.
3. **restic pass 2, the git objects dirs.**

Both passes run in one Job, pinned to the server pod's node by pod affinity
because SERVER-LOCAL is RWO. The Job mounts both claims read-only. The three
snapshots carry one run tag, and the tool treats them as one unit. The Job's
restic cache sits on an emptyDir; without a cache, restic re-reads its index
from the bucket, which is small.

restic exit code 3 means it made the snapshot but could not read some files,
usually ones deleted mid-walk. The run records that as a success with
warnings, not a failure.

### Why this order

restic has no point-in-time view. It reads files one by one over several
minutes, so the backup mixes moments. The order is chosen so that every mix it
can produce is one the server already tolerates.

- **Database before files.** Files end up newer than rows. The server never
  reads a file that no row names, so a conversation or workspace created
  during the walk is just invisible after a restore; its files are still on
  disk. The opposite order, rows newer than files, leaves rows whose files are
  missing. Restart and resume handle that badly, and conversations start
  often enough that it would come up on most restores.

  This depends on no sweep deleting files because of a row that might be
  stale, and none does. A spare has no row until it is claimed, and its
  files are deleted only while its Job still carries the `prewarmed` label
  and no row has its id (docs/workspace-storage.md). A restore starts with
  no Jobs (below), so nothing it brings back qualifies.
- **Git refs before git objects.** git writes an object before any ref points
  to it, and objects never change after they are written. So a ref copied in
  pass 1 names an object that exists, and pass 2, which runs later, copies that
  object. This is the git developers' own rule for copying a live repository.
  The main clone never deletes an object (docs/server-git.md), so the rule
  also holds for objects a checkout borrows through its alternates. One gap
  remains: a repack can delete a pack between restic listing the directory
  and reading the pack. The restore's `fsck` reports that.

Inconsistencies left over, all of which the server or the restore handles:

- A JSONL transcript or ACP log can end in a cut-off line, which the readers
  skip (`runtime/agents/jsonl.ts`).
- A working tree caught mid-edit, as after a crash.
- A stale `index.lock` or other git lock file.
- opencode checkpoints are written with SQLite's backup API, so they are
  consistent, but they can be up to five minutes behind a running pod.

## Restore

A restore only goes into a fresh install. It is for disaster recovery, not
for rolling back a cluster that is in use. A rollback would discard
everything done since the backup, including work in running workspaces, and
there is no way to undo it.

An install is fresh when it holds no project: `global/projects/` and
`server-local/hosted-repos/` are empty or absent. Every workspace belongs to
a project, so a fresh install also runs no workspace pods, and nothing
writes into GLOBAL while it is restored. A fresh install may already hold
credentials or a git identity set up since install. The restored database
replaces them.

`yaac cluster restore <run>` runs from the host, like install:

1. Scale the server Deployment to zero.
2. Run a restore Job mounting both claims read-write. It first checks that
   the install is fresh, and refuses otherwise: it names the projects it
   found, and writes nothing. It then writes a `restore-incomplete` marker to
   SERVER-LOCAL, so that a restore which fails partway can be run again. That
   restore's partial data would otherwise make the install look in use. The
   Job restores the three snapshots and replaces `db/` with the dump. It
   keeps the volume's own `.yaac-install` marker, because the backup may come
   from another install id. It deletes stale `*.lock` files in restored git
   dirs and runs `git fsck --connectivity-only` on each repo, reporting the
   repos that fail.
3. Refuse to finish if `secret.key` is missing and the database holds
   encrypted rows.
4. Remove the marker and scale the server back up. Every workspace that was
   running at backup time comes back stopped, and the stale reaper records
   it so. On a refusal, scale the server back up untouched.

A spare's checkout in the backup has no row, so it comes back as an inert
directory that nothing reads. A workspace created or a spare claimed during
the walk is in the same state: its files are kept, but it is not listed.

Restoring into a new cluster means `yaac cluster install --byo`, then
`backup configure` with the same bucket and password, then `restore`.

A restore does not check the dump's schema. A dump made by a newer yaac
records migrations the installed server does not ship, so the server
refuses it at startup (`MigrationRefusal`) and asks for an upgrade. The
restored data stays as it is, and once yaac is upgraded the server starts
on it. A dump made by an older yaac is migrated forward on start, like any
upgrade.

The server's own handling of rows whose files are gone (restart overwriting a
checkout that has no `.git`, resume of a missing transcript, a silently
regenerated `secret.key`) is being fixed separately. Those states also come
from crashes, so the fixes are needed with or without backups.

## Effect on running workspaces

On Hetzner, GLOBAL is one ext4 volume on the control node, served over NFS.
Every workspace's checkout I/O shares that volume's limit: 200 MB/s and 5000
IOPS sustained, 300 MB/s and 7500 IOPS burst.

- **The first run** reads everything: about 15 to 30 minutes for the 37 GB
  this cluster holds today, mostly limited by upload speed. While it runs,
  workspaces see slower git and builds. It also pushes the frequently used
  checkout data out of the control node's page cache. Schedule the first run
  for a quiet hour.
- **Later runs** walk the file metadata and read only what changed, which is
  likely 1 to 3 GB per 6 hours. They take minutes and leave the cache mostly
  intact.
- **The Job is throttled and isolated.** It runs with `--read-concurrency 2`,
  a configurable `--limit-upload`, a fixed 1 Gi memory request equal to its
  limit, and the lowest PriorityClass. It shares the control node with the
  server and with workspaces that may use more memory than they request, so
  an unbounded backup pod could push the kubelet into evicting a workspace.
- **The database dump** pauses queries for about a second. Workspaces don't
  notice; the UI may.

A filesystem snapshot (LVM thin on the NFS volume) would give an exact point
in time with no reads during the window. It would also mean reformatting the
existing volume, privileged access to the host, and a Hetzner-only code path.
The order above makes it unnecessary.

## Cost on Hetzner Object Storage

The prices are those in effect since 2026-04-01:

- **Base:** €6.49 a month, which includes 1 TB of storage and 1 TB of egress.
  It seems to be shared by every bucket in the account, including the
  OpenTofu state bucket.
- **Extra storage:** about €6.47 per TB-month.
- **Free:** uploads, API requests, and traffic inside eu-central.

With deduplication, the stored size is roughly one compressed copy plus
whatever has since been deleted or rewritten but is still held by a kept
snapshot. The monthly snapshots hold up to a year of that, and each yearly
one keeps its year's state for a decade, so the repository keeps growing
slowly. At today's size it should stay within the base 1 TB for years, but
`backup status` reports the repository's size so the growth is visible.
Uncompressed daily copies would
instead cost €19 a month for 30 days of a 150 GB install, and €72 a month
for a 550 GB install.

## Infra

- infra/hetzner-k3s/README.md gets a "Backups" section: create a second
  bucket (the state bucket must stay unversioned for OpenTofu's locking),
  generate S3 credentials, and run `yaac cluster backup configure` after
  install. It also says that the state bucket's base price already covers the
  first TB.
- The README's "The control node is not disposable" section points at this
  instead of asking for a datastore backup.
- infra/aws-eks/README.md gets the same section with an S3 bucket.

## Security

The server can read every Secret in the install namespace, including
`yaac-backup`, so a compromised server could delete the backups. Object Lock
or versioning on the backup bucket, with credentials that cannot delete
locked objects, would close that. Check what Hetzner Object Storage supports
before relying on it.

## Tests

- **Unit:** run sequencing and retention flags, with restic mocked at the
  process boundary (spawn).
- **e2e (k8s):** configure against an in-cluster S3 server, create a
  workspace with a commit, uncommitted changes and a conversation, then run
  a backup, restore into a fresh namespace, and restart the workspace with
  its work intact. A restore into the original namespace, which still holds
  the project, is refused and leaves it untouched. A restore interrupted
  after it began writing can be run again.
- **e2e (k8s), codex:** a codex conversation restored without its state dir
  resumes, and appears in `codex resume`'s list once the backfill has run.
  This pins the codex behavior the exclusion relies on, so a codex upgrade
  that stops rebuilding the index fails a test.
- Every command option needs an e2e case in `test/e2e-cli/`.
- Every new API route needs a row in `test/api/route-matrix.ts`. Under
  containerless the routes answer `NOT_SUPPORTED`.

## Open questions

- How should heavy gitignored build output be excluded, such as `target/`,
  `.venv/` and `.next/`? A stop keeps everything in the checkout, gitignored
  or not, so this output sits on GLOBAL and gets backed up. A running
  workspace's rebuilds rewrite it, so every run would upload the changed
  artifacts. Proposed answer: no backup-specific setting. A project lists
  those directories in `ephemeralModulesPaths` (docs/project-config.md),
  which makes them node-local and deleted at stop. That keeps them out of
  every backup, and off NFS while the workspace runs. The cost is a cold
  build on restart. The backup does no automatic detection of caches either:
  which directories are disposable is the project's call, made explicitly.
  The `cluster backup` docs should point users at `ephemeralModulesPaths`.
