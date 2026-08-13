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
leave one worktree's staging in a directory every other worktree reads.
Those are skipped and logged — builtin skills are not staged into
containerless worktrees yet. Anything else with no host equivalent fails the
create rather than being silently dropped.

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

## Yolo mode

Under a sandbox, auto-approve is unconditional: `claude
--dangerously-skip-permissions`, `codex --yolo`, `pi --approve`, justified
by the container around them. Without one it is the user's per-worktree
choice, made in the new-worktree popover and defaulted OFF. The choice is
recorded on the worktree row (`worktrees.autoApprove`) because a restart
relaunches the agents and must relaunch them the way the user asked, not the
way today's default would. The webapp remembers the last choice as a working
style; the server's fallback, when a request states none, is the driver's
default.

opencode is the exception: its approval behavior is a config block rather
than a launch flag, so an opencode worktree ignores the choice until that
config learns it.

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
  allowlist. A worktree reaches whatever the user running the server can.
- **Nested containers and virtual clusters.** Both ask for a container to put
  a container in. A project config requesting either is rejected at create.
- **The prewarmed spare pool.** A spare amortizes an image pull and a pod
  boot; a tmux server in an existing checkout costs neither.
- **`yaac-spawn`.** The in-workspace spawn channel rides the proxy's magic
  host, which does not exist here, so an agent cannot spawn sibling
  worktrees yet.
- **Per-worktree module caching.** See the mount note above.
- **Builtin skills**, for the nesting reason above.

## Host requirements

`yaac host check` verifies them, and the driver logs any hard failure at
startup rather than letting a create fail with a spawn error:

- **tmux** (3.0+ — the status watcher drives control mode) and **git**: required.
- **lsof**: port detection; without it worktrees run fine and report no ports.
- **socat**: the ACP chat transport; `--mode tui` does not need it.
- **an ACP adapter** (`claude-agent-acp`) for `--mode acp`: it ships in the
  image under the pod driver, and has to be installed here. A create in that
  mode is refused when it is missing, rather than reporting success and
  ending seconds later.
- **an agent CLI** on `PATH` (claude, codex, opencode, pi) — there is no
  image to have installed one.

## Testing

`pnpm vitest run --project e2e-containerless` drives the real CLI against a
real containerless server. It needs no cluster, builds no images, and runs in
parallel — a fake agent on `PATH` stands in for a real one, since what is
under test is the launch, the exec transport and the recovery rather than
any agent's behavior. The driver's unit tests mock at `host.ts`, which is its
entire process boundary.
