# The containerless driver

yaac runs a worktree on one of two substrates. The `k8s` driver gives each
worktree a single-pod Job in a local cluster, built from an image and
reached through an egress proxy. The `containerless` driver gives it a tmux
server on the host, in the checkout the server already made — no image, no
cluster, no proxy, and no sandbox.

It exists for machines the first one cannot run on (podman and kind are a
tall order on macOS, and impossible on a locked-down laptop) and for people
who want their agents working on the real machine rather than a copy of it.
What it costs is the isolation: an agent in a containerless worktree runs as
the user running yaac, with that user's access to the filesystem, the
network and everything else. Choosing this driver is consenting to that.

```
yaac server start        # this driver: a host server IS the containerless one
yaac host check          # the parallel of `yaac cluster check`
```

There is nothing to select. **Placement is the driver**: the k8s server is a
pod of the cluster it manages (docs/server-in-cluster.md) and this one is a
process on your machine, so `yaac server start` means containerless and
`yaac cluster install` means k8s. A start notices which of the two it is and
records the answer beside the lock, because the answer outlives it — a
client that cannot reach the server has to know whether the fix is a start
or an install.

The two kinds never meet on one data dir: a host start against a data dir
recorded `k8s` is refused, and `yaac cluster install` refuses to run against
a containerless install. That matters because the crossing is irreversible
in one direction — a k8s server cannot see a tmux worktree, so it would reap
rows whose pods it cannot find and its teardown would remove the very state
dirs the markers live in, leaving the agents running as the user and
unreachable.

## What a worktree is here

The tmux server is the unit — the thing the Job is under the other driver.
Its existence means the worktree is up, its death means the worktree is
gone, and it deliberately outlives the yaac server that started it: `yaac
server restart` must not stop anyone's agent.

Each worktree gets its own tmux server, on its own socket. That is the one
thing this substrate must not share: a single socket would put every
worktree on one tmux server, where `has-session -t yaac` and
`respawn-window -t yaac:<tool>` answer for whichever worktree got there
first. The sockets live under the OS temp dir rather than the data dir
because `sockaddr_un.sun_path` is about 104 bytes on macOS and a data-dir
path is longer than that; they are keyed by the install's own root so two
servers on one host never collide.

The session's shape is identical to the one `worktree-bin/yaac-worktree-init`
creates inside a pod, and has to be: the long-sleep placeholder the stale
reaper recognizes, the `yaac:<tool>` window naming the status watcher parses,
and the tmux options the webapp's terminal rendering depends on are all read
by driver-neutral machinery that cannot tell the two substrates apart.

The placeholder is the one line that cannot be copied verbatim. A pod's is
`sleep infinity`, which is a GNU coreutils extension; here the command runs
on whatever `sleep` the host has, and the BSD one on macOS rejects that
spelling — the placeholder would exit at once, tmux would close its only
window, and the session would be gone before anything asked for it. So this
one counts (`sleep 2147483647`). What the reaper's probe reads is
`pane_current_command`, so both spellings answer `sleep` and the
driver-neutral half is none the wiser.

## Paths, and the vocabulary that carries them

Every tmux invocation, `git -C` call and prompt script the layers above yaac's
drivers author is written against `WorkspacePaths` — the driver's answer to
"where are this workspace's things, as the workspace sees them". A pod
driver answers with fixed container paths, because each pod has its own
mount namespace. This one answers per-worktree, because they share a
filesystem.

| | k8s | containerless |
|---|---|---|
| checkout | `/workspace` | `~/.yaac/projects/<slug>/worktrees/<id>` |
| project git dir | `/repo/.git` | `~/.yaac/projects/<slug>/repo/.git` |
| tmux socket | `/tmp/yaac-tmux/server` (pod-local) | `$TMPDIR/yaac-cl-<hash>/<id>.sock` |
| scratch | `/tmp` | the worktree's own state dir |
| ACP record | `/home/yaac/.yaac-acp` (mounted) | `~/.yaac/projects/<slug>/acp/<id>` |

The ACP record is the one row the driver does not get to answer freely. Under
k8s the container path is a mount whose host side is the shared project
location, and that location is what every reader above the driver opens — the
chat pane's tail, the registry's first-prompt scan, a stopped worktree's
transcript. So this driver names it directly. It is also the one per-worktree
path that must outlive the state dir, which a stop removes: a stopped
worktree's conversation stays readable (docs/agent-modes.md).

Because the checkout the agent sees IS the one the server made, there is no
git plumbing to re-point: the create path skips the in-pod gitdir rewrite
entirely, and the review diff is host `git` run in that directory rather
than an exec into anything.

## Mounts become symlinks

The driver contract already anticipates this — "a host-process driver reads
a hostPath as a bind or a symlink". A symlink here, because a real bind
mount needs root and running yaac as root to open a worktree is not a trade
this mode is for. Each worktree gets a private `$HOME` under its state dir,
with the project's tool homes (`claude`, `codex`, `pi`, the opencode config)
linked into it, and a private bin dir on `PATH` holding the helper scripts a
pod would find in `/usr/local/bin`.

That layout is HOME-relative, and this driver inherits the host environment —
where the server's user may well have pointed a tool somewhere else. Left
alone, the failure is silent and looks like success: the agent reads the
server user's config, with that user's real credentials in it, and writes its
transcripts where yaac's discovery never looks.

So a worktree gets its tool homes two ways. Where a tool has a real home
override, every create **names it** — `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
`PI_CODING_AGENT_DIR`, and pi's session dir — on both substrates, in the one
vocabulary the layers above drivers are written in: the container layout. A
pod's homes already ARE those paths. Here each is translated to the directory
its mount came from, which is the project's own. Where a tool has none, the
home is reached `$HOME`-relative through the staged links, and the only
defense is that nothing redirects it — so every variable that could is
**cleared** on the way in, alongside the server's own `YAAC_*` wiring. The
named ones are cleared too, so "no host tool-home value survives" holds on
its own rather than only while every create remembers to re-supply one.

opencode is why the cleared half cannot simply be replaced by naming things.
It has no home override at all: `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG` and
`OPENCODE_CONFIG_CONTENT` are additional config *inputs* — the first is
pushed onto the list of directories it loads from, so a host value injects
the server user's opencode config, and any provider keys in it, no matter
what else is set. Its actual homes come from `XDG_CONFIG_HOME` and
`XDG_DATA_HOME`, which cleared resolve to the staged links.

That translation lands on the mount's **source**, not on the workspace's own
`$HOME/<tool>` link to it, though the two resolve to the same files. What
differs is the string, and a tool that keys anything on the string sees a
different home per worktree, because the private home is per worktree while
the staged dir is per project. claude is the proven case: it names its macOS
Keychain item after a hash of this exact value, and on the first token
refresh — the item being empty — it migrates the credential in and deletes
the `.credentials.json` it came from. Per-worktree strings would mean the
first refresh anywhere took away the shared file every other worktree of the
project still authenticates from. Because the rule lives in the translation
rather than at each call site, that is not something a future caller can get
wrong by writing the obvious thing.

Naming a config dir also moves what lives in it. claude resolves its global
config at `<$CLAUDE_CONFIG_DIR or the home dir>/.claude.json` and never
probes the other, so the seeded onboarding state, API-key approval and trust
roots live in the `.claude.json` **inside** the claude home — on both
substrates, since both name the dir. That is also why it needs no mount of
its own: it is a file in a directory already carried, rather than a lone
`File` mount beside it. `settings.json` and `.credentials.json` never needed
the care, having always been written inside that dir.

That migration is also why signing out clears both places. By the time anyone
runs `yaac auth clear` (or signs out in the webapp — the same door), the live
token may exist only in the Keychain, so removing the file alone would leave
a working credential behind while reporting the account signed out. The item
is per project because the config dir is, and the delete refuses the
un-suffixed service, so the user's own claude install is never touched.

Any of this taking effect is reported, because being right here is otherwise
invisible — nothing inside the worktree looks different, so a user whose
shell has said for years that opencode lives elsewhere would have no way to
learn that yaac disagrees. `yaac host check` names them ahead of any create,
and a create says so in its progress output, reporting only what the
workspace actually ends up without.

Two kinds of mount are deliberately not realized. A redirect INTO the
checkout — `node_modules`, a cache volume under `/workspace` — is left alone:
a pod mounts those onto other storage and git never sees them, but a symlink
is not a mount, so git reports it untracked (an agent running `git add -A`
would commit an absolute host path) and the ephemeral-modules guard trips on
the driver's own link. Nothing is lost that this substrate needs, since the
checkout is already on the host's own disk; what is lost is the per-worktree
module cache, which was a pod-storage optimization.

The other thing symlinks cannot do that mounts can is nest. A pod mounts the
project's claude dir at `/home/yaac/.claude` and then a builtin skill at
`/home/yaac/.claude/skills/<name>` on top of it. Here the first is a link
into shared project state, so writing the second would reach through it and
leave one worktree's staging in a directory every other worktree reads. Such
a mount is skipped and logged; nothing routinely asks for one, because the
one caller that did now writes host state instead (see below). Anything with
no host equivalent at all fails the create rather than being silently
dropped.

## Builtin skills, shared per project

yaac's own skills reach a pod as a per-worktree staging mounted read-only
over each tool's personal skills root. There is no mount to layer here, so
worktree create links them into the project's shared skills roots instead —
`<data>/projects/<slug>/{claude,codex,…}/skills/<name>` pointing at the
install's `builtin-skills/<name>` — which is exactly where the tool homes a
workspace gets are links to. All four tools' roots are written, as under a
pod, so the skills are there whichever tool a worktree runs.

Per project rather than per worktree is the same bargain the credentials
are: the dirs they land in are already shared, and there is no boundary here
that could make the scope narrower. Linking rather than copying is what
keeps them in lockstep with the running yaac version — an upgrade moves
every worktree at once, with nothing staged that could go stale.

Only yaac's own links are ever written or removed there. A name the user
owns — a real skill directory, or a link of their own aimed outside a
`builtin-skills` dir — is left alone, so a personal skill wins its name. A
link into a dir of that name is the ownership record: one pointing at an
install that moved is re-aimed on the next create, and one whose skill is no
longer shipped is removed there, which is the only place a retired skill
would ever be cleaned up. Ownership is per machine rather than per install,
because a versioned global install moves on every upgrade and its links are
recognizable by nothing else. Two live installs sharing a data dir therefore
reconcile the same roots, and will differ over any skill only one of them
ships.

Both substrates put something at the same name, so one function
(`reconcileSharedSkillRoots`) owns both deliveries and takes which one to
converge on as an argument — because an install can switch between them, and
each has to be able to undo the other. A pod run leaves an empty directory at
every mounted name; that is not a skill by any reader's definition, so the
link delivery reclaims it rather than reading it as a name the user took. The
mount delivery does the mirror, replacing a link of ours with the empty
directory a pod mounts over — a link here would aim at an install path no pod
can resolve. It also creates those directories itself, so the server owns
them: a mountpoint the kubelet has to create is root-owned, and then nothing
running as the server can clear it. Either delivery claims only a name this
install SHIPS, and both run on every create and every restart, so a switched
install heals per project on first use.

The pod's mount is read-only and a symlink is not, so writing what looks like
a personal skill at `~/.claude/skills/<name>/SKILL.md` writes through into the
install — an npm install loses it on upgrade, a dev checkout gets its working
tree edited for every project on the machine. It is consistent with the rest
of this substrate (an agent here can reach the install either way), but the
mount made it impossible by accident and this does not.

The link cannot simply be made read-only. A symlink carries no permissions of
its own, so a `chmod` follows it onto the install's real files — where taking
write away breaks the two things that must be able to replace them: an
upgrade, and a checkout of the repo that ships them in a dev install. Getting
the mount's read-only property back would mean linking at a frozen copy
instead, which costs the lockstep above. Switching a project
back to the k8s driver also stops the pruning, since it only runs on a
containerless create: shipped names are shadowed by the pod's own mounts, and
a skill retired while the project is on k8s leaves a link that dangles in-pod
until the next containerless create removes it.

The skills reach both substrates unchanged, so what they tell an agent to run
may only assume what a host has. There is no session image here to supply the
utilities a pod's `Dockerfile.default` installs, and the same goes for the
helper scripts in the private bin dir. `jq` is the one that keeps coming up:
GitHub JSON is filtered with `gh`'s own `--jq` flag — gh embeds a jq engine —
rather than a `| jq` pipe, and `yaac-watch-prs` therefore preflights only `gh`.
Paths are the other one: a checkout is at `/workspace` only in a pod, so a
helper that needs the repo derives it from where it was invoked (`git
rev-parse --show-toplevel`) and keeps `/workspace` as a fallback, never as the
default.

## Credentials, and why they are real

Under the k8s driver a worktree never holds a real credential: it gets a
sentinel, and the egress proxy swaps it for the real token on the way out.
There is no proxy here and nothing to do the swapping, so a sentinel would
simply be what the agent authenticated with. Containerless worktrees
therefore get the real thing — real OAuth bundles in the per-project tool
homes, real API keys and `GH_TOKEN` in the workspace environment.

This is not a weakening of the sandboxed path; it is the same bargain stated
plainly. There is no boundary between the agent and this machine, so there
is nothing to withhold a secret from. If that is not acceptable for a given
project, that project wants the k8s driver.

### Where the live credential is, and how it gets back

Holding the real bundle means the agent also REFRESHES it. OAuth refresh
tokens rotate, so the moment an agent does, the project's tool home holds the
live credential and the host store holds a spent one — and spending a spent
refresh token does not merely return stale data, it fails, and for Codex
(single-use) it can strand the chain. Under k8s this never arises: the
workspace holds a sentinel and every refresh transits the proxy, which writes
the host store on the way past. There is no proxy here, so the loop is closed
in the server instead, by `#domain/auth`'s credential-sync.

One rule: **the newest credential wins, and both sides converge on it.**
Harvest carries a project's refreshed bundle up to the host store; push
carries the host store's back down to projects that are behind. Seeding a
project is those two in order, which is what makes it safe to run on every
worktree create — the write can only ever move a project forward, where a
plain write of the host copy would spend the rotation of every worktree
already running there.

Three properties do the work:

- **A sentinel is never a credential.** It cannot be harvested and does not
  count as a project being up to date. That is what lets the same functions
  run under either driver — under a mediated one every project reads as
  having nothing to offer — and it is what keeps a chained yaac-in-yaac
  install, whose "real" credential IS the outer proxy's sentinel, from being
  adopted or overwritten.
- **The Keychain is where a Claude credential ends up on macOS.** claude
  migrates it into the item its `CLAUDE_CONFIG_DIR` names on first refresh
  and deletes the file, so a file still sitting there is by definition the
  older of the two and the harvest reads the item first. Pushing works by
  subtraction: write the file, then drop the stale scoped item, so claude
  reads the fresh file and re-migrates it. Nothing mints an item — the
  account name inside one is claude's to choose.
- **The host does not refresh a credential something else is holding.** With
  a workspace live, a host-side rotation would invalidate the copy the
  running agent is using, so the plan-usage cycle harvests and queries with
  whatever the agent produced instead, and refreshes only when nothing is
  live. A briefly missing usage readout is the acceptable cost; logging a
  running agent out is not.

Convergence runs where staleness would bite rather than from a watcher:
before a host-side refresh, before seeding a create, on attach, on worktree
stop, and on the reconcile resync behind a five-minute floor (the sweep reads
every project, and on macOS that means spawning `security` per project).
Cross-project divergence heals through the same path — each project keeps its
own copy, so one project's agent rotating the shared token leaves the others
behind until the push hands them the winner.

An explicit sign-in is the one write that ignores newest-wins: it is the user
saying which account this install uses, possibly a different one, so it is
forced out to every project.

### The one credential this server never refreshes

A refresh grant is the only upstream call that MUTATES a credential — the old
refresh token is spent and a new one issued — so whoever holds the old copy
and does not learn the new one is signed out. That makes a placeholder refresh
token something this server must never present, and the grants themselves
refuse it (`mayPresentRefreshToken`).

A sentinel means the real credential belongs to an install above this one,
which hands this server a placeholder and swaps it on the way out — the
chained yaac-in-yaac shape. Presenting it makes that install's proxy
substitute the real token and rotate it, while this server receives sentinels
back and stores nothing; the outer store is left holding a token the rotation
already spent, and every worktree using it fails on its next refresh.
Refreshing a credential this install does not own is never its job.

The same mechanism is why the test suite forbids refresh grants outright
(`YAAC_E2E_NO_TOKEN_REFRESH`, set in the shared vitest setup and in every
spawned test server's environment). A proxy rewrites the `refresh_token` body
param of anything POSTed to a token endpoint without checking what the request
carried, so a suite running inside a worktree rotates the hosting install's
live credential no matter how obviously fake the token it presented. Fixture
expiries are not a defense: they decide whether a refresh is attempted, and
the attempt is already the damage.

Git is where that has to be spelled out, because a workspace here is cut off
from the credential twice over. The checkout's `origin` is deliberately
tokenless — the clone strips it, and every server-side call re-injects per
invocation — and the private `HOME` hides the user's own `~/.gitconfig` and
`~/.ssh`. Under a pod neither matters, since the proxy injects the credential
in flight. So the launch is handed the resolved credential on the spec and
writes it into the workspace's own home: an HTTPS token becomes a line in
git's credential store (`$HOME/.git-credentials`, which is the store's
default file, so the helper needs no argument).

An SSH key does not go into the home at all. The launch starts an
**ssh-agent per worktree**, detached beside the tmux server, and pipes the
key into `ssh-add -` — so the private half exists in two process memories
and in neither filesystem. What lands in the home is the PUBLIC half, which
`GIT_SSH_COMMAND` names with `-i` under `IdentitiesOnly` to pin ssh to that
identity (naming none would let it offer every key the agent holds against a
host that may lock the account out). The agent's pid goes in the workspace
marker, so teardown ends it and a recovery scan can tell a live one from a
stale socket; the key therefore lives exactly as long as the worktree. That
matters because a state dir OUTLIVES a workspace whose host rebooted, until
somebody presses stop — which is also why the recovery scan clears the
credential store of a workspace it finds dead. Under a pod none of this
applies: the proxy forwards its own agent. Host verification is unchanged
either way — the same project-scoped known_hosts the pod path writes.

Two details keep that deterministic rather than dependent on the host. The
helper list is reset before `store` is added, so a system-wide credential
manager cannot answer first with whatever the user has stored for that host;
and `GIT_CONFIG_GLOBAL` is pinned at the file the launch wrote, because the
workspace inherits the server's environment and one already set there would
otherwise silence the whole config — identity and trusted directories
included.

Tor is the one thing not carried across: the SSH command a workspace gets
deliberately omits the Tor options the server's own git commands carry. That
is the same call the driver makes about Tor everywhere — routing one hop
through advisory environment while the rest goes direct is the fail-open
shape the difference list below rejects.

## `yaac-mama`, and how a worktree reaches its server

`yaac-mama` is the in-worktree command channel — a strict subset of the yaac
CLI an agent may run against the server that started it: list the project's
sessions, start another, retitle one, stop one (its own session included),
and make and fill sidebar groups. Stopping is in reach because it is
reversible — the checkout, the row and the conversation survive it, so the
user can restart what an agent wound down; deleting, restarting and
reconfiguring are not there. Both drivers have it, and the difference is only
the transport, because the two substrates differ in one fact: whether a
workspace can dial the server at all.

A session stopping ITSELF is the one command whose reply is best-effort under
either driver, since the caller tears down what its own answer travels over —
its pod under `k8s`, and under `containerless` the tmux server the command is
running in. The teardown is detached, so the handler answers first, but the
contract the script and the skill state is that the session ending is the
confirmation.

A pod cannot. It is inside the cluster, the server is a host process with no
in-cluster address, and the whole point of the sandbox is that the pod holds
no credential for it. So a pod POSTs to the egress proxy's magic host, the
proxy holds the request open, and the server collects it on its reconcile
pass — attribution by source pod IP, nothing configured inside the worktree.

A host process has neither problem. It runs beside the server, so it POSTs
straight to `/worktree/mama` with a bearer minted for that worktree at
create and handed to it in its environment (`YAAC_MAMA_TOKEN`, alongside
`YAAC_MAMA_URL`). The server keeps only the SHA-256 of it, on the worktree
row, and the token is what identifies the caller — a request never names its
own worktree, so nothing it sends can claim to be a different one.

The token is not a confinement boundary here, and it is worth being exact
about that: a containerless agent is a process running as the user, so it
could invoke the `yaac` CLI directly and do anything the user can. What the
token buys is *attribution* — the server knowing which worktree is asking,
so `list` and `create` resolve to the right project — plus one honest,
stable interface that behaves identically under both drivers.

Both transports end at `runMamaCommand` in `#domain/worktrees`, which is
where the command allowlist lives, so neither can widen it.

The URL is baked into the worktree's environment at launch rather than
resolved per call, because the tmux server holds that environment for its
whole life and outlives the yaac server that made it. A restart on the same
port (the default) keeps working; a server moved to a different port leaves
`yaac-mama` in already-running worktrees pointing at nothing until those
worktrees are themselves restarted.

## Permission modes

Under a sandbox the default is `bypass` — the container is the containment,
so a second layer of prompting inside it only costs interruptions. Without
one the default is `accept-edits`: edits land in the worktree unprompted,
while shells, out-of-tree writes and the network still ask. pi is the
exception in both directions, because it has no permission system at all
(see docs/agent-modes.md) — `bypass` is the only truthful answer anywhere.

That default is the last rung. A create takes the posture the request names,
else the one this project last had chosen, else the default above. The
remembered value lives on the project row rather than in the browser, so the
CLI (`--permission-mode`), the webapp's dropdown and the keyboard shortcut
all resolve the same answer, and only an explicit choice writes it.

The resolved posture is recorded on the worktree row
(`worktrees.permissionMode`) because a restart relaunches the agents and
must relaunch them the way the user asked, not the way today's default
would.

A chat (ACP) worktree resolves its posture by the same three rungs and
enforces it the same way every other posture is enforced here — the adapter is
told, and what it still asks about goes to the chat pane
(docs/permission-modes.md). So the containerless default applies to it too:
`accept-edits`, not `bypass`.

`bypass` is still reachable by asking for it, and on this driver that means
something it does not mean under a sandbox — the agent acts as the user, on
the user's own machine and credentials, with nothing else in the way. A create
that resolves there says so in its progress output rather than leaving it to
this page.

## Observation, and recovery

There is no informer, so the driver reports liveness from an edge it owns:
one long-lived read-only tmux control client per running workspace, whose
exit IS the workspace's death (tmux ends every client when its server dies).
Its stdin has to be a pipe held open — a control-mode client exits the
moment stdin closes, which would make the watch die instantly and take the
worktree's liveness with it.

Recovery is not an edge case here, it is the ordinary path. A fresh server
enumerates the marker files it wrote last time
(`projects/<slug>/sessions/<id>/containerless/workspace.json` — the
substrate's analogue of a Job object) and probes each socket. One that
answers is a running worktree, recovered whole with its agents still
working. One that does not is recorded as a DEAD workspace rather than
dropped, so the ordinary stale reaper turns it into a stopped worktree row;
dropping it would leave a row claiming to be running with nothing to reap
it. Because recovery runs as the driver attaches — after the server is
already answering — a client that connects in that window sees worktrees
appear rather than being made to wait.

## Ports

A pod's listener is reachable from nowhere until something binds a host port
and relays it. Here the workspace's processes bind host ports themselves, so
a detected listener is already reachable and the mapping is the identity.
Ports surface as `forwardedPorts` (links the webapp can offer directly) and
`unforwardedPorts` is always empty — there is no "forward this" action
because there is nothing left to do, and a config's `portForward` entry is
simply the port the dev server binds.

Detection is a poll over each running worktree's own process tree (`lsof`
against the tmux server's descendants), filtered through the same
sensitive-port policy the cluster driver uses. Only that tree: every other
listener on the machine belongs to someone else.

## What this driver does not do

Each of these answers empty, `null`, or a no-op at the DRIVER — the
degradations the contract specifies, so the snapshot composes every feed
unconditionally and callers above need no branch.

The ROUTES for them refuse, with `NOT_SUPPORTED` (501). The distinction is
the point: a verb degrades so the whole picture still draws, but a route is
one client asking one question, and `[]` from `GET /image/builds` reads as
"no builds are running" rather than "this server never builds". The webapp
reads `snapshot.driver` and hides these outright, so nothing that renders
per driver ever sees a 501. `test/api/route-matrix.ts` states every route's
answer under both drivers on one line.

- **Images and builds.** Nothing to build; the Dockerfile editors and the
  build feed are hidden in the webapp.
- **Egress mediation.** No blocked hosts, no git-auth failure reports, no
  allowlist. A worktree reaches whatever the user running the server can —
  including when `YAAC_USE_TOR` is set, which under k8s routes a pod's whole
  namespace through the proxy's Tor agent and here can only cover the
  server's own git. The start logs warn rather than route workspace traffic
  through advisory environment (`ALL_PROXY`, an ssh ProxyCommand) that
  undici, raw sockets and the agent's own shell all bypass: silently missing
  traffic is worse for the person who asked for Tor than a stated gap.
- **Nested containers.** `nestedContainers` asks for a container to put a
  container in. A project config requesting it is rejected at create.
- **The prewarmed spare pool.** A spare amortizes an image pull and a pod
  boot; a tmux server in an existing checkout costs neither.
- **Per-worktree module caching.** See the mount note above.
- **Codex session discovery.** Every tool's `SessionStart` hook runs the same
  staged `worktree-bin/yaac-agent-links`, which works here — but codex reaches
  it through a *managed* hook declared in `/etc/codex/requirements.toml`, the
  trusted image layer that bypasses its per-change `/hooks` trust prompt.
  There is no image to carry that here, so a codex worktree knows only the
  conversation `--session-id` pinned. Claude registers the same script from
  its own settings.json and is unaffected.

## Host requirements

`yaac host check` verifies them, and the driver logs any hard failure at
startup rather than letting a create fail with a spawn error:

- **tmux** (3.0+ — the status watcher drives control mode) and **git**:
  required. The launch spawns both directly, so a create refuses up front
  rather than dying inside `launchWorkspace` with the workspace half made.
- **node**: required for `--mode acp`, where the window's command is `node`
  running yaac's own acpd. Unlike an agent CLI's interpreter, that one is
  yaac's to account for — a server started by a node that never landed on
  `PATH` (a bundled one, as the desktop app stages) would open a window that
  execs nothing. Warned about rather than failed, like socat below: the
  server plainly runs without it, and only acp creates refuse.
- **socat**: required for `--mode acp` — the chat transport dials acpd's
  socket by spawning one — and unused by `--mode tui`. `yaac host check` warns
  rather than fails for that reason; a create in acp mode refuses.
- **an ACP adapter** (`claude-agent-acp`) for `--mode acp`: it ships in the
  image under the pod driver, and has to be installed here.
- **an agent CLI** on `PATH` (claude, codex, opencode, pi) — there is no
  image to have installed one.
- **lsof**: port detection; without it worktrees run fine and report no ports.
- **curl**: how `yaac-mama` reaches this server from inside a session;
  nothing else uses it.

Nothing gates on the tools the agents themselves reach for — `ripgrep` and
`fd` (pi downloads its own when neither `fd` nor `fdfind` is on `PATH`), `gh`,
`jq` — which is the same line the builtin skills are written to. The Homebrew
formula installs the useful ones anyway, since a mode with no image is the
one place a missing utility is the user's problem.

### Missing tools

The tool a create names has to be on the PATH this server was started from,
because that is the PATH its tmux server will resolve the launch command
against. Two checks say so instead of letting it fail silently — a launch
command that execs nothing exits 127, tmux closes the window, and the
worktree ends seconds after a create that already reported success:

- Before anything is provisioned, the create asks the driver
  (`assertCanLaunch`) whether this host has the binaries the launch will run:
  `tmux` and `git` whatever it runs, then the tool itself for `--mode tui`,
  or for `--mode acp` the tool's ACP adapter — which bundles its own SDK and
  never shells out to the CLI — under `node`, plus the `socat` that mode's
  transport dials with. A miss refuses the create with `MISSING_TOOL` and the
  command that installs it. They are asked in dependency order, so a bare
  machine is told about tmux rather than about an adapter it has nowhere to
  run. socat is in that list even though its absence does not kill the
  worktree: the pane simply never attaches, which reads as an agent that
  hangs rather than a tool that is missing, and there is no npm command for
  yaac to offer to run.
- After the launch, a probe checks the agent windows actually survived,
  catching what a PATH check cannot: a binary that is present but broken. It
  is deliberately not awaited — its settle delay would land on every create
  — so its verdict arrives as a failed provisioning row a moment later.

`--install-missing` (or the webapp's **Install and retry**, offered on a
`MISSING_TOOL` failure that reports itself `installable` — the code alone
would put the button on socat too, where the retry installs nothing and
re-fails identically) has yaac run the install itself, from the fixed table
in `@yaac/shared/tool-install`, narrated on the create's progress stream. It
re-probes afterwards and refuses if the binary still does not resolve: `npm
-g` reports success into prefixes this server's PATH may never search, and
an unverified install would hand back a worktree that dies exactly as it
would have. The same table backs `yaac host check`'s advice.

## Testing

`pnpm vitest run --project e2e-containerless` drives the real CLI against a
real containerless server. It needs no cluster, builds no images, and runs in
parallel — a fake agent on `PATH` stands in for a real one, since what is
under test is the launch, the exec transport and the recovery rather than
any agent's behavior. The driver's unit tests mock at `host.ts`, which is its
entire process boundary.
