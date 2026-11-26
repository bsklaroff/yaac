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

- **kind**: `create` or `restart`. A create that took a prewarmed spare
  has the spare's id (docs/generic-workspace-pods.md).
- **outcome**: `ok` or `failed`.
- **total**: from `createWorkspace`'s entry to the start resolving. The
  request's own checks, and the take of a spare, come before it.
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

A create or restart (`createWorkspace`):

| Phase | What it covers |
|---|---|
| `checks` | Everything before provisioning starts: the project and credential checks, a tool's first-use install on a host, the base branch reads, the row. |
| `fetch[.<folder>]` | Each repo's fetch of origin, from its start until it lands. A start does not wait for it (docs/server-git.md "Starting a workspace"), so compare where it ends with `windows`. |
| `image` | Resolving or building the workspace image (k8s). |
| `checkout` | The checkouts' `.git` and, under k8s, the tree's start instruction. |
| `substrate` | The egress registration (k8s: proxy rollout check, ClusterIP, token). |
| `prep` | Host-side files: tool homes, credentials, skills, history. |
| `spec` | Building the launch spec after the legs above join. |
| `launch` | The driver's launch (k8s: the Job applied after the proxy registration; for a taken spare, starting its registration, labels and CPU request, which land within `ready`). |
| `ready` | From launch to the runtime reporting ready (k8s: the pod Ready, then mountd's bind and streamd's claim call, which opens the windows of a start whose agents are all acp; docs/generic-workspace-pods.md "A claim"). |
| `transport` | From ready to the agent transport answering (k8s: streamd through the relay). |
| `origin` | Reading where origin's branch is now, for the catch-up below. |
| `windows` | The command that opens the sessions' windows, with the setup that rides it. |
| `setup` | That command when it opens no window: a start with no session, or one whose agents are all acp, whose windows opened as the runtime came up (in `ready`; on a host, in `windows`). |
| `agent.<tool>` | From the window opening (for windows that opened as the runtime came up, from `ready`'s end) to the status watcher first seeing the agent at work on its opening message. |

`ready`, `transport` and the pod phases are absent under `containerless`,
which has no boot to wait for.

Inside a k8s pod, from the pod's own programs, at millisecond resolution:

| Phase | What it covers |
|---|---|
| `tree.wait` | The tree container's `yaac-tree run`, from its start until it read its start instruction. |
| `tree.fill` | Filling the tree from the arborist's build or restoring onto it, until the tree is filled. |

Within `ready`, before `tree.wait`: for a pod made on demand the Job
controller, the scheduler, the pod's volumes, its sandbox, any image pull
and the `postStart` hook; for a spare only the pod's Ready status reaching
the server. Then the wait for the life's start instruction, and the node
agent's bind: once the agent has written its list, the tree container
makes its own binds and starts `run`. After `tree.fill`, the claim call
writes the workspace's files and opens its session.

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
instruction once the tree is filled, before the started marker the claim
call waits on, and the server reads it after the start resolves. The
`postStart` hook writes no marks, so the line has no phase for it.

The times come from the node's clock and the shared tier's, which on kind
are the server's; on a multi-node install they carry the nodes' clock
skew. A pod's status says when it was scheduled, when its sandbox was
ready and when each container started, but only to the whole second, too
coarse for phases that take a fraction of one, so the line does not use
it. The kind node's `journalctl -u containerd` (`RunPodSandbox`,
`CreateContainer`, `StartContainer`, millisecond stamps) splits a pod
made on demand's `ready` further.

## What `agent.<tool>` measures

It is the agent's own boot, the largest part of a prewarmed start, plus
the status watcher's attach, which retries until streamd answers. It ends
at the first status other than idle, or the first sign the agent drew its
message, which is when the webapp stops showing the session as opening. A
session with no opening message, such as a restart's, gives no such sign,
so the line does not wait for one. Nor does it come for an agent that
fails its turn before showing it is at work, such as claude with an
expired login.
