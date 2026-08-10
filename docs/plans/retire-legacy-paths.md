# Legacy cruft still in the tree

The running list of shims, backfills, compatibility windows and
legacy-describing prose that have not been removed yet. It exists so the next
cleanup pass starts from an inventory instead of a grep, and so the handful of
items with a real ordering constraint are not deleted in the wrong order.

There is no version-floor scheme behind this and none is wanted. Nothing records
which version last wrote a data dir or ensured a cluster, and the intent is not
to build that: these get deleted as they come up. An install that skipped many
releases and upgrades straight to head may lose data or need a manual step, and
that is an accepted cost — the notes below say which items carry it so the
choice is made knowingly, not so it is avoided.

What *is* worth respecting is the ordering in section 4. Those two constraints
are about the change itself, not about anyone's installed base: get them
backwards and you break worktrees running right now, on a current install.

## 1. Read-time shims

Normalizers that run on every read and never write anything back, so no install
ever finishes with them. Deleting either is a behaviour change on the spot for
anyone whose on-disk file is still in the old shape.

| site | what it does |
|---|---|
| `normalizeLegacyPattern` — `features/projects/credentials.ts`, mirrored in `k8s/proxy/proxy.ts` | rewrites pre-host-axis git credential patterns (`*` → `github.com/*`, `owner/repo` → `github.com/owner/repo`). Deleting it makes a still-bare entry fail `validatePattern` and get dropped, so git auth stops for that repo with no error |
| `removeLegacyCodexHook` — `features/agents/codex.ts`, called from `createWorktree` | strips the pre-managed-hook SessionStart entry from a project's mounted `~/.codex/hooks.json`. Left there, it re-triggers Codex's `/hooks` trust prompt every session |

Both become ordinary one-shots the moment something rewrites what they read:
a conditional write-back in `loadCredentials` when normalization changed
anything (the proxy's copy is read-only against a file the server owns, so it
follows for free), and a per-project marker for the codex hook. Worth doing if
either is deleted rather than converted — otherwise the failure is silent.

## 2. On-disk migrations

`migrateLegacyDockerfile` (`features/projects/build-dirs.ts`) renames
`config/Dockerfile.yaac` into the project build dir on first touch, through
`resolveProjectBuildDir` / `resolveUserBuildDir`. Self-healing, but only for a
project whose build dir has actually been resolved — a project that has never
built since the change still holds its Dockerfile at the old path, and deleting
this silently ignores it.

`adoptProjectDirs` (`features/records/project-store.ts`) turns a `project.json`
with no row into a row on every `listProjectRows`. **Not on this list to be
deleted** — it is deliberately not one-shot, because a project directory can
appear after any given read (a second yaac on the same data dir, a restored
backup, a manual copy) and a durable flag would make those invisible forever.
It retires architecturally, when the substrate stops sharing the server's
filesystem and every project arrives through `recordProject`
(docs/plans/herd-split.md). `features/projects/add.ts` writes `project.json`
beside the row specifically to keep feeding it, so the two go together.

## 3. Cluster-object sweeps

Delete-only: nothing reads the old object, the sweep just removes it. Cheap to
keep and cheap to drop — a leftover NetworkPolicy is a duplicate rule, not a
hole. This is the complete list of the "cleanups still owed" that
docs/naming.md records.

| site | object |
|---|---|
| `ensureProxyResources` — `features/cluster/proxy-apply.ts` | `yaac-session-egress`, `yaac-session-ingress-lock`, install namespace |
| `ensureWorktreeVcluster` — `features/cluster/vcluster.ts` | `yaac-inner-session-ingress-lock`, per vcluster namespace |

They run at proxy and vcluster ensure — the first worktree create, not server
boot.

**The `yaac-session` PriorityClass is not one of these and must not be added.**
`ensurePriorityClasses` deliberately leaves it: the class is cluster-scoped and
shared by coexisting installs, so deleting it breaks an install still running
old code — its pods name the class, the apiserver rejects a pod whose class is
missing, and the Job applies while no pod ever appears. That is a live
cross-install hazard, not an installed-base caution.

## 4. Dual-read compatibility — mind the order

Both of these fail *silently* if closed early, and both are the open windows
docs/naming.md documents. The ordering notes are the load-bearing part of this
document.

**`yaac.session-id` stamped alongside `yaac.worktree-id`.** A label selector
cannot express "either key", so every selector still matches the legacy key,
while code-level readers go through `labelWorktreeId`, which accepts either.
Sites: `platform/k8s/pods.ts` (constant, `labelWorktreeId`, the stamp, both zod
schemas, `worktreePodSelector`), `features/cluster/policy-manifests.ts`,
`features/cluster/activator.ts`, `features/cluster/vcluster.ts`,
`features/cluster/project-registry.ts`, `k8s/proxy/pod-watch.ts`,
`k8s/netd/targets.ts`, `packages/test-utils/src/setup.ts`.

> **Move every selector to the new key before dropping the legacy stamp.** The
> reverse order strands every worktree pod that is running at the moment of the
> upgrade: the new selector matches nothing, and the pods go invisible to
> listing, status and the reaper at once. `kubectl get pods -A -l
> 'yaac.session-id,!yaac.worktree-id'` finds anything still on the old key
> alone.

**The proxy's `sessions.json` fallback** — `k8s/proxy/state-files.ts`, and
`LEGACY_WORKTREES_FILE` in `k8s/proxy/proxy.ts`. `/data` is a hostPath that
outlives the proxy pod on purpose, so a replaced proxy comes back knowing every
worktree's allowlist. `worktrees.json` is what gets written; the old name is
still read when only it exists.

> A proxy that boots and finds neither file starts empty and **fails closed**,
> taking egress from every running worktree without erroring. One proxy
> redeploy per install writes the new name, so the window closes on its own —
> just not instantly.

## 5. Tripwires added when the backfill went

Not legacy code themselves; they exist because the pre-database import was
removed and its absence was otherwise undetectable. Listed here so they are not
mistaken for the thing they replaced — and so they can be dropped deliberately
once nobody is upgrading across that gap.

| site | what it does |
|---|---|
| `warnAboutUnimportedLegacyData` — `main/legacy-data-check.ts` | stats the four retired JSON stores at startup and warns, naming each unread file |
| the refused-absolute `serverLog` in `resolveProjectPath` — `features/agents/transcripts.ts` | logs a stored path this build will not resolve. Also catches a writer that bypassed the encoder, which is a bug in any version — so this one is worth keeping past the rest |

## 6. Prose that outlives what it describes

Comments and docs that exist only because a legacy state can still exist.
Nothing fails when they go stale, which is why they need a list: two of these
went stale *inside the branch that wrote this document*, both because a deletion
happened one file away from the prose describing it.

**Docs.**

| doc | goes with |
|---|---|
| `docs/cluster-setup.md` § "Upgrading from the host registry container" — the `yaac-registry-1` EndpointSlice command, `podman rm -f yaac-registry`, the three `/var/lib/yaac/*` node-store roots, the `localhost/…` alias-repo `rm -rf` | the pre-in-cluster-registry era |
| `docs/naming.md` § "Compatibility windows still open" | section 4 — the section *is* those two windows |
| `docs/naming.md`, the cluster-objects paragraph in § "What still says session" | section 3 |

When both `naming.md` sections go the file reduces to its vocabulary table and
the names that belong to other people's protocols, which are permanent — that
is the part worth keeping.

**Source comments.**

| comment | goes with |
|---|---|
| `features/cluster/delete.ts` — why there is no host-container step | the host-registry era |
| `features/cluster/main-registry.ts` module doc — the fresh-empty-claim upgrade, and where the old hostPath data sits | the hostPath-registry era |
| `features/cluster/project-registry.ts`, `buildProjectRegistryPvcManifest` — the same trade per project | the same |
| `platform/k8s/priority-classes.ts` — why `yaac-session` is deliberately not deleted | when no install old enough to stamp that class can still run; later than section 3 |
| `platform/k8s/pods.ts` `LABEL_WORKTREE_ID_LEGACY` block, and the same constant's comments in `k8s/proxy/pod-watch.ts` and `k8s/netd/targets.ts` | section 4 |
| `k8s/proxy/state-files.ts` — why `readJsonEither` takes a legacy path | section 4 |
| `features/records/agent-session-store.ts` (`firstAgentSession`) and `features/worktrees/stopped-list.ts` — "a row without one predates that", the claude default | when no row can predate create-time recording |

Two neighbours that are **not** cruft and should not be swept with them:

- `LABEL_MODE`'s absence-reads-as-`tui` (`platform/k8s/pods.ts`,
  `features/status/status-watcher.ts`) is an encoding choice: the label is
  stamped only for `acp`, so a TUI pod created by this build lacks it too.
- The local named `legacy` in `features/worktrees/agent-session-registry.ts` is
  the live pinned-conversation path for a worktree whose hook has not reported
  yet. It wants renaming, not deleting.

## A note on evidence

No test here can fail. The suite runs against a database and disk it just
created — the state in which every one of these is already a no-op — so green
says nothing about any of them, and section 6 has no executable form at all.
That is the reason this is a list rather than a check.
