# Start timing

Every workspace start writes one `[timing]` line to the server log saying
what each of its phases cost, in milliseconds, under phase names that stay
the same across builds. It is how a slow start is diagnosed on a real
install, and how a start-up change proves its gain without a custom build.

```sh
yaac server logs | grep '\[timing\]'           # a host (containerless) server
yaac cluster logs -n 200000 | grep '\[timing\]' # the cluster's server
```

## The line

```
[timing] <workspace id> <kind> <outcome> total=<ms> <phase>=<start>+<ms> ... <fact>=<value> ...
```

- **kind**: `create` (a fresh create from scratch), `claim` (a create that
  takes a prewarmed spare; the id is the spare's), `warm` (a spare being
  warmed) or `restart`.
- **outcome**: `ok`, `failed`, or `fallback` for a claim that gave up and
  went on to a cold create, which writes a `create` line of its own. A claim
  that found no spare to try writes nothing.
- **total**: from the server taking up the start to it resolving. For a
  create, a restart or a warm, that is from `createWorkspace`'s entry; for
  a claim, from `tryClaimPrewarmed`'s. The request's own checks before
  either are not in it.
- **phases**: `name=<start>+<duration>`, the start measured from the
  start's beginning, so concurrent phases show how they overlapped and a
  gap between phases is time no phase covers. They are ordered by start. A
  phase that did not run is absent, never zero.
- **facts**: what is not a duration, after the phases.

The line is written once the start has resolved and what it still waits
on has settled: the agent's first sign of work and a catch-up with origin
after launch (below). It is written anyway 30 s after the start resolved,
without what has not come.

## Phases

A create, restart or warm (`createWorkspace`):

| Phase | What it covers |
|---|---|
| `checks` | Everything before provisioning starts: the project and credential checks, a tool's first-use install on a host, the base branch reads, the row. |
| `fetch[.<folder>]` | Each repo's fetch of origin, from its start until it lands. A start does not wait for it (docs/server-git.md "Starting a workspace"), so compare where it ends with `windows`. |
| `image` | Resolving or building the workspace image (k8s). |
| `checkout` | The checkouts' `.git` and, under k8s, the tree's start instruction. |
| `substrate` | The egress registration (k8s: proxy rollout check, ClusterIP, token). |
| `prep` | Host-side files: tool homes, credentials, skills, history. |
| `spec` | Building the launch spec after the legs above join. |
| `launch` | The driver's launch (k8s: the proxy registration and the Job applied). |
| `ready` | From launch to the runtime reporting ready (k8s: the pod Ready, which waits for the init hook). |
| `transport` | From ready to the agent transport answering (k8s: streamd through the relay). |
| `origin` | Reading where origin's branch is now, for the catch-up below. |
| `windows` | The command that opens the sessions' windows, with the setup that rides it. |
| `setup` | That command when it opens no window (a spare, or a host acp agent that opened early in `windows`). |
| `agent.<tool>` | From the window opening to the status watcher first seeing the agent at work on its opening message. |

`ready`, `transport` and the pod phases are absent under `containerless`,
which has no boot to wait for.

Inside a k8s pod, from the pod's own programs, at millisecond resolution:

| Phase | What it covers |
|---|---|
| `tree.wait` | The tree container's process start until it read its start instruction. |
| `tree.fill` | Checking the tree out or restoring it, until the startup probe may pass. |
| `init` | `yaac-workspace-init`, the workspace container's `postStart` hook. |

Read against `launch` and `ready`, the gaps between them are kubelet's:

- `launch` end to `tree.wait` start: the Job controller and scheduler, the
  pod's volumes, its sandbox, any image pull for the tree container, and
  the tree process's own start.
- `tree.fill` end to `init` start: the probe passing, kubelet's next sync,
  the workspace container's `subPath` binds, any image pull, and its
  creation (docs/node-local-workspaces.md "Start").
- `init` end to `ready` end: the status reaching the server.

A claim (`tryClaimPrewarmed`): `list` (the spares), `fetch[.<folder>]`,
`pick` (each checkout's start commit), `probe` (the spare's tmux and
HEADs), `rows`, `prepare` (the session's launch command), `register` (the
egress registration), `cas` (winning the spare), `hooks` (the life's log
hooks), `move` (moving a spare on another commit or branch), `unmark` (the
rest of the runtime's unmarking), `record` (the start commits),
`origin`, `windows` and `agent.<tool>` as above.

## Facts

`catchup[.<folder>]`, for each checkout that follows its branch, says what
the catch-up with origin did (docs/server-git.md "Starting a workspace"):

| Value | Meaning |
|---|---|
| `none` | The fetch brought nothing new. |
| `ff` | Fast-forwarded to origin's tip. |
| `reset` | Reset to origin's tip, a force-pushed branch on an untouched checkout. |
| `skipped` | Left behind origin: it could not be moved safely. |
| `late` | Left behind: the fetch took longer than the catch-up waits after launch. |
| `failed` | The fetch failed; it stays on the last commit fetched. |
| `gone` | Origin no longer has the branch. |

A start that never follows (a non-interactive run, a site's release, a
create at a commit, a restart) has none.

## How the in-pod times are taken

Nothing in a pod's start costs it an extra process or exec to be timed.
The tree container writes `timing.json` beside the life's start
instruction once the tree is filled, after the marker its probe waits on.
The init hook writes two empty files, `.init-start` and `.init-end`, at
the top of the workspace's terminal log dir, using shell redirections
only, and the server reads their mtimes. The server reads both after the
start resolves.

The times come from the node's clock and the shared tier's, which on kind
are the server's; on a multi-node install they carry the nodes' clock
skew. A pod's status says when it was scheduled, when its sandbox was
ready and when each container started, but only to the whole second, too
coarse for phases that take a fraction of one, so the line does not use
it. The kind node's `journalctl -u containerd` (`RunPodSandbox`,
`CreateContainer`, `StartContainer`, millisecond stamps) splits the
`launch`-to-`tree.wait` gap further.

## What `agent.<tool>` measures

It is the agent's own boot, the largest part of a prewarmed start, plus
the status watcher's attach, which retries until streamd answers. It ends
at the first status other than idle, or the first sign the agent drew its
message, which is when the webapp stops showing the session as opening. A
session with no opening message, such as a restart's, gives no such sign,
so the line does not wait for one. Nor does it come for an agent that
fails its turn before showing it is at work, such as claude with an
expired login.
