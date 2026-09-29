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
parent, the remote's default branch answers what a create in the project
would fork from. (The same function also serves a parent whose create is still in
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

## The `YAAC_REQUIRE_AUTH` refusal

`refuseUnsupportedExposure` in `server-run.ts` refuses to start a server
while `YAAC_REQUIRE_AUTH` is set (`env.requireAuthSet`), with a message that
a host shared with other OS users is not a supported shared deployment.
The variable once forced a credential gate on at loopback — the protection a
host shared with other OS users had, since they can reach its loopback but
not read its 0700 data dir. There is no such gate any more: at loopback a
caller is the owner (docs/remote-hosting.md).

**What it reads:** the environment variable, and nothing else.

**What breaks silently if it goes too early:** a host that set it to keep
other OS users out starts serving every one of them as its owner, with no
gate and no sign of it.

**How to tell it is safe to remove:** a release or two after the one that
removed tokens, once nobody who set it can still be upgrading from before.

## The proxy's re-signing of an outdated CA

`loadOrGenerateCA` in `k8s/proxy/proxy.ts` re-signs a stored CA that lacks
a `subjectKeyIdentifier` or a critical `basicConstraints`, over the CA's
own key, adding both.

**What it reads:** the CA every existing install's proxy has written into
`yaac-proxy-ca` so far. None has the critical flag; one without the SKI
exists only if it was seeded from a very old on-disk CA.

**What breaks silently if it goes too early:** such an install keeps the
old CA, and every strict verifier (Python 3.13+ by default) rejects every
proxied HTTPS request, while curl, Node and Python 3.12 keep working, so it
reads as a Python bug rather than a yaac one. Changing it to mint a new
key instead breaks every running worktree at upgrade: its agent and nested
containers loaded the old root at startup and reject the new key's leaves
until the pod restarts. Keeping the key is what makes the swap invisible.

**How to tell it is safe to remove:** a season after the release that sets
the critical flag. Then drop the condition and load any stored CA.

## A codex/opencode pin beside a conversation of its tool

`recordAgentSessions` hands a codex or opencode worktree's worktree-id pin to
the first conversation of its tool a pane names (docs/worktree-storage.md,
"Agent worktrees") — but not when the worktree already links another
conversation of that tool. The takeover replaces the pin in the same
transaction that records its first sibling, so under current code the two
never coexist and the guard never fires.

**What it reads:** a worktree recorded before the takeover existed: the pin at
ordinal 0 (with the `--prompt` ask, if one was given) and its real first
codex/opencode conversation at ordinal 1 or later.

**What breaks silently if it goes too early:** the first conversation new to
such a worktree — its next `/new` or `/clear` — takes over the pin. It inherits
the founding ask over its own opening message, the pin's birth time, and
ordinal 0, so it relabels the worktree and a restart puts it in the primary
`yaac:<tool>` window ahead of the conversation that really came first.

**How to tell it is safe to remove:** no row matches
`select 1 from worktree_agent_sessions p join worktree_agent_sessions s using
(project_slug, worktree_id, tool) where p.tool in ('codex', 'opencode') and
p.agent_session_id = p.worktree_id and s.agent_session_id <> s.worktree_id`
on the installs that matter. Removing it then changes nothing.

## A note on evidence

No test here can fail. The suite runs against a database and disk it just
created — the state in which every one of these is already a no-op — so green
says nothing about any of them, and prose entries have no executable form at
all. That is the reason this is a list rather than a check.

## The attachments-dir gate on pasted images

`saveWorktreeAttachment` refuses an upload, with "restart this worktree to
paste images into it", when the worktree's `worktreeAttachmentsDir` does not
exist. Every launch makes that directory beside the read-only mount that
shows it to the workspace, so on anything launched by a current server the
check never fires.

**What it reads:** a worktree (or warm spare) whose pod or tmux server was
launched before the attachments mount existed — it has no
`/home/yaac/.yaac-attachments` mount and no directory.

**What breaks silently if it goes too early:** the upload succeeds and the
pane pastes `/home/yaac/.yaac-attachments/<hash>.png`, a path that does not
exist in that pod; the agent reports "no such file" with nothing pointing at a
restart as the fix.

**How to tell it is safe to remove:** once no worktree launched before the
mount can still be running — every such worktree has been stopped or
restarted. Removing it then leaves the upload's behavior unchanged.

## A containerless marker with no `launchEnv`

`WorkspaceMarker.launchEnv` is optional, and `workspaceRunEnvironment`
(containerless `launch.ts`) lays nothing over the floor when it is missing,
only because a marker written before the field existed has none. The floor
itself is not a shim: it is also the permanent answer for a workspace the
registry has forgotten.

**What it reads:** a workspace marker written before the marker carried
`launchEnv`, recovered by a restarted server. Such a worktree's tmux server
also predates the emptied `update-environment`; that half is deliberately not
repaired, and a worktree restart fixes both.

**What breaks silently if it goes too early:** the type stops telling the
truth about those markers. Today's one reader tolerates a missing value
(`Object.assign` skips `undefined`), but code added later that trusts a
required field — reading a tool home out of it, say — would find nothing
after a restart and fall through to the floor's `$HOME`-relative defaults.

**How to tell it is safe to remove:** once no containerless worktree launched
before the marker carried `launchEnv` can still be running — each has been
stopped or restarted. Then make the field required.

## Registries named before project ids

`gcOrphanProjectRegistries` (`drivers/k8s/cluster/project-registry.ts`)
has a branch for registry objects that carry `yaac.project` but no
`yaac.project-id`, which only a server from before project ids created
(`yaac-reg-<slug>-<hash8>`). It groups them by slug and removes them. The
name-addressed `buildRegistryCleanupPodManifest(registryName, labels, …)`,
and the bare install-scope labels its pods get on that branch, exist so the
branch can remove a `hosts.toml` dir whose name no project id produces.

**What it reads:** registry Deployments, Services and PVCs in this install's
namespace with `app=yaac-registry` and no `yaac.project-id`.

**What breaks silently if it goes too early:** those registries and their
50Gi PVCs leak for good. The id sweep never sees them, because it selects on
an id they do not have.

**How to tell it is safe to remove:** `kubectl get deploy,svc,pvc -n <ns> -l
'app=yaac-registry,!yaac.project-id'` is empty on every install. The first
pass after an upgrade removes them, so a release later is ample. The cleanup
pod builder can then take a project id again.

## Workspaces started before project ids

The containerless `reapNodeLocal` (`drivers/containerless/teardown.ts`) keeps
any node-local tree named for a running workspace's project **slug**, as well
as those named for a live project id.

**What it reads:** the slugs of the workspaces this server has running.

**What breaks silently if it goes too early:** a workspace started before
the upgrade has its pnpm store (`pnpm_config_store_dir` →
`node-local/projects/<slug>/.cached-packages/pnpm-store`) `rm -rf`'d under
it. Installs in it then refetch every package, or fail partway.

**How to tell it is safe to remove:** no containerless workspace started
before project ids is still running. Every one has been stopped or restarted
since the upgrade, which re-points its store at `projects/<id>/`.
