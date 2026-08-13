# Auto-detected port forwarding

Port forwarding out of a worktree pod has two paths. Config-declared
forwards (`portForward` in yaac-config.json) are provisioned at
worktree-create and server-restart. This feature adds the reactive path:
when a server starts listening on a loopback port inside a running
worktree, the webapp offers to forward it — for just that worktree, or
permanently for the project — without editing config or restarting.

## Data flow

```
streamd `ports` stream (in-pod /proc/net poll → push on change)
  → server detector map (drivers/k8s/forwarders/port-detector.ts)
  → snapshot `unforwardedPorts[]` → /events WS
  → UnforwardedPortsBadge (worktree toolbar popover)
  → POST /worktree/:id/forward-port {containerPort, persist}
  → live single-port relay forward (+ persist: config write + fan-out)
  → fresh snapshot moves the port into `forwardedPorts`, clearing the row
```

## Detection

streamd owns observation (docs/stream-relay.md, the `ports` kind): while
a ports stream is open it polls `/proc/net/tcp{,6}` in-pod every few
seconds and pushes the LISTEN set as a JSON line on connect, on every
change, and periodically as a keepalive. Only listeners a relay `tcp`
dial could actually reach are reported — bound to loopback or wildcard —
and streamd's own port is excluded at the source. There is no
server-side poll and no per-tick process spawn.

The server keeps one ports stream per running, non-prewarmed worktree
(`PortDetectorManager`, synced from informer pod deltas like the status
watchers) feeding an in-memory map; a stream death leaves the last set
sticky and redials with backoff, and the keepalive doubles as the wedge
detector. A set change pushes a fresh snapshot immediately.

`unforwardedPorts` on the worktree snapshot is the detected set minus:

- container ports already forwarded (the forwarder registry),
- ports the user dismissed for this worktree (in-memory, resets with the
  server — "never forward this" is a legitimate lasting choice),
- a sensitive-port denylist (node --inspect, sshd, common databases —
  exposing them one-click is a step toward RCE or data exposure),
- yaac's in-pod infra port range, hidden fail-closed,

capped to a small count so a hostile listener flood stays bounded.

## The forward action

`POST /worktree/:id/forward-port {containerPort, persist}` mirrors
allow-host. The port must be in the worktree's currently-surfaced
unforwarded set — the route cannot be driven to forward an arbitrary
port. `forwardWorktreePort`:

- **persist: false** — reserve one host port (starting at the container
  port) and start one relay forward on the running pod, appended to the
  worktree's existing forwarder-registry entry (`addWorktreeForwarder`,
  which also refreshes tmux status-right). Live-only: gone when the
  worktree is recreated.
- **persist: true** — first write `{containerPort, hostPortStart:
  containerPort}` into the project's yaac-config.json
  (`addPortForwardToProjectConfig`, de-duped) so future worktrees inherit
  it, then forward the target worktree and fan the live forward out to
  the project's other running worktrees best-effort (matching
  allow-host's persist semantics).

`POST /worktree/:id/dismiss-port` hides a port for the worktree, under the
same surfaced-set guard as forward-port (so the dismissed set can't be
grown for worktrees the sync cleanup never tracked).

A forward that lands during the worktree-create window is safe: the
forwarder registry merges registrations (the create batch and reactive
appends accumulate on one entry; teardown runs every stop), and
`addWorktreeForwarder` re-checks after its reservation so concurrent
requests for the same port converge on one forward.

The forward listener binds `YAAC_FORWARD_BIND` like every other forward
(loopback locally, the tailnet IP on a remote host). The badge popover
states the exposure host from the server-reported bind (`forwardBindHost`
on the snapshot), not the page origin — the page can be reached by a
different name than the forward binds (an SSH tunnel to a remote server),
and this line is the informed-consent claim.

## Security model

Detection is driven by agent-controlled state (the agent binds ports at
will, and holds its own pod's stream token), and forwarding is ingress
into the sandbox — so everything crossing the boundary is re-validated:
streamd's parsing is bounded against hostile `/proc` content, the server
re-validates every pushed port as an integer in range and bounds the
stored set, the sensitive/infra filters are applied server-side
fail-closed, the action is cross-checked against the surfaced set, and
forwards are capped per worktree (`MAX_FORWARDS_PER_SESSION`, under
streamd's concurrent-stream cap). An injected agent can still stand up a
plausible-looking listener and hope for a click — which is why
`persist: true` stays a distinct, explicitly-labeled action and the
exposure host is shown on the popover.

Forwarding is by port number, not pinned to a process: between detection
and forward the agent can rebind the port to a different service
(accepted, low severity — the same is true of config-declared forwards).

## Compatibility

A worktree whose pod runs a streamd predating the `ports` kind refuses
the stream handshake; its watcher just keeps retrying with backoff and
the worktree shows no detected ports (everything else about it works).
Restarting the worktree picks up the current image.
