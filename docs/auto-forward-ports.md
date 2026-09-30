# Auto-detected port forwarding

Config-declared forwards (`portForward` in yaac-config.json) are set up at
workspace create and server restart. This feature adds a second path: when
something starts listening on a loopback port inside a running workspace
pod, the webapp offers to forward it, for that workspace only or for the
whole project, without editing config or restarting.

It is k8s-only. Under `containerless`, listeners are already host ports, so
`unforwardedPorts` is always empty and the routes below return
`NOT_SUPPORTED` (docs/containerless-driver.md "Ports").

## Data flow

```
streamd `ports` stream (polls /proc/net in the pod, pushes on change)
  → server detector map (drivers/k8s/forwarders/port-detector.ts)
  → snapshot `unforwardedPorts[]` → /events WS
  → UnforwardedPortsBadge (workspace toolbar popover)
  → POST /workspace/:id/forward-port {containerPort, persist}
  → one more declared forward (persist: also a config write + fan-out)
  → next snapshot moves the port into `forwardedPorts`
  → a client forwarder binds it (docs/port-forward-tunnel.md)
```

## Detection

streamd, the in-pod stream daemon, does the observing (docs/stream-relay.md,
the `ports` kind). While a ports stream is open it reads `/proc/net/tcp{,6}`
every few seconds and sends the listening ports as a JSON line on connect,
on every change, and periodically as a keepalive. It reports only listeners
a relay `tcp` dial can reach (bound to loopback or wildcard) and omits its
own port.

The server keeps one ports stream per running, non-prewarmed workspace
(`PortDetectorManager`, synced from pod informer events like the status
watchers). If a stream dies, the last set is kept and it reconnects with
backoff; a missed keepalive reveals a stuck stream. A changed set pushes a
fresh snapshot.

`unforwardedPorts` is the detected set, capped at a small count, minus:

- ports already forwarded;
- ports the user dismissed for this workspace (in memory until server
  restart);
- sensitive ports (node `--inspect`, sshd, common databases), since
  one-click exposure of these risks code execution or data exposure;
- yaac's own in-pod infra port range.

## The forward action

`POST /workspace/:id/forward-port {containerPort, persist}` works like
allow-host. The port must be in the workspace's current unforwarded set, so
the route cannot forward an arbitrary port, and that check runs before
anything is written. `forwardWorkspacePort` then:

- **persist: false**: allocates a host port (starting at the container port)
  and adds it to the workspace's forwarder-registry entry
  (`addWorkspaceForwarder`, which also refreshes the tmux status bar). This
  declares the forward; a client binds it. It lasts until the workspace is
  recreated.
- **persist: true**: first adds `{containerPort, hostPortStart:
  containerPort}` to the project's yaac-config.json
  (`addPortForwardToProjectConfig`, de-duplicated) so future workspaces
  inherit it, then forwards it on this workspace and, best-effort, on the
  project's other running workspaces.

`POST /workspace/:id/dismiss-port` hides a port, with the same current-set
check so the dismissed set cannot be grown arbitrarily.

A forward during workspace create is safe: the registry merges the create's
declarations with later ones on one entry, and allocating a host port and
recording it is one synchronous step, so concurrent requests for a port
produce one forward.

The badge popover shows the exposure host from `forwardBindHost` on the
snapshot (`YAAC_FORWARD_BIND`: loopback locally, the tailnet IP on a remote
host), not the page origin, because the page may be reached under another
name (for example over an SSH tunnel). This is what the user consents to;
`yaac forward --bind` is what actually binds that address.

## Security model

The agent controls what is detected (it can bind any port and holds its own
pod's stream token), and forwarding opens a path into the sandbox. So each
step is checked again: streamd's `/proc` parsing is bounded; the server
re-validates each port and caps the stored set; the sensitive and infra
filters run on the server; the action is checked against the surfaced set;
and forwards are capped per workspace (`MAX_FORWARDS_PER_SESSION`, below
streamd's concurrent-stream limit).

An agent can still start a plausible-looking listener and hope for a click.
That is why `persist: true` is a separate, clearly labeled action and the
popover shows the exposure host. Forwarding is by port number, not process,
so the agent could rebind the port between detection and forward; this is
accepted as low severity, and config-declared forwards behave the same way.

## Older workspaces

A pod whose streamd lacks the `ports` kind refuses the stream. The detector
retries with backoff and the workspace shows no detected ports. Restarting
the workspace picks up the current image.
