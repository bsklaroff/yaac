# Legacy-compat shims in the tree

This lists the shims, backfills, compatibility windows and legacy prose that
exist only because an older install may still be out there. Each gets an
entry when it is added, so a cleanup pass starts from this list instead of a
grep, and shims with an ordering constraint are removed in the right order.

There is no version-floor scheme, and none is wanted: nothing records which
version last wrote a data dir or set up a cluster. Shims are deleted as they
come up. An install that skips many releases may lose data or need a manual
step. That cost is accepted, and the entries say which shims carry it.

Each entry says what the shim reads, what breaks silently if it is deleted
too early, and how to tell it is safe to remove, plus any required order.

No test can catch a shim going stale. The suite runs on a database and disk it
just created, where every shim is already a no-op, so a green run says nothing
about them. That is why this is a list and not a check.

## The tap's `yaac-kind` redirect and the brew migration steps

`homebrew/tap_migrations.json` maps the retired `yaac-kind` formula (kind
pinned past kind#4203, before kind v0.33.0 shipped the fix) to core `kind`.
The "Migrating an existing install" section of `homebrew/README.md`, and the
two commands in the root README that link to it, move an older tap install
from `yaac-kind` to core `kind` and from the `libkrun/krun` tap's deleted
`virglrenderer` to `virglrenderer-krun`. Brew does neither on its own.

**What it reads:** a stale `bsklaroff/yaac/yaac-kind` name in an old script or
doc. The prose serves a Mac that still has the `yaac-kind` or old
`virglrenderer` keg installed.

**What breaks silently if it goes too early:** nothing. A stale name fails with
"No available formula", and an unmigrated install hits a searchable conflict
error. The user just loses the recipe.

**How to tell it is safe to remove:** a season after the first release that
depends on core `kind`. Remove the redirect and the prose together.

## Queueing under a workspace with no recorded base branch

`resolveSettings` (`domain/workspaces/queued-workspaces.ts`) gives a queued
workspace the parent's `workspaces.baseBranch`, falling back to the remote's
default branch (`getDefaultBranch`). Creates now record that column, but an
older row may lack it: an interrupted create, or a claimed spare whose
upstream could not be read. The same fallback also covers a parent whose
create is still in flight; that use is not legacy and stays.

**What it reads:** `workspaces.baseBranch IS NULL` on the parent row.

**What breaks silently if it goes too early:** queueing under such a parent
fails, or stores an empty branch that fails at launch.

**How to tell it is safe to remove:** nothing clears a legacy null (a resume
never writes `baseBranch`, and a stop never deletes the row). Safe once
`SELECT count(*) FROM workspaces WHERE base_branch IS NULL AND NOT spare` is 0
on every supported install.

## The `YAAC_REQUIRE_AUTH` refusal

`refuseUnsupportedExposure` (`main/server-run.ts`) refuses to start a server
while `YAAC_REQUIRE_AUTH` is set (`env.requireAuthSet`), saying a host shared
with other OS users is not a supported deployment. The variable used to force
a credential check at loopback, which protected such a host: other users can
reach its loopback but not read its 0700 data dir. That check is gone; a
loopback caller is the owner (docs/remote-hosting.md).

**What it reads:** the environment variable only.

**What breaks silently if it goes too early:** a host that set it to keep other
OS users out would serve all of them as its owner, with no warning.

**How to tell it is safe to remove:** a release or two after the one that
removed tokens, once nobody who set it can still be upgrading from before.

## The proxy's re-signing of an outdated CA

`loadOrGenerateCA` (`k8s/proxy/proxy.ts`) re-signs a stored CA that lacks a
`subjectKeyIdentifier` or a critical `basicConstraints`, adding both and
keeping the CA's own key.

**What it reads:** the CA each existing install's proxy stored in
`yaac-proxy-ca`. None has the critical flag. One without the SKI exists only
if it was seeded from a very old on-disk CA.

**What breaks silently if it goes too early:** the install keeps the old CA,
and strict verifiers (Python 3.13+ by default) reject every proxied HTTPS
request, while curl, Node and Python 3.12 keep working, so it looks like a
Python bug. Minting a new key instead would break every running workspace at
upgrade: its agent and nested containers loaded the old root at startup and
reject the new key's leaves until the pod restarts. Keeping the key makes the
swap invisible.

**How to tell it is safe to remove:** a season after the release that sets the
critical flag. Then drop the condition and load any stored CA as is.

## A codex/opencode pin beside a conversation of its tool

A codex or opencode workspace starts with a placeholder conversation row, the
"pin", keyed by the workspace id. `recordAgentSessions`
(`db/agent-session-store.ts`) hands the pin to the first real conversation of
that tool a pane reports (docs/workspace-storage.md, "Agent workspaces"),
unless the workspace already links another conversation of that tool. Current
code replaces the pin in the same transaction that records its first sibling,
so the guard never fires.

**What it reads:** a workspace recorded before the handoff existed: the pin at
ordinal 0 (with the `--prompt` ask, if given) and its real first
codex/opencode conversation at ordinal 1 or later.

**What breaks silently if it goes too early:** the next new conversation in
such a workspace (its next `/new` or `/clear`) takes over the pin: the
founding ask, the pin's birth time and ordinal 0. That relabels the workspace,
and a restart puts it in the primary `yaac:<tool>` window ahead of the
conversation that really came first.

**How to tell it is safe to remove:** no row matches
`select 1 from workspace_agent_sessions p join workspace_agent_sessions s using
(project_slug, workspace_id, tool) where p.tool in ('codex', 'opencode') and
p.agent_session_id = p.workspace_id and s.agent_session_id <> s.workspace_id`
on the installs that matter.

## The attachments-dir gate on pasted images

`saveWorkspaceAttachment` (`domain/workspaces/attachments.ts`) refuses an
upload with "restart this workspace to paste images into it" when the
workspace's `workspaceAttachmentsDir` does not exist. Every launch creates it
next to the read-only mount that exposes it, so for a workspace a current
server launched the check never fires.

**What it reads:** a workspace (or warm spare) launched before the attachments
mount existed, with no `/home/yaac/.yaac-attachments` mount and no directory.

**What breaks silently if it goes too early:** the upload succeeds and the pane
pastes `/home/yaac/.yaac-attachments/<hash>.png`, which does not exist in that
pod. The agent reports "no such file", with nothing suggesting a restart.

**How to tell it is safe to remove:** every workspace launched before the mount
has been stopped or restarted.

## A containerless marker with no `launchEnv`

`WorkspaceMarker.launchEnv` (`drivers/containerless/registry.ts`) is optional
only because markers written before the field existed lack it. When it is
missing, `workspaceRunEnvironment` (`drivers/containerless/launch.ts`) uses
the base environment alone. That base is not a shim: it is also the answer
for a workspace the registry has forgotten.

**What it reads:** a pre-`launchEnv` marker, recovered by a restarted server.
That workspace's tmux server also predates the emptied `update-environment`;
this is deliberately not repaired, and a workspace restart fixes both.

**What breaks silently if it goes too early:** the type would lie about those
markers. Today's one reader tolerates a missing value (`Object.assign` skips
`undefined`), but later code that trusts a required field, say to read a tool
home, would find nothing after a server restart and fall back to
`$HOME`-relative defaults.

**How to tell it is safe to remove:** every containerless workspace launched
before the marker carried `launchEnv` has been stopped or restarted. Then make
the field required.

## Registries named before project ids

`gcOrphanProjectRegistries` (`drivers/k8s/cluster/project-registry.ts`) has a
branch for registry objects with `yaac.project` but no `yaac.project-id`,
which only a server from before project ids created
(`yaac-reg-<slug>-<hash8>`). It groups them by slug and removes them.
`buildRegistryCleanupPodManifest` takes a registry name and caller-supplied
labels, not a project id, and the cleanup pods this branch launches carry
bare install-scope labels, so it can remove a node's `hosts.toml` dir whose
name no project id produces. Both go with the shim.

**What it reads:** registry Deployments, Services and PVCs in this install's
namespace with `app=yaac-registry` and no `yaac.project-id`.

**What breaks silently if it goes too early:** those registries and their 50Gi
PVCs leak forever, since the id-based sweep selects on an id they lack.

**How to tell it is safe to remove:** `kubectl get deploy,svc,pvc -n <ns> -l
'app=yaac-registry,!yaac.project-id'` is empty on every install. The first GC
pass after an upgrade removes them, so a release later is plenty. The cleanup
pod builder can then take a project id again, and its pods the usual
project labels.

## Workspaces started before project ids

The containerless `reapNodeLocal` (`drivers/containerless/teardown.ts`) keeps
any node-local tree named for a running workspace's project slug, as well as
those named for a live project id.

**What it reads:** the project slugs of the workspaces this server has running.

**What breaks silently if it goes too early:** a workspace started before the
upgrade has its pnpm store (`node-local/projects/<slug>/.cached-packages/pnpm-store`,
via `pnpm_config_store_dir`) deleted under it, so installs refetch everything
or fail partway.

**How to tell it is safe to remove:** every containerless workspace started
before project ids has been stopped or restarted (a restart moves its store
to `projects/<id>/`).

## pi's shared session dir

pi's logs used to go to the project's `pi/agent/sessions/` (`piSessionsDir`).
Every create now points pi at the workspace's own history dir
(`agentHistoryDir`). Two things still read the old dir: `movePi` in
`#domain/agent-history`, which moves a workspace's logs out of it on each
create, and the `pi` entry in `TRANSCRIPT_LAYOUT`
(`runtime/agents/transcripts.ts`), whose `shared` part makes pi readers search
it after the history. Nothing writes there any more, on either driver. (For
claude and codex the shared-dir fallback is permanent, because host runs keep
writing there.)

**What it reads:** `pi/agent/sessions/**/<ts>_<sid>.jsonl` from a workspace not
restarted since the change, or a stopped one.

**What breaks silently if it goes too early:** those workspaces lose their pi
history. A stopped one shows no founding ask, and a restart launches pi with
`--session-id` against an empty session dir, starting the conversation over.

**How to tell it is safe to remove:** no project's `pi/agent/sessions/` holds a
`.jsonl`. Then drop `movePi`, point the `pi` layout at the history alone, and
delete `piSessionsDir`.

## The never-prune keys in a main clone's real config

`ensureNeverPrune` (`domain/git/repo.ts`) writes `gc.pruneExpire`,
`gc.reflogExpire` and `gc.reflogExpireUnreachable` = `never` into a project
main clone's own `.git/config` before creating or converting a checkout
there, but only while the main clone has a `.git/worktrees/` dir. That dir
marks an install from before workspaces were separate clones. Its pods mount
the main clone read-write and auto-gc it with their own git, which reads this
file and cannot see the clones' refs.

**What it reads:** nothing. It is a write that legacy pods' git reads.

**What breaks silently if it goes too early:** a legacy pod's auto-gc prunes,
after git's default two weeks, objects a clone borrows, and that clone fails
weeks later with missing-object errors.

**How to tell it is safe to remove:** no main clone has a `.git/worktrees/`
dir.

**Order:** `adoptLinkedCheckout` calls `ensureNeverPrune` before converting,
so `ensureNeverPrune` goes with the conversion (next entry), never before it.
Only this write for older main clones is legacy. `cloneRepo` writes the same
keys into every new main clone and `sanitizeMainClone` writes them back when
it rewrites a config; both stay. (`maintainRepo`'s command-line pins cover the
server's own gc; the config keys cover git anyone else runs there.)

## Converting linked checkouts, and the main-clone hardening in `runGit`

These must be removed together:

- `adoptLinkedCheckout` and `sanitizeMainClone` (`domain/git/adopt.ts`) turn
  an older install's `git worktree add` checkouts into clones, and once a
  project has none left, strip the main clone of anything a pod wrote into
  it. The launch path runs them for a checkout it restarts; the
  `convertLinkedCheckouts` startup sweep runs them for every stopped one.
- `deleteWorkspaceState` removes a reaped workspace's `.git/worktrees/<id>`
  admin dir.
- `runGit` (`domain/git/run.ts`) builds a throwaway git dir for every call on
  a main clone (docs/server-git.md), because a legacy pod can still write
  that clone's config.

**What it reads:** `workspaces/<id>/.git` files (and `.git.linked`, left by a
crashed conversion), `repo/.git/worktrees/<id>/`, the main clone's refs and
its `branch.agent/<id>.merge`.

**What breaks if it goes too early:** the workspace fails loudly (its restart
writes an alternates line into a `.git` that is a file). The server fails
silently if the hardening goes too: it runs git against a config legacy pods
can still write.

**How to tell it is safe to remove:** no workspace checkout has a `.git` file
or `.git.linked`, and no main clone has a `.git/worktrees/` dir. Then remove,
in one change: the conversion, its startup sweep, `readRepoConfig`, the
admin-dir removal in `deleteWorkspaceState`, and the throwaway git dir
(`buildGitDir`, `readOnce`, `configEntries`, `KEPT_KEYS`, `LINKED`,
`clearGitScratch` and its startup call). `runGit` becomes a plain `GIT_DIR`
call with its pins. An install that still has a linked checkout after that
runs unhardened server git against a config its pods can write.

## A `server.json` with no recorded cluster

`clusterRefusal` (`drivers/k8s/install/cluster-identity.ts`) lets every
host-side cluster command through when this data dir's `server.json` has no
`clusterUid`, instead of refusing for lack of anything to compare. `yaac
cluster install` is outside this check and stays exempt afterwards: install is
what records the field (the kind path re-records it every run, and a first
byo install has nothing to compare yet).

**What it reads:** the `clusterUid` field of the client-local `server.json`,
which `yaac cluster install` writes on both backends before applying anything.

**What breaks if it goes too early:** nothing silently. `yaac server
start|stop|restart|logs` and `yaac cluster check` would refuse a `driver: "k8s"`
`server.json` with no `clusterUid` and tell the user to run `yaac cluster
install`, which records the field. Nothing is lost.

**How to tell it is safe to remove:** in-place upgrades from before the first
release that writes `clusterUid` (the release after 0.0.8) are no longer
supported.

## Checkouts under `worktrees/`

`moveLegacyWorkspacesDirs` (`domain/projects/legacy-workspaces-dir.ts`) runs
once per server start, before anything resolves a checkout path. It renames a
project's `worktrees/` dir to `workspaces/` and leaves `worktrees` as a
relative symlink to it. The symlink is created as `worktrees.link` first and
renamed into place last, so a start that dies partway finishes the move on the
next one. `removeAgentHistory` (`domain/agent-history/history.ts`) also
removes the shared claude folder named for a checkout's old `worktrees/<id>`
path, which a create before the rename linked into its history.

**What it reads:** a real `projects/<slug>/worktrees/` dir, a leftover
`worktrees.link`, and the claude folder named for the old path.

**What breaks silently if it goes too early:** every checkout in it, stopped or
running, disappears: restarts, diffs and cleanup look under `workspaces/<id>`
and find nothing. The symlink matters while a workspace launched before the
move is still running, since its pod's hostPath mount, cwd, containerless
marker and a linked checkout's admin-dir back-pointer all use the old path.
Nothing deletes the link, and it costs nothing. Without the history part,
deleting a pre-rename workspace leaves a dangling link in the `projects/` dir
that every sibling's claude lists.

**How to tell it is safe to remove:** no project dir holds a real `worktrees/`
dir, i.e. every install has started a server since the rename. The symlinks
can stay after the code goes.

## Workspace objects labelled `yaac.worktree-id`

`relabelLegacyWorkspaces` (`drivers/k8s/cluster/proxy-apply.ts`) runs in the
k8s driver's startup, before its informers. It adds `yaac.workspace-id` to
every pod, Job and proxy registration ConfigMap that has `yaac.worktree-id`.
If it found any, startup rolls the proxy right away, since the old proxy
selects on the old label. `ensureProxyResources` relabels again (so a create
racing startup, or a start whose relabel failed, is still covered) and only
then deletes the
`yaac-worktree-egress` and `yaac-worktree-ingress-lock` NetworkPolicies, and
`ensureNpmCache` deletes `yaac-npm-cache-worktree-egress`, each after applying
its replacement.

**What it reads:** objects in this install's namespace with the old label and
not the new one, and the three NetworkPolicies by name.

**What breaks silently if it goes too early:** a workspace an older install
left running is invisible to the informers. The stale reaper records it dead,
the proxy refuses its egress, and it falls outside the workspace
NetworkPolicies, under the world-deny policy meant for infrastructure pods.

**Order:** relabel before deleting the old policies. A relabelled pod is
covered by the new policies; one that is not, only by the old ones.

**How to tell it is safe to remove:** `kubectl get pods,jobs,configmaps -n
<ns> -l yaac.worktree-id` is empty on every install, and `kubectl get
networkpolicy -n <ns>` lists none of the three old names. The `yaac-worktree`
PriorityClass is deliberately never deleted (see `ensurePriorityClasses`).

## `yaac-mama` and `YAAC_WORKTREE_ID` in a workspace launched before the rename

A workspace keeps the `yaac-mama` its create staged and the environment it was
launched with. Three things accept what an older one sends:

- the `LEGACY_ARGS` renames (`--worktree`, `--parent-worktree`) in
  `runMamaCommand` (`domain/workspaces/mama.ts`) and the proxy's
  `parseMamaEnvelope` (`k8s/proxy/mama-queue.ts`);
- the `/api/worktree/mama` mount of `mamaApp` (`main/server.ts`), where a
  containerless workspace posts;
- the `YAAC_WORKTREE_ID` fallback of `env.workspaceId`
  (`packages/shared/src/env.ts`), for a yaac server run inside such a
  workspace (the dev loop of a yaac checkout).

**What it reads:** those two option names, that path, that variable.

**What breaks silently if it goes too early:** `yaac-mama` there fails every
command that names a workspace (under containerless, every command). An inner
server no longer knows it runs in a workspace, which changes who `identify()`
treats as local. A containerless workspace's builtin skills are symlinked,
not staged, so they already describe the new names; `yaac-mama queue` there
needs a restart either way.

**How to tell it is safe to remove:** no workspace launched before the rename
is still running (k8s: the `kubectl` check in the previous entry;
containerless: no marker's `launchEnv` has `YAAC_WORKTREE_ID`). Then drop the
two maps, the route mount and its row in `test/api/route-matrix.ts`, and the
fallback along with the `YAAC_WORKTREE_ID` that
`packages/test-utils/src/vitest-setup.ts` strips beside it.
