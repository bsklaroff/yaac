# Retire process-per-stream: status via hostPath, then a data-plane relay

## Context

The informer/reconciler layer (`docs/event-driven-reconcile.md`) removed
the process-per-read and time-driven-reconcile cost centers: cluster
reads ride watch-fed caches and reconcile passes fire on events. What
remains is **process-per-stream** — every byte of terminal output and
forwarded traffic still transits a dedicated kubectl child:

- one persistent `kubectl exec` per running session (tmux control-mode
  status watcher, `src/features/sessions/status-watcher.ts`),
- one per open terminal tab (`src/features/terminals/pty-bridge.ts`),
- one **per TCP connection** to a forwarded port
  (`src/platform/container/port.ts`),
- plus the proxy exec tunnel.

Each chunk crosses pod → containerd shim → kubelet → apiserver → kubectl
→ server: five hops of syscall/copy, a large share of the apiserver's
steady-state CPU, and a big slice of observed context-switch volume.
gVisor makes the exec path extra expensive on the pod side too.

Out of scope, tracked elsewhere: kubelet/cAdvisor housekeeping (fixed at
300s, `src/features/cluster/check.ts`), gVisor systrap cost inside
session pods, and the idle per-session vcluster control-plane cost
(pause/lazy-start — its own plan when picked up).

## 1. Status via hostPath (cheap stepping stone, ships independently)

Session dirs are already hostPath-mounted, so the in-pod side can write
status events to a file the server watches with fs.watch — zero cluster
machinery. This alone removes the N persistent status-watcher execs.
Falls back to the exec watcher where the mount is absent (nested/e2e
variants). Stream-death detection feeds the reconciler's existing poll
lane; no scheduling changes needed.

## 2. Data-plane relay

The server already keeps one mux'd exec tunnel to the proxy pod
(`src/platform/k8s/exec-tunnel.ts`), and the proxy reaches every pod IP
in-cluster. Generalize: one persistent connection from server to an
in-cluster relay that dials pod IPs directly and multiplexes

- terminal PTYs (replacing per-tab `kubectl exec -it tmux attach`),
- tmux control-mode status streams (where the hostPath file isn't
  available),
- port-forward connections (replacing per-connection `kubectl exec nc`).

Relay host: the proxy pod is the natural candidate (exists, already
session-adjacent, restart semantics understood); a purpose-built tiny
gateway on a hostPort is the alternative if coupling terminal traffic to
the egress proxy's lifecycle proves uncomfortable. Session pods run a
small in-pod listener bound to the pod IP, speaking to the existing tmux
socket — no more exec into gVisor for streams.

Most invasive piece, biggest win for many sessions × many open
terminals. Decision gate: skip or defer if real workloads are mostly
headless — the shipped informer layer plus move 1 capture most of the
value at a third of the effort.

## Expected effect

Context-switch volume drops sharply (today every keystroke of every
open terminal transits a dedicated kubectl process), and the apiserver
leaves the terminal/forwarding data path entirely. Does not touch gVisor
sandbox cost or vcluster baseline (see out-of-scope above).

## Open questions

- Relay transport/protocol: extend the exec-tunnel framing vs a boring
  WebSocket mux; how resize/signal control frames ride along
  (`pty-bridge.ts` already JSON-frames these).
- RBAC: unchanged (same kubeconfig); the in-pod listener must bind
  pod-IP only and stay unreachable from other sessions (CNP, same
  pattern as the proxy ingress lock).
