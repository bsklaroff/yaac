# Workspace volumes

A **volume** is named storage that belongs to a project and that one running
workspace at a time can mount. It holds state a long-running workspace keeps
between lives: a merge queue's branch list and its PR-watch cursor, or an
app's database. The checkout is the wrong place for that, since a stop
cleans its ignored files (docs/workspace-storage.md "Ignored files at stop")
and the state would collide with the work tree. `cacheVolumes` is wrong too,
because every workspace of the project mounts the same directory at once
(docs/project-config.md).

Volumes exist only on a cluster. Under `containerless` every `/api/volume`
route answers `NOT_SUPPORTED`, and so does a create or restart that names a
volume.

## Storage

A volume is stored the way the install's own claims are
(docs/server-in-cluster.md "Storage claims"), so it lasts as long as they do.

| | kind | byo |
|---|---|---|
| Backing | the subPath `<volume id>` of the `yaac-volumes` claim | its own claim `yaac-volume-<volume id>`, from the install's RWO class |
| Bytes | `<dataDir>/volumes/<volume id>` on the host | a disk the class provisions |
| Size | not enforced | the claim's request |
| Namespace delete | survives, and the next install re-binds it | survives (the PV is `Retain`) and is re-bound at the next attach |
| Cluster delete | survives, and the next install re-binds it | the disk survives, but nothing re-binds it |
| Grow | no | where the class allows expansion |

**kind.** Volumes sit in `<dataDir>/volumes`, beside the three tier folders
rather than inside `global/`, so nothing that sweeps or backs up the global
tier takes app data. Install makes a fourth static claim for the directory,
`yaac-volumes`, backed by a `Retain` hostPath PV. The server mounts it at
`/yaac/volumes` (`YAAC_VOLUMES_ROOT`), so it creates and removes volume
directories itself, and a pod mounts its volume's directory as a subPath.
The disk is local, so SQLite is safe there.

**byo.** The global tier is NFS, which cannot host a database, so each volume
gets its own claim from the RWO class install already takes for
`yaac-server-local`. Install tells the server the class as
`YAAC_VOLUME_STORAGE_CLASS`; its absence is what makes a server use the
kind layout. A block class pins a volume to its zone, and local-path pins it
to the node that first mounted it, so a workspace holding the volume is
scheduled there.

### byo claims and their disks

The server only ever creates claims. The class's provisioner, which holds the
cloud credentials, makes the disk and its PV, and later deletes both. The
server touches PVs only for what the provisioner does not do:

| Step | What the server does | PV access |
|---|---|---|
| Create | applies the claim; the disk is made when the first pod schedules (`WaitForFirstConsumer`) | none |
| Pin | once the claim is Bound to a PV provisioned for it, sets that PV to `Retain`, labels it with the install id and the volume id, and records `volumes.pinnedAt` | `get`, `patch` |
| Grow | raises the claim's request | none |
| Re-adopt | the claim is gone but a PV with this install's id and the volume's id is `Released` or `Available`: clears its stale `claimRef` and binds the new claim to it by `volumeName` | `list`, `patch` |
| Delete | sets the volume's labelled PVs back to `Delete`, then deletes the claim, so the provisioner removes the disk | `list`, `patch` |

Pinning runs in the `volume-leases` reconcile step, so a disk is kept within
a pass of being bound. A volume never mounted has no disk to lose.

A fresh claim can bind any `Available` PV of its class, not only one made
for it, so pinning keeps a PV only if it is bound to this very claim (its
`claimRef` names the claim's uid) and is either unlabelled with the
provisioner's `pv.kubernetes.io/provisioned-by` annotation, or already
labelled as this install's and this volume's. Anything else, another
volume's disk or a static PV yaac never made, is left as it is and logged,
and delete never flips it either: delete acts only on PVs labelled with
this install and volume, which are the ones pinning kept. A claim
is ensured at every attach, which is where re-adoption happens. If the claim
is missing and no labelled PV is found, `pinnedAt` decides: unset, the
volume never had a disk and a fresh one is provisioned; set, the launch is
refused ("this volume's disk is gone") rather than handing an app an empty
disk in place of its state.

A cluster delete leaves a byo disk in the cloud account, but its PV is gone,
as with `yaac-global` and `yaac-server-local`. Recovering one is manual:
write a PV for the disk carrying the install id and volume id labels, with
`claimRef` already naming `yaac-volume-<volume id>` in the install namespace
so no other claim binds it first, and the next attach re-adopts it.

On a byo install the server's ClusterRole has `get`, `list` and `patch` on
PersistentVolumes; kind's has no PV access. Patching a PV's reclaim policy
or `claimRef` reaches as far as deleting or adopting any PV in the cluster
would. RBAC cannot limit a verb to labelled objects, so keeping to this
install's PVs is the code's job. That is no wider than the role's
cluster-wide access to pods and secrets already is.

## The lease

`volumes.holderWorkspaceId` is the workspace whose pod has the volume
mounted, and `workspaces.volumeId` is the volume a workspace was last
launched with, kept while it is stopped. A volume can have no holder while
several stopped workspaces name it; whichever restarts first gets it.

The lease, not Kubernetes, keeps a volume to one pod. A subPath has no access
mode, ReadWriteOnce lets two pods on one node share a claim, and
ReadWriteOncePod works only with CSI drivers. The lease also answers before
anything launches, where a second pod would otherwise sit Pending unexplained.

A lease is the pair (`holderWorkspaceId`, `attachedAt`), and every claim
sets `attachedAt` afresh, the holder's own renewal on restart included.
Taking over a lease and ending one both match the pair as it was read
before the holder was judged gone, so a holder that renewed in between
keeps its lease and the takeover or release loses.

**Claim.** A create or restart that will mount a volume checks it first
(`volumeForLaunch`), before anything is torn down: a holder whose runtime is
still there refuses the launch with `VOLUME_HELD` (409), naming it. The lease
itself is taken just before launch (`attachVolume`) by a conditional update,
so two launches never both win. A holder found gone (no unit, not even one
shutting down or a Job whose pod is not created yet, and nothing creating or
tearing it down) is taken over. A create that names a volume never takes a
prewarmed spare, whose mounts were fixed when it launched.

**Release** happens only once the holder's pod is gone, so the next holder
never shares a directory or disk with a pod still shutting down. The
`volume-leases` step, run on every change of the workspace set, ends the
leases of holders that are gone; it reads the leases before the runtime,
and asks what was in flight as of the runtime's listing, so a holder
renewing meanwhile is either in flight or keeps a lease the release no
longer matches. A create that fails after its unit is confirmed destroyed
ends its own lease, and a restart of a running workspace ends any lease its
old pod held that the new one does not attach. Release clears the holder
only; the former holder keeps its `volumeId`.

**Restart.** A restart attaches the volume the workspace last held. If a
running workspace has it now, the restart is refused with `VOLUME_HELD`, and
the webapp and CLI offer to restart without it. Restarting without the
volume forgets it, so the next restart does not try again; `--volume <name>`
attaches one explicitly. A running pod's mounts cannot change, so moving a
volume means stopping its holder and starting or restarting the target with
it.

**A site's deploy** is the one launch that mounts a volume another
workspace holds: its new release is staged as the volume's next holder
(`nextHolderWorkspaceId`) and writes nothing there until the deploy passes
it the lease, once the old release's pod is gone (docs/public-sites.md
"Volumes: a staged handoff"). The lease sweep forgets a next holder whose
runtime is gone.

**Delete** is refused while a running workspace holds the volume, or while
a public site names it. It deletes
the row first, so no launch can claim a volume being deleted, then the
storage, and forgets the volume on every workspace that named it. Deleting a
project deletes its volumes, and the webapp's remove dialog names them.

Removing the storage is best-effort. Deleting a row writes a tombstone
(`deleted_volumes`) in the same transaction, and the `volume-gc` step, every
ten minutes, finishes those deletes: it lists the tombstones, then the
volume storage (`<volumes root>/<uuid>` directories on kind; claims and kept
PVs labelled with this install on byo) and which of it a pod mounts. It
removes a tombstoned volume's storage once no pod mounts it, and drops the
tombstone once the storage is gone. So a delete that failed, or ran while a
pod still had the volume mounted (a project's workspaces are still shutting
down when its volumes go), is finished later. The sweep acts only on
tombstones, never on storage that merely has no row: a database that is
behind its storage (reset, or restored from a backup) has no tombstones for
it, so its volumes are left alone.

## In the workspace

The volume is mounted at `/home/yaac/volume`; `YAAC_VOLUME_DIR` names that
path and `YAAC_VOLUME_NAME` the volume. A fresh byo disk's root belongs to
root, so the pod's `volume-root` init container, running the pinned builder
image, hands it to the pod's identity once. It does not use `fsGroup`, which
kubelet would apply to every volume in the pod, the shared tier included.

## Surfaces

- API: `GET /api/volume/list`, `POST /api/volume/create`, `/resize` and
  `/delete`; `volume` on `POST /api/workspace/create`, and `volume` (a name,
  or `null` for none) on `POST /api/workspace/restart`.
- CLI: `yaac volume create|list|resize|delete`, `yaac workspace create
  --volume`, and `yaac workspace restart --volume | --no-volume`.
- `yaac-mama`: `volumes`, `create --volume` and `restart --no-volume`.
- Webapp: a Volumes section in project settings, a volume picker in the
  new-workspace popover, the attached volume's name on the workspace header,
  and "Restart without volume" on a restart refused with `VOLUME_HELD`.

## Not yet

- Usage per volume, and backups. A volume is not in the cluster backups
  (docs/plans/cluster-backups.md). A live copy of an attached volume is not
  point-in-time, so an app would keep state that is safe to copy live, or
  declare a command that writes a consistent copy first.
- More than one volume per workspace.
- Keeping one workspace running per volume, for apps that must always be up.
