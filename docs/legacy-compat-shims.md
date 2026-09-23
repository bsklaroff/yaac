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

## The `/etc/yaac/agent-links.sh` strip in `ensureClaudeHooks`

`ensureClaudeHooks` (`runtime/agents/claude.ts`) drops any `hooks.SessionStart`
command beginning `/etc/yaac/agent-links.sh` from a project's shared
`projects/<slug>/claude/settings.json` before registering the current one.
That path was where the agent-session discovery hook lived when it was baked
into the tools image; it is now `worktree-bin/yaac-agent-links`, staged per
worktree onto the workspace's PATH so one copy serves both substrates.

**What breaks silently if it goes too early:** nothing silently — loudly, and
forever. The settings file is per project and never rewritten wholesale, so a
project seeded by an older install keeps the old command until something
removes it. No image has that path any more and a containerless host never
did, so claude prints a `SessionStart:startup hook error` on every session
start, in every worktree of that project, under both drivers. Discovery still
works (the current hook is registered beside it), which is exactly why this is
easy to leave in place unnoticed.

**One ordering note:** the strip runs on every create, including creates of
*other* worktrees in the same project. A worktree still running an old image
therefore loses discovery the moment a sibling create migrates the shared
settings file — its pod has `/etc/yaac/agent-links.sh` but not the staged
script the new command names. It also gets the visible symptom back: the
migrated command is a bare `yaac-agent-links`, which that pod cannot resolve,
so `/bin/sh -c` exits 127 and claude prints the same non-blocking
`SessionStart` hook error this replaced — on every session start until the
worktree restarts. Sessions still run; the hook is non-blocking and the
registration itself never fails a create. That is the accepted cost of the
strip being unconditional; making it conditional would need a per-worktree
record of which image a running pod came from, which nothing keeps.

**How to tell it is safe to remove:** every data dir in use has been through at
least one create per project since this shipped. Directly checkable:

```sh
grep -rl '/etc/yaac/agent-links.sh' "${YAAC_DATA_DIR:-$HOME/.yaac}"/global/projects/*/claude/settings.json
```

When that prints nothing on every install in use, the strip and
`LEGACY_HOOK_PREFIX` go, along with the migration cases in
`test/runtime/agents/claude.test.ts`.

## `sweepLegacyVclusterState`

The successor to everything that used to collect a per-worktree virtual
cluster. `virtualCluster` is gone, and with it the teardown step and the
orphan reconcile that deleted vclusters — so on an install that ran one, the
namespaces, their control planes and their synced pods have nothing left that
would ever remove them.

**What it reads:** namespaces (and cluster-scoped roles, bindings and
admission policies) labelled `yaac.vcluster`, scoped to this install by
`yaac.vcluster-data-dir-hash`; the fixed names `yaac-vc-activator` and
`yaac-redirect-claims` in the install namespace; and the `vcluster/` and
`nested-yaac/` subdirectories of every worktree state dir. It only ever
deletes. Fired detached from the k8s driver's attach, beside
`gcOrphanProjectRegistries`.

The label-scoped deletes are install-scoped, so a sibling install's vclusters
on a shared cluster are untouched. The two name-scoped ones are the
exception: the activator and the claims document were namespace singletons
stamped with `app:` alone, so installs sharing a namespace share them, and a
staggered upgrade deletes a still-old sibling's waker out from under it. Its
sleeping vclusters then wait for its own ensure to re-apply both on the next
vcluster create.

**What breaks silently if it is deleted too early:** an install upgrading from
a vcluster-era yaac keeps whole vclusters running — a control plane, a
syncer and their synced pods per worktree — that nothing else deletes, and a
namespace is not recreated on the next start, so it never self-heals. The
symptom is accumulating node memory and a `kubectl get ns` full of `-vc-`
namespaces, never an error. The accepted cost is on the other side: a worktree
created by the old install loses its in-worktree cluster on the first new
server start, and goes on running as an ordinary worktree.

**Two installs it never converges.** The sweep runs at *k8s driver attach*,
so an install that upgrades and simultaneously moves to
`YAAC_DRIVER=containerless` — what this repo's own dev config now does —
never fires it, and its vcluster estate stands until someone runs
`kubectl delete ns -l yaac.vcluster` by hand. And an inner install wrote its
`nested-yaac/` dir from inside a pod, so those bytes can be root-owned: the
sweep runs as the server uid and logs the EACCES rather than escalating.

**How to tell it is safe to remove:** directly checkable rather than a
judgement about installed versions —

```sh
kubectl get ns -l yaac.vcluster -o name
```

When that prints nothing on every cluster in use, this goes and the entry
with it. Deliberately the cluster-side test alone: root-owned `nested-yaac/`
residue can outlive a fully converged cluster, and keeping the shim alive for
disk bytes it was never going to clear would be the wrong read.

## The retired `virtualCluster` config key

`RETIRED_KEYS` in `domain/projects/config.ts` maps `virtualCluster` to a
warning naming it as removed, and the parser still honors the one thing the
key implied that survives it: `nestedContainers`.

**What it reads:** the key in any project's `yaac-config.json`. The key is
ignored rather than rejected — erroring would make every create fail on a
config the author has no reason to have revisited yet — except that
`virtualCluster: true` with no explicit `nestedContainers` still resolves to
`nestedContainers: true`, exactly as it always did. An explicit
`nestedContainers: false` wins: it is the newer key, and the author said it
outright.

**What breaks silently if it is deleted too early:** two things, and the
second is the reason the implication is kept. The key falls through to the
generic `unknown field` warning, which reads like a typo — nothing to search
for, and no mention of `nestedContainers`. And an unedited config loses its
in-pod container engine, which surfaces much later as `docker: not found`
inside a worktree, far from the config that caused it. The warning names the
fix, but `console.warn` lands in the server log rather than the create's
progress stream, so the person who hits it is unlikely to read it.

**How to tell it is safe to remove:** a judgement call, unlike the sweep above
— nothing records which configs still carry the key. A season after release,
once no project config in use still names it.

## `importLegacyProjectConfig`, and the retired env keys beside it

`importLegacyProjectConfig` (`domain/projects/legacy-config-import.ts`) runs
once per server start, over every project. Where a project's
`yaac-config.json` still carries `env`, `envPassthrough` or `envSecretProxy`,
it moves what it can into `project_env_vars` rows, strips the three keys from
the file, and logs what moved. `RETIRED_KEYS` in `domain/projects/config.ts`
carries the four warnings for a config edited afterwards — those three plus
`bindMounts`, which is not imported at all.

**What it reads:** the overlay files, and — for the two passthrough-shaped
keys — this server process's own environment, which is the last reader of an
arbitrary name out of it. That is also the reason the import can only do so
much: the values it is recovering came from a shell on the server's machine,
and under `k8s` the pod's environment holds nothing but what its Deployment
states. A secret whose value it cannot find is imported as a valueless row
with its RULE intact and named in the log, because the rule is the half a
user cannot reconstruct from memory.

It also READS `.credentials/proxy-secrets.json` as the value source for any
secret the environment cannot answer for — which under `k8s` is every one of
them, since a pod's environment holds only what its Deployment states. That
file is the merged map of every value `envSecretProxy` ever resolved, and it
is the last copy: importing valueless rows while deleting it would lose them
outright.

Deleting it is a separate shim with a different trigger,
`sweepLegacyProxySecretsFile` (`drivers/k8s/cluster/legacy-proxy-seed.ts`),
which `ProxyClient.ensureRunning` calls after the proxy Deployment's rollout
has completed. Nothing rolls the proxy when a server starts, so for a while
after an upgrade the pod serving live worktrees is the OLD one, resolving
every injection out of exactly this file — deleting it at startup would take
every running worktree's credentials with it. A completed rollout of the new
Deployment is the proof that the old pod, the last reader, is gone, and the
sweep runs only then, and only when `legacySecretImportPending` says no
overlay still has secrets to be imported out of the file.

The third piece is `scopeLegacySecretRefs`, in the seed below: it rewrites
a persisted registration's bare `NAME` ref to `<projectSlug>/NAME` as the
seed carries it into a registration ConfigMap. Refs were unscoped before;
without the rewrite, a registration written by an older server names refs
the new one never writes, and its injections stop resolving until the
worktree is recreated. The rewrite is exact rather than a guess — a
registration carries the project it belongs to.

**What breaks silently if it is deleted too early:** an install that upgrades
loses its worktrees' environment at the next create, with the config file
still sitting there looking like it says what should happen — the parser
warns, but `console.warn` lands in the server log rather than in the create's
progress stream. The proxy-secrets file is the other half: deleting the sweep
leaves that plaintext on disk indefinitely, which is the thing storing
secrets encrypted was for.

**What breaks silently if it is deleted too early** (the sweep): the file
stays, and it is a plaintext copy of every secret the install ever proxied,
in the directory the proxy pod mounts — which is what storing them encrypted
was for.

**How to tell it is safe to remove:** every install has started once on a
build carrying the importer, and — for the sweep — has rolled its proxy at
least once since. Nothing records either, so in practice this goes at a
release boundary. The importer and the three env warnings go together; the
`bindMounts` warning can outlive them, since it imports nothing and is
purely a message. The ref rewrite goes with the seed, whose own entry says
when.

## `seedProxyObjects`

`seedProxyObjects` (`drivers/k8s/cluster/legacy-proxy-seed.ts`) runs inside
`ensureProxyResources`, before the proxy Deployment is applied, and carries
what an older proxy kept on a hostPath into the objects the current one
reads (docs/worktree-egress.md "What the proxy is told, and how").

**What it reads:** `<dataDir>/global/run/proxy-data` — `ca.key`, `ca.pem`,
`worktrees.json`, `blocked-hosts.json`, `git-auth-failures.json`, the files
the old proxy's `/data` hostPath held — from the server pod's own mount of
the global tier, the first time `ensureProxyResources` finds the
`yaac-proxy-ca` Secret empty beside an old `ca.pem`. The directory was
`<dataDir>/run/proxy-data` when the old proxy wrote it; row 7 of the layout
migration (`migrateDataDirLayout`, below) is what puts it where this looks,
so the two entries go together or not at all. It writes the CA
Secret, one registration ConfigMap per entry (rewriting a bare `secretRef`
to `<projectSlug>/NAME`, which registrations written before refs were
scoped still carry), and the state ConfigMap. The directory is left in
place; nothing else reads it.

**What breaks silently if it is deleted too early:** a proxy that rolls
onto an empty CA Secret mints a new CA, and every process that loaded the
old one at start (running agents, nested containers' baked bundles) fails
TLS against every MITM'd host until its pod restarts; and it comes up with
no registrations, failing every running worktree closed — nothing
re-registers a live worktree. No error names either cause.

**How to tell it is safe to remove:** every k8s install in use has rolled
its proxy once on a build carrying the objects. Directly checkable:
`kubectl -n yaac get secret yaac-proxy-ca -o jsonpath='{.data.ca\.pem}'`
is non-empty on every cluster in use. Then the module goes, and the old
directory may be deleted on each host.

## The pre-object proxy window

Between a server upgrade and the next worktree create, the proxy pod
serving live worktrees is one that reads credentials off its hostPath and
took registrations, secret values and ssh keys over its control API — and
the new server makes none of those calls. Ordinary, not exotic: the proxy
rolls on the next launch (`ensureRunning` finds the Deployment stale), and
the launch registers only after the roll.

**What it reads:** nothing. It is the absence of four calls.

**What breaks silently if it goes too early:** nothing goes; this entry
records the window's cost so it is chosen knowingly. During it, an
allow-host click and a blocked-host record do not reach the server (the
badge stays until the roll); a `yaac auth update` reaches the old proxy
only through the files it still reads, which works; and if the old pod is
REPLACED inside the window (a crash, an eviction), its secret values and
ssh keys are gone with it and nothing re-pushes them, so those injections
stop until the first create rolls it. A worktree create is what closes the
window, so an install that creates nothing after upgrading stays in it.

**How to tell it is safe to remove:** it is prose, not code; it is removed
by deleting this entry once no install can still be running a pre-object
proxy, which drains at the first create after upgrade.

## The `YAAC_SERVER_GIT_*` identity seed

`seedLegacyGitIdentity` (`main/server-run.ts`) writes `YAAC_SERVER_GIT_NAME`
/ `YAAC_SERVER_GIT_EMAIL` into the git-identity preference rows when the
server has none, and `env.legacyServerGitUser` (`shared/src/env.ts`) is the
accessor it reads them through — the only reader left.

**What it reads:** the environment of a server pod deployed before the
identity became a setting. `yaac cluster install` used to snapshot the host's
`git config` into those variables, which is why changing your name needed a
re-install from a shell on that machine; install states neither any more.

**What breaks silently if it is deleted too early:** an install that upgrades
its bundle without re-running `yaac cluster install` has a Deployment still
stating the pair and a database with no identity in it — so every
webapp-created worktree refuses, naming a setting the user has never had to
touch. Loud rather than silent, but for a reason nobody would guess.

**How to tell it is safe to remove:** every k8s install has re-run `yaac
cluster install` on a build that no longer states the pair, at which point
the variables are gone from the Deployment and this reads nothing. The
accessor and the seed go together.

## `adoptLegacyClaudeJson`

`adoptLegacyClaudeJson` (`domain/worktrees/seed.ts`), called once per create,
copies `<project>/claude.json` to `<project>/claude/.claude.json` when the
latter does not exist.

Worktrees used to run with no `CLAUDE_CONFIG_DIR`. claude resolves its global
config at `<$CLAUDE_CONFIG_DIR or the home dir>/.claude.json`, so with the
variable unset the file sat beside the claude home rather than inside it, and
yaac kept it as a sibling of that home and mounted it at `~/.claude.json`.
Every create now names the config dir, which moves the file into the home on
both substrates — and retires the lone `File` mount that used to carry it.

**What it reads:** the old sibling `claude.json`, whose path
`claudeJsonFile()` still returns and which nothing else calls any more. Only
when the new path is absent, so the destination is authoritative the moment it
exists and a re-run can never walk a newer file backwards. The old file is
copied rather than moved: nothing reads it afterwards, it is small, and
leaving it means a downgrade still finds its state.

**What breaks silently if it is deleted too early:** an install that has not
created a worktree since the change starts from an empty global config, and
claude re-derives everything it holds — `hasCompletedOnboarding` and
`lastOnboardingVersion` (the first-run wizard reopens), the
`customApiKeyResponses` approval, the accepted trust roots, and claude's own
`oauthAccount` and migration bookkeeping. `seedClaudeJson` immediately rewrites
the first three, so the visible damage is narrower than it looks and lands on
what only claude wrote: the account record, and the trust roots for any
directory outside the ones the seed names. Nothing errors, and the worktree
looks new rather than broken.

**The one way it can discard newer state**, which the copy-never-overwrite
rule does not cover: a worktree that was already running before the upgrade
still has the old `File` mount, so its claude goes on writing the sibling. Any
of that written *after* a later create has adopted the copy — a refreshed
`oauthAccount`, a trust root accepted in that worktree — lands in a file
nothing reads again. It is bounded (those writes are rare, and the window
closes when that worktree is recreated on the new layout), and there is no
version-floor scheme to detect it, which is why the destination stays
authoritative rather than trying to merge by timestamp.

**How to tell it is safe to remove:** when no data dir in use still has a
`claude.json` beside a project's claude dir. Unlike a sweep there is nothing to
watch drain — the copy leaves the old file in place — so the honest test is a
season after release, or a look in the data dirs that matter.

## The pre-envelope spawn channel

`yaac-spawn` became `yaac-mama`, and a single-purpose spawn queue became a
command envelope. Three pieces exist only to carry installs across that.

**The proxy's `/spawn` path and `/tools` endpoint** (`k8s/proxy/proxy.ts`,
`LEGACY_SPAWN_PATH` in `mama-queue.ts`). A worktree's helper scripts are
File-mounted read-only at create and never replaced, so every worktree
created by an older yaac has the old `yaac-spawn` on its PATH for its whole
life — posting a prompt as a text body with `tool`/`model` in the query
string, and asking `/tools` for `--models`. Both are still served; `/spawn`
maps to `command=create`. Delete them and those worktrees get a 404 from a
command that used to work, with nothing to suggest the fix is to restart the
worktree. Safe to remove once no worktree predating this change is still
running — a restart re-stages the scripts, so this drains on its own; it does
not need users to do anything except restart worktrees eventually.

**The server's fallback drain** (`fetchLegacyPendingSpawns` and
`legacySpawnQueue` in `drivers/k8s/egress/proxy-client.ts`). This one is the
reverse direction and is *ordinary*, not exotic: the server upgrades first,
and the proxy Deployment only rolls on the next worktree launch, so between
those two moments a new server is talking to an old proxy that serves
`/spawn/pending` and 404s `/cmd/pending`. The fallback drains the old queue
and posts results back in the old shape. Deleting it early does not break
loudly — the drain just fails, logged as `[mama] reconcile failed`, while
in-worktree commands from every running worktree time out at 120s until
something happens to create a worktree. **Remove this before the proxy's
`/spawn` path, never after**: it is the half that keeps working during the
window, and the proxy half is what it talks to.

**The `spawn` proxy event** (`dispatch` in `drivers/k8s/egress/proxy-events.ts`
accepts `mama` and `spawn`). Same window as the fallback drain, and the same
fix: an old proxy announces a queued request as `spawn`. Without it the
server still drains on its 60s resync, so the failure is a slow spawn rather
than a broken one — the quietest item here, and the reason it is written down.

## The spent-mountpoint reclaim in `reconcileSharedSkillRoots`

`reclaimSpentMountpoint` (`domain/skills/builtin.ts`) rmdirs an empty
directory sitting at a builtin skill's name in a project's shared skills root,
so the `link` delivery can put its symlink there. What it reads is a directory
a pod run left behind: under k8s each builtin is delivered as a mount at
`<root>/<name>`, and the mountpoint outlives the pod.

Only the reclaim is a shim. The `link`/`mountpoint` conversion around it is
permanent — an install may switch substrates in either direction at any time,
and each delivery has to undo the other. What dates this is ownership of the
mountpoint: the `mountpoint` delivery now creates those directories itself, so
they are server-owned and get cleaned up by the same code that made them.
Installs that ran an older k8s yaac have kubelet-created, **root-owned** ones,
which is the case this exists for — and the case it can only report, since a
server running as the user may not be able to remove one.

Deleted too early, a builtin skill is silently absent from every worktree of
an affected project: the name is taken by an empty directory, discovery
(which reads the install dir, not these roots) still lists the skill in the
web app, and the agent simply never sees it. That gap between what the viewer
lists and what the agent has is the whole failure mode — there is no error.

Safe to remove once no install can still hold a mountpoint this yaac did not
create. There is no flag to check for that; the practical test is per install,
and it is a `find` rather than a version: `find
<data>/global/projects/*/{claude,codex,opencode-config,pi}/**/skills -maxdepth 1
-type d -empty -user root` naming nothing. Removing it early costs nothing on
an install that has always run one driver, since a root-owned mountpoint can
only exist where k8s ran.

## The optional lease fields on the server lock

`ServerLock` gained three fields when the server became a pod
(docs/server-in-cluster.md): `instance` (identity, since a pid does not
identify a server across pods), `host` (whose pid namespace `pid` belongs to),
and `heartbeatAt` (the renewed lease). All three are OPTIONAL in
`isServerLock`, and `isSameHostLock` reads an absent `host` as this host.

**What it reads:** `.server.lock` in the data dir, written by a server that
predates the lease.

**What breaks silently if it goes too early:** nothing silently — but the
loud version is bad. A lock without the fields would stop parsing, so
`readLock` would return null, `acquireLock` would classify the file as garbage
and unlink it, and a second server would start beside the one still running —
two writers on one PGlite directory. That is precisely the window an in-place
upgrade opens: the CLI is new, the running server is not, and the lock on disk
is whatever the running server wrote. The fields being optional is what makes
that upgrade a `yaac server restart` rather than a corrupted database.

**The absent-`host` reading has one reader it is wrong for**, and the guard
against it is part of this shim rather than separate from it. `isSameHostLock`
answers "this host" for a legacy lock, which is true for every host-side
reader and false inside the server POD — which would then judge the lock by
`pidExists` in its own pid namespace, find the host's pid absent, call a live
server's lock stale and take it. Nothing in the pod can tell the difference,
so the check lives where it still works: `deployServerWorkload` refuses to
apply the Deployment while a host lock is live, on the host, before the pod
exists. Remove that guard only together with the `undefined` branch above —
on its own it is the only thing standing between the documented upgrade and
two writers.

**How to tell it is safe to remove:** every server that could still be holding
a lock writes the fields, i.e. no install can restart into head with a
pre-lease server already running. There is no version floor recording that,
so in practice this goes when a release boundary makes it safe to say so — and
when it does, `isServerLock` requires all three and `isSameHostLock` loses its
`undefined` branch together, in one change. Do not tighten one without the
other: requiring the fields while `isSameHostLock` still special-cases their
absence leaves a dead branch that reads as deliberate.

## The pre-client-local read fallbacks

`server.json`, `.auth-daemon.lock` and the `driver` record are CLIENT-LOCAL:
they live in `<dataDir>-client`, beside the install rather than inside it,
because the k8s server is a pod that mounts the data dir and none of the three
is the server's (docs/server-in-cluster.md). Every install created before that
tier existed has them INSIDE the data dir, so each reader tries the current
path and falls back to the old one: `readServerConfig`
(`shared/server-config.ts`), `readAuthDaemonLock` (`shared/auth-daemon.ts`)
and `recordedDriver` (`shared/install-driver.ts`).

**What they read:** `<dataDir>/remote.json`, `<dataDir>/.auth-daemon.lock` and
`<dataDir>/driver`, written by a client or an installer that predates the
split — at the data dir ROOT, which the readers spell out with
`path.join(getDataDir(), …)` because no tier helper names the root any
more: the storage tiers are folders under it now (below), and
`serverLocalPath` would send them to `server-local/`, where these files
never were. The two locks are also *deleted* at the old path by their
writers, so a migrated install cannot be found through a stale one.

**What breaks silently if they go too early:** each one, differently, and all
three quietly.

- `remote.json` is how every client reaches the server. Lose it and
  `resolveServerTarget` reports that no server is selected — for an install
  whose server is up and healthy. `readServerConfig` returns null for an
  unreadable file exactly as for an absent one, so there is no error to read.
  The recovery is real (`yaac server start` or `yaac cluster install` rewrites
  it) but nothing points at it.
- `.auth-daemon.lock` losing its old path means `ensureAuthDaemon` cannot see
  a daemon that is already running, and starts a second one against the same
  server.
- The `driver` record is the tripwire in `assertHostServerAllowed`. Lose it and
  a `yaac server start` on a k8s install is no longer refused — it spawns a
  host server beside the pod, which is two writers on one PGlite directory and
  a reaper that sees every worktree as podless.

**How to tell it is safe to remove:** every install that could still be read
has written each file at least once since the split — for `remote.json` and the
`driver` record that means having run `yaac server start` or `yaac cluster
install`, and for the daemon lock any `yaac auth` flow. There is no version
floor recording it, so in practice this goes at a release boundary that makes
it sayable. The `remote.json` entry here must outlive the `server.json` rename
fallback below it, or the chain has a hole in the middle: a pre-split install
is found only by going `server.json` → client-local `remote.json` → data-dir
`remote.json`, in that order.

## `remote.json` → `server.json`

The client config was named for the only kind of server it could once point
at. It now names every server — `yaac server start` registers the host server
it spawns there, exactly as `yaac cluster install` registers the Deployment —
so it is `server.json`, and it carries the install's `driver` alongside the
origin and token.

**What it reads:** `<clientLocalRoot>/remote.json`, tried after
`server.json` and before the data-dir path above (`readServerConfig`). The
first `writeServerConfig` moves the content to the new name and deletes both
old files, so a migrated install cannot be found through a stale one — and a
live bearer token is never left behind at a path `clearServerConfig` would
later miss.

**What breaks silently if it goes too early:** a machine that has not written
since the rename resolves no server at all. Every client then reports "No yaac
server selected" for a server that is up and healthy, with no error naming the
file it could not find.

**How to tell it is safe to remove:** every install has written the file once
since the rename — any `yaac server start`, `yaac cluster install`, or `yaac
remote set` does it. Remove it only after the data-dir fallback above, never
before.

## The `driver` record inside `server.json`

Which substrate an install runs used to be its own one-word file, written by
the server process at boot. It is now a field of `server.json`, written by
whichever COMMAND stood the server up — so the one write that points this
machine at a server also says what kind of install it is, and a foreground
`yaac server run` (which registers nothing) no longer half-records an install.

**What it reads:** `<clientLocalRoot>/driver`, then `<dataDir>/driver`, when
`server.json` carries no `driver` field (`recordedDriver`, via
`readLegacyDriverRecord`). The standalone files are not deleted on write —
nothing reads them once the field exists, and leaving them costs a stale word
on disk rather than a stale credential.

**What breaks silently if it goes too early:** a k8s install whose
`server.json` has no `driver` stops being refused a host `yaac server start`.
That is two writers on one PGlite directory, and a reaper that sees every
worktree as podless. Nothing reports it; the second server simply comes up.

**How to tell it is safe to remove:** every install has written `server.json`
once since the change — the same condition as the rename above, and it really
is the same condition, because `writeServerConfig` folds this file into any
config that lacks the field. That fold is what makes the claim true for the
selection writers as well as the registrars: `yaac remote set`, `remote
on|off` and the desktop's add/switch all go through `withServerSelected`,
which carries `driver` only from an `existing` config that already had it, so
without the fold a `remote set`-only upgrade would write a `server.json` that
outranks this file while saying nothing about the install. Do not remove the
fold and this entry separately: the fold is what retires the file, and
deleting the fold first strands every install that has not run `yaac server
start` or `yaac cluster install` since.

## The `cluster-install` token name

The durable token a machine holds for its own server was minted by `yaac
cluster install` alone, and named for it. Both substrates mint it now, so it is
`local-client`, and `mintLocalClientToken` revokes BOTH names before creating
the new one.

**What it reads:** nothing on disk — it issues `DELETE /tokens/cluster-install`
against the server being registered.

**When it fires:** only on a re-mint, which means only when the saved token was
REJECTED or there was none. The common upgrade path never reaches it: an
upgraded k8s install has a `cluster-install` token saved for the published
origin, `registerServer` probes it, it still authenticates, and it is reused
under its old name. So on a healthy install this token is not an orphan at
all — it is the live, selected credential, and it keeps the name indefinitely.

**What breaks silently if it goes too early:** an install that DID re-mint
(its old token had been revoked) keeps the old-name entry in its store: a
durable credential nothing references and no one will think to revoke.

**How to tell it is safe to remove:** no install's `server.json` still holds a
token minted under that name — which, since the reuse path never renames one,
is in practice a release boundary rather than something a command reports.

**Order:** the three are independent of each other and may go separately. The
`driver` fallback is the one to keep longest — it is the only one whose loss
corrupts a database rather than inconveniencing a client.

## `migrateDataDirLayout`

`migrateDataDirLayout` (`shared/data-dir-layout.ts`) moves a data dir
written before the storage tiers were folders into the three-folder layout
— `global/`, `server-local/` and `node-local/` under the data dir root.
It runs on a host and never in the server pod (where the roots are mounts
and a rename across claims would be a copy), at three call sites, each
before anything else reads the data dir: `runServer` and `startServer`
(`main/server-run.ts`, `main/lifecycle.ts`) ahead of `ensureDataDir` and
the lock read, and `deployServerWorkload` (`install/server-deploy.ts`)
after `refuseIfHostServerRunning` and after the server Deployment — if one
exists — has been scaled to zero and its pod is gone. Only then is the data
dir quiescent: the old pod holds PGlite open by path, and renaming `db/`
under it is a corrupt or stranded database.

**What it reads:** these rows, on the host, each one `rename(2)` in this
order —

| # | From | To | Tier |
|---|---|---|---|
| 1 | `secret.key` | `server-local/secret.key` | SERVER-LOCAL — first, so no state can exist in which a database has moved without its key |
| 2 | `.credentials/` | `server-local/.credentials/` | SERVER-LOCAL |
| 3 | `db/` | `server-local/db/` | SERVER-LOCAL |
| 4 | `build/` (Dockerfile.user and its context) | `server-local/build/` | SERVER-LOCAL |
| 5 | `models/` | `server-local/models/` | SERVER-LOCAL |
| 6 | `projects/` | `global/projects/` | GLOBAL |
| 7 | `run/proxy-data/` | `global/run/proxy-data/` | GLOBAL — what `seedProxyObjects` reads |
| 8 | `server.log` | `server-local/server.log` | SERVER-LOCAL — a MERGE, not a rename: the migrating command's own `[layout]` lines land in the new file through `serverLog` before this row runs, so the old file's lines are written ahead of them |
| 9 | `global/projects/<slug>/.cached-packages/` | `node-local/projects/<slug>/.cached-packages/` | NODE-LOCAL, per slug, after row 6 |
| — | `.server.lock` | never moved | a live one refuses the run, a stale one is unlinked |
| — | `shared-images/` | moved when it can be | its generations are root-owned, and `rename(2)` of a directory into a new parent needs write permission on it; when refused, it is a re-derivable cache and the log prints the `sudo rm -rf` |
| — | `run/ssh-pub/` | deleted | content-keyed public-key files, regenerated on demand |

All or nothing: a row that fails for any reason other than "source
absent" aborts with the row named and the server does not start. A partial
run is not a corrupt state — every completed row is atomic, and the next
run resumes at the first row whose source still exists — and the row order
is what makes that true. An EMPTY existing destination is treated as
absent (so an `ensureDataDir` that ran first cannot shadow a full
`projects/` with an empty `global/projects`); a NON-empty one beside a
still-present source is refused, naming both, rather than guessed at.
`remote.json`, `.auth-daemon.lock`, `driver` and the harness's `e2e-tmp`
at the root are not on the table and stay where their readers look.

**The checkpoint placement is recorded here too.** `opencodeCheckpointDir`
(GLOBAL) is deliberately the pre-split node-local location inside the
projects tree, `global/projects/<slug>/opencode-data/<id>`, so row 6 is
also what carries every stopped opencode worktree's history into place
with nothing to convert. Renaming the checkpoint dir later is a migration
of that history.

**What breaks silently if it is deleted too early:** an install that
upgrades without it comes up with no projects (`global/projects` is empty),
an empty `server-local/db`, no credentials and a fresh
`server-local/secret.key` — every project and worktree row is gone from
every listing while the checkouts sit one directory over, every credential
is missing, and every sealed row that still exists is unreadable, with no
error anywhere, because that is exactly what a fresh install looks like.
Its node-local row is cheaper to lose (a cold pnpm store), but it is the
same function.

**Order against every other shim.** All of them read through the tier
helpers, so once the migration has run they find the moved location; none
may run before it, and the call placement above is what guarantees that.
`importLegacyProjectConfig` is the reason the migration is all-or-nothing:
run on a tree where `projects/` had moved but `.credentials/` had not, it
finds the overlays, finds no values, imports valueless rows and STRIPS the
keys from the overlays — after which the values still sitting in the
un-moved file are orphaned for good. `seedProxyObjects` reads row 7's
destination; `adoptLegacyClaudeJson`, the agent-links strip, the
spent-mountpoint reclaim and `sweepLegacyVclusterState` all read under
row 6's. This entry therefore outlives every one of them.

**What the pre-upgrade k8s pods hold.** A worktree pod created before this
step bind-mounts `projects/<slug>/…` by its old hostPath. A bind mount
holds its dentry, so renaming an ancestor underneath it leaves the running
pod's view intact; those pods keep working until they stop, and the new
server addresses the same bytes under the new names.

**How to tell it is safe to remove:** no data dir in use has `projects/`
or `db/` at its root — directly checkable with
`ls "${YAAC_DATA_DIR:-$HOME/.yaac}"` showing only the three tier folders
(and the pre-client-local files, which have their own entry) on every
install that matters.

## The `node-local-mount` advisory

`noteNodeLocalMount` (`install/install.ts`) and the `node-local-mount`
gate of `yaac cluster check` (`install/check.ts`) say when a kind node does
not bind `<dataDir>/node-local` at `/var/lib/yaac/node/<hash>`. A tripwire
about state, not a shim in the data path: kind writes extraMounts at
create time, so a cluster created before the node-local one existed keeps
its caches (pnpm stores, image stores, opencode working copies) on the
node container's own disk — correct, and lost with the node.

**What it reads:** `podman exec <node> findmnt <path>`, on kind nodes only.

**What breaks silently if it goes too early:** nothing. A user with an
old cluster simply stops being told why their pnpm store is cold after
every podman-machine restart.

**How to tell it is safe to remove:** when no kind cluster in use predates
the mount, which `kubectl get nodes -o yaml` cannot say — a season after
release.

## The pre-split lock fallback in `readLock` / `removeLock`

`readLock` (`shared/lock.ts`) reads `<dataDir>/.server.lock` when
`<dataDir>/server-local/.server.lock` is absent, and `removeLock` unlinks
whichever of the two the read found.

**What it reads:** the lock a server from before the storage-tier split
wrote, at the data dir root. It exists for one window: such a server is
still running when the CLI upgrades. `yaac server start` must see it — it
would otherwise spawn a second writer onto the same database — and `yaac
server stop` must be able to stop it. The migration above is what refuses
to rearrange the data dir under it in the meantime.

**What breaks silently if it goes too early:** that second server, on a
database the first one still holds open.

**How to tell it is safe to remove:** no pre-split server can still be
running — a release boundary, since nothing records a server's build.
Remove it together with `migrateDataDirLayout`'s lock handling, which is
the other half of the same window.

## A note on evidence

No test here can fail. The suite runs against a database and disk it just
created — the state in which every one of these is already a no-op — so green
says nothing about any of them, and prose entries have no executable form at
all. That is the reason this is a list rather than a check.
