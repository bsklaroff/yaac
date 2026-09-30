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

## pi's shared session dir

pi's logs used to go to the project's `pi/agent/sessions/` (`piSessionsDir`);
every create now points pi at the worktree's own `history/<wt>/pi/`. Two
things still read the old place: `movePi` in `#domain/agent-history`, which
moves a worktree's logs out of it on each create, and the `pi` entry in
`TRANSCRIPT_LAYOUT` (`runtime/agents/transcripts.ts`), whose shared half makes
every pi reader search it after the history. Nothing writes there any more on
either driver, unlike claude's and codex's shared dirs, where a host run keeps
landing new files and the fallback is permanent.

**What it reads:** `pi/agent/sessions/**/<ts>_<sid>.jsonl` written before the
change — by a worktree not restarted since, or a stopped one.

**What breaks silently if it goes too early:** those worktrees lose their pi
history. A stopped one shows no founding ask, and a restart launches pi with
`--session-id` against an empty session dir, starting the conversation over.

**How to tell it is safe to remove:** `pi/agent/sessions/` holds no `.jsonl`
in any project dir (a create empties it of its own worktree's logs, so only
worktrees never restarted since the upgrade keep any there). Then drop
`movePi` and point the `pi` layout at the history alone, and delete
`piSessionsDir`.

## The never-prune keys in a main clone's real config

`ensureNeverPrune` (`domain/git/repo.ts`) writes `gc.pruneExpire`,
`gc.reflogExpire` and `gc.reflogExpireUnreachable` = `never` into a project's
main clone's own `.git/config` before it creates or converts a checkout there,
whenever the main clone still has a `worktrees/` dir. That dir is how an
install from before worktrees were clones is recognized: its pods mount the
main clone read-write and auto-gc it with their own git, which reads this
file and sees none of the clones' refs.

**What it reads:** nothing; it is a write that legacy pods' git reads.

**What breaks silently if it goes too early:** a legacy pod's auto-gc prunes,
with git's two-week default, objects a clone borrows, and that clone fails
weeks later with missing-object errors.

**How to tell it is safe to remove:** no main clone has a `worktrees/` dir.
Order: `adoptLinkedCheckout` calls `ensureNeverPrune` before it converts, so
`ensureNeverPrune` goes with the conversion (next entry), never before it.
Only the write for older main clones is legacy: `cloneRepo` writes the same
keys into every new one, and `sanitizeMainClone` writes them back when it
rewrites a config, for good — `maintainRepo`'s command-line pins cover the
server, the keys cover git run in the main clone by anyone else.

## Converting linked checkouts, and the main-clone hardening in `runGit`

One entry, because the two must go together. `adoptLinkedCheckout` and
`sanitizeMainClone` (`domain/git/adopt.ts`), run by the launch path for a
checkout it restarts and by the `convertLinkedCheckouts` startup sweep for
every stopped one, turn an older install's `git worktree add` checkouts into
clones and, once a project has none left, strip the main clone of whatever a
pod ever wrote into it. `deleteWorktreeState` still removes a reaped
worktree's admin dir for the same installs. Until then `runGit` keeps
building a throwaway git dir for every call on a main clone
(docs/server-git.md), because a legacy pod can still write that clone's
config.

**What it reads:** `worktrees/<id>/.git` files (and `.git.linked`, a crashed
conversion's), `repo/.git/worktrees/<id>/`, the main clone's refs and its
`branch.agent/<id>.merge`.

**What breaks if it goes too early:** loudly for the worktree — its restart
writes an alternates line into a `.git` that is a file — but silently for the
server if the hardening goes too: it would run git against a config legacy
pods can still write.

**How to tell it is safe to remove:** no row's checkout has a `.git` file or a
`.git.linked`, and no main clone has a `worktrees/` dir. Then the conversion,
its startup sweep, `readRepoConfig`, the admin-dir removal in
`deleteWorktreeState`, and the throwaway git dir (`buildGitDir`, `readOnce`,
`configEntries`, `KEPT_KEYS`, `LINKED`, `clearGitScratch` and its startup
call) all go in one change, leaving `runGit` a plain `GIT_DIR` call with its
pins. An install that carries a linked checkout past that change runs
unhardened server git against a config its pods can write.

## A `server.json` with no recorded cluster

`clusterRefusal` (`drivers/k8s/install/cluster-identity.ts`) lets every
host-side cluster verb through when this data dir's `server.json` records
no `clusterUid`, rather than refusing because it cannot compare. Install is
deliberately outside it: install is what records the field (the kind path
re-records it on every run, and a first byo install has nothing to compare
yet), so it stays exempt when this goes.

**What it reads:** the `clusterUid` field of the CLIENT-LOCAL
`server.json`, which `yaac cluster install` writes on both backends before
it applies anything.

**What breaks if it goes too early:** nothing silently. Removing it means
refusing `yaac server start|stop|restart|logs` and `yaac cluster
check` on a `server.json` that says `driver: "k8s"` but records no
`clusterUid`, with "run `yaac cluster install`" as the fix. A k8s install
whose file predates the field is then locked out of those verbs until its
next install, which records the field and unlocks them; nothing is lost.

**How to tell it is safe to remove:** when upgrading in place from a
release before the first one that writes `clusterUid` (the release after
0.0.8) is no longer supported. Every supported install has then run a
`yaac cluster install` that wrote the field.
