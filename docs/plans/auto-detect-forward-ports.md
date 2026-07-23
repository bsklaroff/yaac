# Auto-detect and forward listening ports

## Context

Port forwarding out of a session pod is **config-declared only**: a
`portForward: [{containerPort, hostPortStart}]` entry in `yaac-config.json`
is resolved at session-create (`features/sessions/create.ts`) and
server-restart (`features/sessions/forwarders/port-forwarders.ts`), which
`reserveAvailablePort`s a host port and opens a relay
(`platform/container/port.ts`) that carries `localhost:<containerPort>` in
the pod out to the host bind. Nothing ever inspects the pod for listening
sockets — if the agent starts a dev server on a port the user didn't
predeclare, there is no way to reach it without editing config and
restarting.

This plan closes that gap: **detect a server that begins listening on a
loopback port inside a running session, and offer to forward it** — "forward
for this session" or "forward permanently for this project" — in the toolbar
slot where the preview button lives (`SessionView.tsx`). The UX deliberately
mirrors the blocked-hosts feature: a detected item rides the session
snapshot, surfaces as a badge/popover with a two-tier session-vs-project
action, and self-clears when the fresh snapshot no longer lists it.

Two adjacent plans shape the design:

- **Data-plane relay / streamd** (`docs/stream-relay.md`) replaces the
  `kubectl exec … nc` forward relay with a `tcp` stream kind through an in-pod
  `streamd`, and *deletes* the kubectl stream paths. This changes how
  detection reads the pod (no `kubectl exec cat /proc/net/tcp`) and where the
  forward relay comes from, but leaves the `RelayFactory` seam this feature
  builds on untouched. See "Interaction with the streamd relay" below — the
  detection half should land on the streamd side of that cutover.
- **Forwarded-port env** (`forwarded-port-env.md`) adds an optional `envVar`
  to `PortForwardConfig`. Auto-forwarded entries simply omit it.

## Data flow

```
streamd observes listeners → pushes up relay → server detector map (per session)
   →  session snapshot `unforwardedPorts[]`  →  /events WS
   →  toolbar popover (preview slot)  →  POST /:id/forward-port {containerPort, persist}
   →  live single-forward relay  (+ persist: write portForward, fan out)
   →  notifySessionListChanged → snapshot moves port into `forwardedPorts`,
      drops it from `unforwardedPorts` → popover self-clears
```

The server is the producer of the detected set (unlike blocked-hosts, where
the proxy writes a hostPath file), so the set lives in an in-memory map, not
on disk.

## 1. Detection — streamd push, no server-side poll

New `features/sessions/forwarders/port-detector.ts` holds a
`Map<sessionId, number[]>` (container ports listening but not forwarded), fed
by streamd rather than a poll. `containerExec` shells out (a shell + kubectl
child per call plus an apiserver round trip, gVisor-taxed in-pod), so a
recurring per-session exec would be the heaviest per-session loop in the
system — exactly the process-per-poll cost `event-driven-reconcile.md` and the
streamd relay set out to remove. Detection therefore adds **no steady-state
server-side poll**.

- **Transport — streamd push.** streamd is a yaac-owned in-pod daemon that
  already dials loopback ports for the `tcp` kind, so it observes listener
  state in-pod (netlink `INET_DIAG` or an internal `/proc/net/tcp{,6}` read)
  and **pushes** a "listeners changed" event up the already-open relay. The
  server updates the map from the push — no per-tick process spawn, no
  apiserver round trip. streamd parses in-pod and returns the set as JSON
  (keeping only rows in state `0A`, LISTEN), and authoritatively excludes its
  own `POD_STREAM_PORT` and other infra.
- **Interim (pre-streamd) only.** If detection must ship before streamd, use a
  one-shot `containerExec … cat /proc/net/tcp /proc/net/tcp6` at the
  status-watcher **heartbeat cadence (~20s), not a tight 3–5s poll**, or
  on-demand while the session is focused — explicitly interim, deleted in the
  streamd cutover.
- **Reachability filter.** Keep only listeners the relay's in-pod
  `localhost`-origin dial can actually reach: bound to loopback
  (`127.0.0.1`/`::1`) or wildcard (`0.0.0.0`/`::`). A listener bound only to a
  private non-loopback IP is out of scope for v1 (the `yaac-autoconfig` skill
  already warns agents about this case).
- **Subtractions.** Remove (a) container ports already in
  `getSessionPorts(sessionId)`; (b) an **infra ignore-set** — yaac's own
  in-pod listeners (streamd `POD_STREAM_PORT`, tmux, any control channel),
  which must **fail closed**: forwarding an internal control port is a pivot
  vector, so an unrecognized-but-infra port is hidden, not surfaced; (c) a
  **sensitive-port denylist** (see Security) excluded from auto-surface; (d) a
  per-session **dismissed** set (see Open questions).
- **Lifecycle.** Track running sessions off the existing informer/reconciler;
  tear down the map entry on reap/delete; debounce streamd pushes so a
  restarting dev server doesn't flap the badge.

## 2. Wire type

Add `unforwardedPorts: number[]` to the session entry type in
`packages/shared/src/types.ts` (next to `forwardedPorts`/`blockedHosts`).
Populate it in `features/sessions/list.ts` from the detector map where
`forwardedPorts`/`blockedHosts` are set; default `[]` for non-running rows.

## 3. Action route + handler

Mirror the allow-host route. `POST /:id/forward-port` in
`routes/sessions.ts`, zod body `{ containerPort: int 1–65535, persist?:
boolean }`. Cross-check `containerPort` against the currently-detected set
for that session (reject a port that isn't listening), so the action can't be
driven to forward an arbitrary port.

New `features/sessions/forwarders/forward-port.ts` →
`forwardSessionPort(target, containerPort, {persist})`:

- **`persist: false`** (this session) — reserve one host port and start one
  relay for `containerPort` on the running pod, append its stop-fn +
  `PortMapping` to the existing forwarder-registry entry, refresh the tmux
  `status-right`. This calls the new single-forward helper in §4.
- **`persist: true`** (project) — `addPortForwardToProjectConfig(slug,
  containerPort)` (new, mirroring `addAllowedHostToProjectConfig` /
  `withAllowedHost` in `features/projects/local-config.ts`): append
  `{containerPort, hostPortStart: containerPort}` to the stored config's
  `portForward`, de-duped. Then do the live forward for the current session,
  and fan out to the project's other running sessions (matching allow-host).
- Either way, `notifySessionListChanged()` pushes a fresh snapshot that moves
  the port from `unforwardedPorts` into `forwardedPorts`, self-clearing the
  popover row.

## 4. Registry — a single-forward append helper

Today the forwarder registry only registers/replaces a whole session's
forwards. Factor the per-port step that `provisionSessionForwarders` already
runs in a loop into an exported helper that: `reserveAvailablePort`s one host
port, starts one relay listener via the same `RelayFactory` the create/restart
paths use, appends the stop-fn + `PortMapping` to the session's registry
entry (creating it if absent), and updates the tmux status-right. Because it
sits above the `RelayFactory` seam, it is agnostic to the kubectl-vs-streamd
relay.

## 5. Frontend

New `UnforwardedPortsBadge.tsx` modeled on `BlockedHostsBadge.tsx`: a popover
listing each detected port, each row offering **"Forward for this session"**
(`persist:false`), **"Forward permanently for this project"** (`persist:true`),
and **Dismiss**. Each action shows the resolved **bind scope** it will expose
to (loopback vs tailnet — see Security). Add `forwardSessionPort(sessionId,
containerPort, {persist})` to a small api lib mirroring `blockedHostsApi.ts`.

Render it in `SessionView.tsx` at the preview-button location (~lines
569–583), shown when `session.unforwardedPorts.length > 0`, alongside/replacing
the preview button and `ForwardedPortLinks` chips in that slot.

## Security

Forwarding runs *ingress* into the sandbox (host/tailnet → in-pod service via
the relay's in-pod `localhost` dial), the opposite direction from the egress
proxy's controls. Config-declared forwards already do this, but the user
declares those deliberately, ahead of time. The new risk is that detection is
driven by **agent-controlled state** (`/proc/net/tcp`) and the affordance is
one click — a lower-friction, agent-influenced path to opening ingress, where
the party influencing the click is the sandboxed party.

- **Agent / prompt-injection can manufacture the forward.** The agent can
  bind any loopback port at will; an injected agent can spin up a
  plausible-looking listener specifically to get "forward permanently"
  offered. `persist:true` makes it durable (writes config + fans out).
  Mitigation: keep `persist:true` the higher-friction action, with the
  exposed bind scope shown explicitly.
- **Exposure scope = the bind address.** `env.forwardBind` (`YAAC_FORWARD_BIND`)
  defaults to loopback but is the tailnet IP on a remote host, so a one-click
  forward can publish an unauthenticated in-pod service to every tailnet peer.
  Show the exact bind in the UI; consider defaulting the one-click forward to
  loopback-only with tailnet as an explicit opt-in.
- **Sensitive-port denylist.** Exclude known-dangerous ports from auto-surface
  (or require extra confirmation): Node `--inspect` 9229 (= RCE on the pod),
  SSH 22, Postgres 5432, MySQL 3306, Redis 6379, Mongo 27017, etc.
- **Fail-closed infra filter.** Never surface yaac's own in-pod control
  listeners (§1); an unrecognized infra-range port is hidden, not offered.
- **No shell interpolation.** Detected ports come from hex-parsing
  agent-controlled `/proc/net/tcp*`; validate as int 1–65535 and keep the
  relay on its arg-array spawn form (`nc localhost <port>` / streamd
  `net.connect(127.0.0.1, port)`), never a shell string. The parser must be
  bounded against hostile/huge `/proc` output.
- **Confused-deputy / scope.** Reuse allow-host's exact target resolution so
  `/:id/forward-port` touches only the pod for `:id`, `persist:true` writes
  only that session's project config, and fan-out cannot cross project
  boundaries.
- **Resource DoS.** A malicious agent can open thousands of listeners; cap the
  number surfaced per session, cap forwards per session/total, and rate-limit
  the route (this also bounds streamd's concurrent-stream cap — below).
- **TOCTOU (low severity).** Forwarding is by port number; between detection
  and forward the agent can rebind the port to a different service. Not
  pinned; noted, not a blocker.

## Interaction with the streamd data-plane relay

`docs/stream-relay.md` moves session streams onto an in-pod `streamd`
reached through the proxy relay, and deletes the kubectl stream paths. Impact
on this feature:

- **Detection transport.** Post-relay there is no `kubectl exec … cat` — the
  one-shot session-pod exec call sites migrate onto `ctrl` streams. Detection
  lives in **streamd itself**: it observes listener state in-pod and **pushes**
  a "listeners changed" event up the already-open relay (§1), so the server
  runs no detection poll. Not shipping raw `/proc` over the wire; streamd
  parses in-pod and authoritatively excludes its own `POD_STREAM_PORT` and
  other infra.
- **Forwarding transport is unchanged for us.** streamd swaps `kubectlRelay`
  for a `tcp`-stream `RelayFactory` adapter *behind* the seam
  `startPortForwarders`/the registry consume. The §4 single-forward helper
  sits above that seam, so it works identically before and after — no rework.
- **Ingress lock.** streamd ships a session-pod ingress lock (pod accepts only
  `POD_STREAM_PORT` from the proxy). The forward's in-pod `localhost`-origin
  dial is preserved by design, so localhost-bound dev servers stay reachable;
  the lock does not block forwarding.
- **Stream cap.** streamd enforces a concurrent-stream cap; many forwarded
  ports = many `tcp` streams through the relay. The per-session forward cap
  (Security → DoS) should stay under that budget.
- **Sequencing.** Build the *action/UI* half against the current
  `RelayFactory` seam any time. Build *detection* on the streamd `ports` path
  and land it alongside relay phase 2 (top-level) / phase 4 (kubectl-path
  deletion). If detection must ship before streamd, implement it as a one-shot
  `containerExec cat /proc/net/tcp*` and migrate it onto the `ports` query in
  the streamd cutover (it is one of the "one-shot session-pod command" call
  sites that plan already migrates).

## Phases

1. **Action + UI on the current relay.** `unforwardedPorts` wire field (fed by
   an interim `containerExec cat /proc/net/tcp*` detector at the ~20s heartbeat
   cadence, not a tight poll), single-forward
   append helper, `POST /:id/forward-port` (both modes),
   `addPortForwardToProjectConfig`, `UnforwardedPortsBadge` in the preview
   slot, bind-scope + sensitive-port denylist. E2e: listener on an
   un-forwarded port surfaces, forward moves it to `forwardedPorts`, relay
   serves traffic, `persist:true` writes `portForward`.
2. **Detection onto streamd.** Add the in-pod listener watch + push to streamd;
   feed the detector map from the relay push; drop the interim exec. Lands with
   relay phase 2/4.

## Tests

Per CLAUDE.md (every exported fn gets a unit test in its package `test/`
mirror; config fields covered end-to-end in e2e):

- Unit (`packages/server/test/features/sessions/forwarders/…`): `/proc/net/tcp{,6}`
  LISTEN parser (loopback/wildcard filter, IPv6, torn/hostile output), the
  detector → snapshot map (subtractions incl. fail-closed infra + denylist),
  `forwardSessionPort` both modes, the single-forward append helper.
- Unit (`…/features/projects/…`): `addPortForwardToProjectConfig` (append,
  de-dupe, `setAllowedUrls`-style pinned vs additive parity if applicable).
- Unit (`…/routes/…`): `POST /:id/forward-port` body validation + detected-set
  cross-check.
- E2e (`test/e2e-cli/` or `test/e2e/`, `requirePrebuilt: true`): start a
  listener on an un-forwarded port → assert `unforwardedPorts` → forward
  (`persist:false`) → assert `forwardedPorts` + real traffic; `persist:true`
  writes `portForward` into the project `yaac-config.json`; a
  denylisted/infra port is never surfaced.
- No DB schema change → no Drizzle migration.

## Open questions

- **Dismiss semantics.** Unlike allow-host, *not* forwarding is a legitimate
  permanent choice, so a dismiss is needed to stop nagging. Start with an
  in-memory per-session dismiss (resets on server restart); add a persisted
  per-project "ignore these container ports" list only if that proves
  annoying.
- **Bind-scope default.** Default the one-click forward to loopback-only and
  make tailnet exposure an explicit opt-in, or inherit `forwardBind` as-is?
  Leaning loopback-default for the reactive path.
- **persist:true fan-out.** Match allow-host and fan out to sibling running
  sessions, or forward only the current one and let config pick up the rest on
  next create? Leaning match-allow-host for consistency.
- **Infra ignore-set.** Confirm the exact in-pod infra listeners streamd must
  always hide, with one empirical pass in a real pod.
