# Stuck sandbox recovery

A worktree pod runs under gVisor, and gVisor's sentry can deadlock. When it
does, the pod is stuck in a way nothing inside the cluster can undo: the
kubelet's stop goes through `runsc`, whose kill and state RPCs need the
sentry's task-set lock, which is the lock the deadlocked sentry holds. Every
attempt times out (`FailedKillPod` … `failed to get task for container …
context deadline exceeded`), the pod sits `Terminating` for good, and the
graceful Job delete the stale reaper re-issues on every pass never lands.
The sentry's own watchdog does not help either: its task walk needs the same
lock, and the watchdog-stuck path only ever logs, whatever
`--watchdog-action` says.

The agent inside may keep running the whole time. Only what touches the
task set freezes — exec, exit, clone, signals — which is why the worktree
first goes quiet to the server (its tmux probes are execs) while the
transcript keeps growing, and why a stop is what finally wedges it visibly.

## What yaac does about it

Two things, both driven off signals the server already had.

**A stuck stop is forced from outside the sandbox.** The stale reaper's
stuck-terminating sweep measures how long a pod's delete has been pending
(the pod's deletion timestamp, `terminatingSinceMs` on the runtime handle).
A worktree's grace period is seconds, so a delete pending past
`YAAC_FORCE_KILL_AFTER_MS` (three minutes by default) means the runtime
cannot be killed the ordinary way. The reaper then calls the driver's
`forceKillWorkspace` before re-issuing the ordinary teardown — the force
only clears the way; the idempotent teardown is still what finishes. The
sweep defers to a stop's live in-memory terminating mark, and that mark
expires on read (`isWorktreeTerminating`), so a server nobody is listing
from still escalates within the mark's TTL plus a reconcile pass.

Under k8s the verb execs into the gVisor installer DaemonSet pod on the
worktree's node — the one privileged, host-PID foothold yaac keeps on a
node — and runs `sandboxForceKillScript`: find the `runsc-sandbox` process
whose command line carries the pod's uid (the shim passes
`--panic-log=/var/log/pods/<ns>_<pod>_<uid>/…` to every sandbox), dump its
sentry stacks with `runsc debug --stacks` under a deadline, then SIGKILL it.
The signal needs nothing from the sentry; once it lands, containerd sees
the task exit and the pod finalizes within seconds. The verb refuses a pod
that is not already terminating: this is how a stop finishes, never how one
starts. The containerless driver has no sandbox and answers `forced: false`.

The stack dump is the whole diagnostic record of a wedge, and the kill
destroys it, so it is taken first and kept beside the worktree's other
per-id metadata as `meta/<worktreeId>.sandbox-stacks.txt`
(`sandboxDiagnosticsPath`). It survives the stop, like the checkout, and
goes with a delete. The `debug` RPC takes no kernel lock, so a deadlocked
sentry still answers it; the deadline covers a sentry that does not.

**A wedge is named before anyone stops it.** The status watcher already
detects the freeze — its heartbeat and pane listing time out, it re-execs
streamd on the third consecutive failure, and that exec times out too. One
failure past that self-heal it marks the worktree `unresponsive` in the
status store, which the listing carries to the sidebar and the CLI. The
verdict is retracted by the next healthy stream. A stop pending past the
force window is reported as `stoppingStuck` the same way. Neither flag acts:
a running worktree is never force-killed on the watcher's word, only a
delete that will not land.

## Reproducing it

`SIGSTOP` on a healthy sandbox's `runsc-sandbox` process produces the same
stuck-kill symptom deterministically — `runsc kill` waits on a control
socket nothing answers — and `SIGKILL` clears it the same way. The e2e in
`test/e2e-cli/worktree-force-stop.test.ts` freezes a sandbox through the
installer pod, stops the worktree, and asserts the stop completes with the
stack dump kept.
