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

## `adoptProjectDirs`

`adoptProjectDirs` (`db/project-store.ts`) turns a `project.json` with no row
into a row on every `listProjectRows`. **Deliberately not one-shot**: a project
directory can appear after any given read (a second yaac on the same data dir,
a restored backup, a manual copy), so a durable "already imported" flag would
make those invisible forever.

That is what makes elapsed time the wrong test for it — there is no installed
base to wait out. It goes when the substrate stops sharing the server's
filesystem and every project arrives through `recordProject`
(docs/layered-server.md). `domain/projects/add.ts` writes `project.json` beside
the row specifically to keep feeding it, so the two are deleted together.

## `yaac.vcluster-session-id`, a rename still owed

The last label key that says "session". Current code stamps it —
`vclusterLabels` (`drivers/k8s/cluster/vcluster.ts`) puts it on the vcluster's
namespace and on every object the vcluster owns — so this is not an old name
lingering in old clusters; it is being written today, and every day it stays
is another namespace that will carry only it.

**What reads it:** one place, `mapVclusterNamespaceObject`
(`drivers/k8s/substrate/vcluster-objects.ts`), which takes the worktree id off
the label and returns null without it. **No selector uses it** —
`vclusterNamespaceSelector` keys on `yaac.vcluster` plus the data-dir hash. So
this is not the shape the pod-label rename was: there is no set of
NetworkPolicy podSelectors that has to move in the same commit, and renaming
it needs one either-key read rather than an atomic flip.

**What breaks silently if it is renamed without that read:** every vcluster
namespace created before the rename carries the old key alone, so the mapper
drops it, the orphan sweep never sees it, and nothing else deletes it. A
leaked namespace here is a whole vcluster left running, and unlike a pod a
namespace is not recreated on the next start — so it never self-heals, and the
symptom is a slow accumulation of vclusters nobody asked for rather than an
error.

**How to do it:** stamp the new key, read either key, and keep both until no
namespace can still carry only the old one. Unlike most entries here, that is
directly checkable rather than a judgement about installed versions — this
lists any namespace still missing the new key:

```sh
kubectl get ns -l yaac.vcluster -o json \
  | jq -r '.items[] | select(.metadata.labels["yaac.vcluster-worktree-id"] == null) | .metadata.name'
```

When it prints nothing on every cluster in use, the either-key read goes and
this entry with it.

## A note on evidence

No test here can fail. The suite runs against a database and disk it just
created — the state in which every one of these is already a no-op — so green
says nothing about any of them, and prose entries have no executable form at
all. That is the reason this is a list rather than a check.
