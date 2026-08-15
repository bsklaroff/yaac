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
YAAC_DRIVER=containerless yaac server start     # or: yaac server start --driver containerless
yaac host check                                 # the parallel of `yaac cluster check`
```

The choice is recorded beside the lock, so a later `yaac server restart` from
an ordinary shell keeps serving the worktrees it already has. Without that a
bare restart selects the default, and a k8s server adopting a containerless
data dir reaps rows whose pods it cannot find — its teardown removing the
very state dirs the markers live in, leaving the agents running as the user
and unreachable. An explicit `--driver` still wins and is not refused;
switching a data dir is something you may deliberately do, and it is logged.

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
creates inside a pod, and has to be: the `sleep infinity` placeholder the
stale reaper recognizes, the `yaac:<tool>` window naming the status watcher
parses, and the tmux options the webapp's terminal rendering depends on are
all read by driver-neutral machinery that cannot tell the two substrates
apart.

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
