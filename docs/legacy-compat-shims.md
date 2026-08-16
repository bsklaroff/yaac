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
grep -rl '/etc/yaac/agent-links.sh' "${YAAC_DATA_DIR:-$HOME/.yaac}"/projects/*/claude/settings.json
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
<data>/projects/*/{claude,codex,opencode-config,pi}/**/skills -maxdepth 1
-type d -empty -user root` naming nothing. Removing it early costs nothing on
an install that has always run one driver, since a root-owned mountpoint can
only exist where k8s ran.

## A note on evidence

No test here can fail. The suite runs against a database and disk it just
created — the state in which every one of these is already a no-op — so green
says nothing about any of them, and prose entries have no executable form at
all. That is the reason this is a list rather than a check.
