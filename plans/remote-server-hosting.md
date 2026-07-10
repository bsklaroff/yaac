# Remote yaac for a solo developer: Tailscale + a real CLI client

## Goal

One developer, an always-on server, and the freedom to close the laptop.

- A single **server** (home box or cloud VM) runs the *entire* yaac stack:
  the kind cluster, podman, and the server. Sessions are Kubernetes Jobs on
  that server's cluster, so they keep running regardless of any client.
- The **laptop, phone, and tablet are thin clients.** The CLI talks to the
  remote server; the webapp is just a browser pointed at the server. Closing
  the laptop drops a client, never a session.
- Reaching the server is private and secure with near-zero ops: a
  **Tailscale** tailnet (WireGuard mesh) plus `tailscale serve` for HTTPS.

This is the `A2 + B` combination from the earlier survey, fleshed out for
exactly this use case. Everything multi-user (shared fleets, per-user
credential vaults, identity, public exposure) is **explicitly out of scope** —
see [Deliberately out of scope](#deliberately-out-of-scope).

## Why these two pieces, and why together

The earlier survey established that the webapp is already remote-ready (it
builds URLs from `window.location` and upgrades to `wss` —
`src/frontend/lib/useEvents.ts:26`, `src/frontend/components/
SessionTerminal.tsx:108`) and that the blockers are concentrated in the
server's loopback posture and the CLI's hardcoded transport. Two changes clear
them:

- **A2 — Tailscale transport.** Gets bytes from any of my devices to the
  server privately, with a real TLS cert and no inbound firewall holes.
- **B — a first-class remote CLI client.** Teaches `yaac` to point at a
  configured remote, authenticated by a **durable token**.

B is the load-bearing piece, and the reason is specific: **the remote CLI
cannot read the server's lock file.** Today the only CLI credential is the
bearer secret in `~/.yaac/.server.lock`, which is regenerated on every server
start (`src/server/cli.ts:137`) and read fresh from disk on every call
(`src/shared/server-client.ts:135`). A laptop has no access to that file and
it rotates on every restart anyway. The webapp already sidesteps this with the
bootstrap-code → HttpOnly-cookie flow (`src/server/web-auth.ts`); the CLI has
no equivalent. So B's core deliverable is a **stable, revocable token** the
client can store, plus the client config to use it.

A2 without B = the webapp works but the CLI doesn't. B without A2 = works over
a plain `ssh -L` tunnel but you babysit the tunnel. Together they're the whole
solo-remote story. Usefully, **B is testable over an SSH tunnel before any
Tailscale exists**, which is how the phases below are ordered.

## Target topology

```
        SERVER (always on, joined to tailnet)
   ┌─────────────────────────────────────────────┐
   │  kind cluster ── podman ── session Jobs      │
   │        ▲                                      │
   │        │ kubectl / podman (local)             │
   │   yaac server  ─ listens 127.0.0.1:8787 ─┐    │
   │        ▲ loopback only (unchanged)       │    │
   │   tailscale serve  https ─► 127.0.0.1:8787    │
   │        │  (TLS termination, tailnet-only)     │
   └────────┼─────────────────────────────────────┘
            │  WireGuard (tailnet)
   ┌────────┴───────────┐     ┌──────────────────────────┐
   │ laptop / desktop   │     │ phone / tablet (browser)  │
   │ yaac CLI + context │     │ https://srv.tail….ts.net  │
   │ + durable token    │     │ (bootstrap → cookie)      │
   └────────────────────┘     └──────────────────────────┘
```

**Why `tailscale serve` rather than binding the server to the tailnet:**

- The server keeps its **loopback bind unchanged** (`src/server/cli.ts:100`) —
  the smallest, safest possible server-side change. Serve proxies the tailnet
  to `127.0.0.1`; nothing else can reach the server.
- **Real TLS** with a valid `*.ts.net` cert, so browsers are happy, `wss`
  works, and we can set a `Secure` cookie — no self-signed cert warnings.
- **Tailnet-only.** Serve (not Funnel) never exposes the server to the public
  internet. The trust boundary is exactly "my devices."
- WebSocket-capable, so `/events` and `/pty/attach` ride through it.

A raw "bind to the Tailscale interface IP, plaintext HTTP over WireGuard"
variant also works (WireGuard encrypts the wire) and needs only a bind-address
change, but it loses the TLS niceties and a clean hostname. Keep it as a
fallback, not the default.

## Design

Three independently shippable layers. The first is pure client/server code and
needs no Tailscale; the second is the Tailscale security posture; the third is
the "survives a reboot" server lifecycle.

### Layer 1 — Durable token + remote CLI context (the B work)

**Server: a persistent token store.** Separate from the ephemeral lock secret.

- New `src/lib/auth/tokens.ts`: a `~/.yaac/tokens.json` store (mode `0600`,
  same sensitivity as the lock and `.web-sessions.json` —
  `src/shared/paths.ts:67`). Entries `{ name, token, createdAt }`. Exported:
  `createToken(name)`, `listTokens()` (returns masked), `revokeToken(name)`,
  `isValidToken(secret)` (constant-time compare). Plaintext-at-rest matches
  the existing lock-secret convention; hashing the stored value is a noted
  optional hardening, not required for v1.
- `src/server/web-auth.ts`: extend `cookieOrBearerAuth` so a request is
  accepted if its bearer matches the lock secret **or** any valid stored
  token. One extra constant-time check in the existing gate.
- `src/server/routes/auth.ts`: add `POST /auth/tokens` (create, returns the
  secret once), `GET /auth/tokens` (list masked), `DELETE /auth/tokens/:name`
  (revoke). These are authenticated like every other route, which gives a
  clean bootstrap: you mint the first token **on the server over loopback**,
  where the lock secret is available.
- `src/cli.ts`: `yaac auth token create <name> | list | revoke <name>`. Per
  `AGENTS.md`, every command/option gets an e2e test and every exported store
  function a unit test. Full CRUD parity (create/list/revoke), no minimal
  shim.

**Client: named remote contexts.** Modeled on `kubectl`/`docker context`.

- New `src/shared/contexts.ts`: a `~/.yaac/contexts.json`
  (`{ active, contexts: { <name>: { url, token } } }`, `0600`). Exported:
  `readContexts`, `getActiveContext`, `addContext`, `setActiveContext`,
  `removeContext`. Token is the durable token from above.
- `src/shared/server-client.ts` — the central refactor. Today
  `defaultResolveLock` returns a `ServerLock` and `createServerFetch`
  hardcodes `http://127.0.0.1:${lock.port}` (`:44`). Generalize the resolved
  shape to a **`ServerTarget` = `{ baseUrl, secret, buildId? }`** and migrate
  every call site in the same change (no back-compat alias, per house rule):
  - local lock → `{ baseUrl: 'http://127.0.0.1:'+port, secret }` (today's
    behavior, still the default);
  - active remote context → `{ baseUrl: context.url, secret: context.token }`;
  - the existing `YAAC_SERVER_URL` + `YAAC_SERVER_SECRET` env hatch (`:137`)
    folds into this as the highest-precedence override.
  `createServerFetch` then targets `target.baseUrl + pathAndSearch`. The
  `BAD_BEARER` re-resolve path (`:52`) is local-only (re-reading a lock helps
  nothing remote); for a remote target a 401 surfaces as an auth error telling
  the user to refresh the context token. The typed Hono RPC client
  (`getRpcClient`) is untouched — it already routes through the pluggable
  fetch.
- `src/cli.ts`: `yaac context add <name> --url <url> --token <token>`,
  `yaac context list`, `yaac context use <name>`, `yaac context remove <name>`,
  plus a global `--context <name>` flag and `YAAC_CONTEXT` env for per-call
  override. e2e tests for each.
- **`yaac open` becomes context-aware.** Against a remote context it fetches
  the (authenticated) `/auth/bootstrap-code` over the context and prints
  `https://<remote-host>/?bootstrap=<code>` — a URL openable on any tailnet
  device (phone included). Today it builds a `127.0.0.1` URL from the local
  lock (`src/server/cli.ts:435`); generalize the host from the active target.
- **Build-id skew:** `describeLockMismatch` compares the local lock's buildId
  to the CLI's (`src/shared/server-client.ts:106`). For a remote target there
  is no lock; read `buildId` from the server's `/health` (it already returns
  it — `src/server/server.ts:108`) and **warn** on mismatch rather than
  hard-fail, since the client and server are now upgraded independently.

### The webapp doesn't pick a context — its origin *is* the context

If the CLI has named contexts, how does the **webapp** choose which server to
talk to? It doesn't, and structurally can't the way the CLI does — by design:

- The SPA is **served by the server and bound to that origin.** Every call is
  origin-relative: `/auth/bootstrap` with `credentials: 'same-origin'`
  (`src/frontend/lib/bootstrap.ts`), `window.location.host` for the WebSockets
  (`src/frontend/lib/useEvents.ts:27`). Its auth cookie is per-origin
  (HttpOnly, `SameSite=Strict`), and its localStorage (selection, layouts —
  `src/frontend/store.ts`) is per-origin too.
- So "which server" is decided entirely by **which URL you load**:
  `http://127.0.0.1:8787/` is the local server; `https://srv.<tailnet>.ts.net/`
  is the remote one. The CLI's `contexts.json` never enters the browser.

The CLI needs an explicit selector because one binary fans out to many
servers; the webapp is the mirror image — many SPA instances, each pinned to
one server. The two selectors are **parallel, not coupled**: `yaac context use
home` does not change what an open browser tab shows.

For the solo case the recommendation is simply: **bookmark the remote URL.**
`yaac open` (context-aware, from Layer 1) hands you a fresh authed
`https://…/?bootstrap=<code>` link whenever the cookie lapses, openable on any
tailnet device including a phone.

A true *in-app* server switcher (a dropdown that calls a different server's
API) is intentionally **out of scope**: cross-origin calls would break the
per-origin cookie, trip `denyBrowserCors`, and need a different auth model. The
only same-origin-safe version is a "known servers" list that *navigates*
(`window.location.href = otherOrigin`) — i.e. bookmarks of authed URLs, each
target re-using its own persisted cookie (`.web-sessions.json` survives server
restarts). Not worth building for one developer with one server.

### Layer 2 — Tailscale Serve security posture (the A2 work)

All opt-in, so the server's default remains loopback-only and safe.

- **Host allowlist.** `isAllowedHost` accepts only loopback today
  (`src/server/web-auth.ts:150`), an anti-DNS-rebind guard we keep. Add an
  opt-in `YAAC_ALLOWED_HOSTS` (comma-separated) so the server admits its
  `*.ts.net` MagicDNS name. Loopback stays allowed unconditionally. *Verify
  during implementation what `tailscale serve` sets as the `Host` header* — if
  it forwards the MagicDNS name, the allowlist covers it; if it rewrites to
  `127.0.0.1`, the existing loopback rule already passes. Either way it's
  handled.
- **`Secure` cookie over TLS.** The bootstrap cookie omits `Secure` today
  because the server is plain http on loopback (`src/server/server.ts:84`).
  Behind Serve the server still sees http but gets `X-Forwarded-Proto: https`.
  Set `Secure` when XFP is `https`, gated on an opt-in `YAAC_TRUST_PROXY=1`
  (only set when actually behind Serve) so a direct-loopback request can't
  spoof the header into a posture change. `SameSite=Strict` is unchanged and
  fine for same-origin navigation.
- **CORS: no change.** `denyBrowserCors` only rejects `OPTIONS`
  (`src/server/auth.ts:11`); Serve keeps the webapp same-origin with the
  server, so no preflight occurs. (A split-origin frontend *would* need real
  CORS — that's out of scope.)
- **No bind change.** Serve → loopback means `src/server/cli.ts:100` is
  untouched.

### Layer 3 — Server lifecycle ("close the laptop" for real)

The server and cluster must outlive any login session and survive reboots.

- **Server as a systemd service.** Today `yaac server start` spawns a detached
  process (`src/server/cli.ts:495`) — fine for a laptop, not for a server. Ship
  a sample unit running `yaac server run` in the foreground with
  `Restart=always`, `WantedBy=multi-user.target`, and the env from Layer 2
  (`YAAC_ALLOWED_HOSTS`, `YAAC_TRUST_PROXY=1`). Now the server restarts on
  crash and on boot.
- **Cluster survives reboot.** Ensure the kind node container restarts on boot
  (restart policy / a boot unit) so the cluster — and the session Jobs on it —
  come back without manual `setup-kind-cluster.sh`. Flag as a server-ops item
  to verify with the podman-provider kind setup; wire the restart policy in
  `scripts/setup-kind-cluster.sh` if it isn't already durable.
- **Tailscale.** `tailscaled` is a standard system service; `tailscale serve`
  config persists in tailscaled state, so it re-applies on boot.

## Forwarded ports under remote hosting

yaac forwards a session's dev-server port to the server host: it binds the
host port on **`127.0.0.1`** (`src/lib/container/port.ts:24`) and relays it
into the pod via `kubectl exec … nc localhost <containerPort>`. Ports are
declared per project in `yaac-config.json`
(`portForward: [{ containerPort, hostPortStart }]`) and shown in the tmux
status bar.

Locally that's seamless — the server host *is* your laptop, so
`localhost:<hostPort>` in the browser hits the dev server. **Remotely it breaks
at exactly one hop:** the pod→host forward still works (it's all server-local),
but it terminates on the *server's* loopback, which the laptop can't reach. The
missing piece is the **host→client** hop. Three ways to bridge it, in
recommended order:

- **B (default for Tailscale) — bind forwarders on the tailnet interface.**
  Make the `127.0.0.1` bind (`src/lib/container/port.ts:24`) configurable and,
  on the server, bind the tailnet IP. Then `http://srv.<tailnet>.ts.net:<host
  Port>/` reaches the dev server directly over WireGuard, **same port number
  preserved**. Smallest change, no per-port `tailscale serve` juggling,
  WireGuard-encrypted.
  - *Caveat:* the port is then reachable by any tailnet device, not gated by
    the yaac token — fine under this plan's "trust boundary = the tailnet"
    stance for a solo tailnet, a real consideration on a shared one. No TLS
    (WireGuard encrypts; dev servers are usually http anyway).
  - *Webapp synergy (ties back to origin-binding):* the webapp, served from
    `srv.<tailnet>.ts.net`, can render a session's ports as clickable links by
    taking `window.location.hostname` and swapping in `hostPort` — correct
    automatically on whatever host you loaded it from (loopback locally,
    tailnet name remotely).
  - *Cross-plan dependency:* `plans/forwarded-port-env.md` injects the actual
    `hostPort` into the container so dev servers build correct callback URLs
    (the reserved port can differ from the configured one —
    `reserveAvailablePort` scans forward). Remotely the externally-reachable
    **host** is the tailnet name, not `localhost`, so that injection must
    generalize to carry host+port (or a full base URL) sourced from the
    server's external-host setting.

- **C (best UX, transport-agnostic) — `yaac port-forward` to the client's
  localhost.** A new CLI command opens a listener on the laptop
  (`localhost:3000`) and tunnels TCP through the server's authenticated channel
  into the pod — `kubectl port-forward`, but over the server. Stream the TCP
  bytes over a WebSocket endpoint (the PTY bridge is the existing pattern for
  piping a byte stream over a socket — `src/server/pty-bridge.ts`).
  - *Pros:* preserves `localhost:<port>` on every device regardless of where
    the server runs (great for dev servers with hardcoded `localhost`
    callbacks); **token-gated** through yaac auth; works over **any** context,
    not just Tailscale; exposes nothing on the tailnet.
  - *Cons:* real build (TCP-over-WS proxy + local listener + lifecycle +
    tests). Browser-side it doesn't apply (a tab can't open localhost
    listeners), so the webapp still uses B-style links.

- **A (avoid as the general mechanism) — Tailscale Serve sub-paths / extra
  ports.** Serve *can* mount a dev server under a path or an extra HTTPS port,
  but the usable HTTPS ports are limited (443/8443/10000) and subpath mounting
  breaks any dev server that assumes root-absolute asset/cookie paths, plus
  Serve would need reconfiguring as sessions come and go. Fine for one
  well-behaved long-lived service; wrong as the default.

**Config story.** Keep `portForward` per-project (it declares *container*
ports, read server-side — the pod→host hop stays automatic). Add the exposure
decision — `loopback` (today) | `tailnet` (Option B) | `off` — and the
external host name as a **server/server-level** setting, since it's deployment
topology, not project config. Default stays `loopback`, preserving today's
behavior.

## End-to-end setup (the runbook this plan enables)

On the **server** (Linux, per the README's Linux path — needs user
namespaces / idmapped mounts, so a bare-metal box or a nesting-capable VM, not
a macOS-in-VM host):

```sh
# 1. yaac + cluster
pnpm build && npm install -g .
./scripts/setup-kind-cluster.sh && yaac cluster check

# 2. tailnet + HTTPS on the tailnet only (not Funnel)
tailscale up
tailscale serve --bg https / http://127.0.0.1:8787   # srv.<tailnet>.ts.net

# 3. run the server as a service (env: YAAC_ALLOWED_HOSTS, YAAC_TRUST_PROXY=1)
sudo systemctl enable --now yaac-server

# 4. mint a durable client token (loopback → uses the lock secret)
yaac auth token create laptop      # prints the token once
```

On the **laptop** (also on the tailnet):

```sh
yaac context add home \
  --url https://srv.<tailnet>.ts.net \
  --token <token-from-step-4>
yaac context use home
yaac session list                  # talks to the remote server
yaac open                          # prints an authed https URL for any device
```

Close the laptop. The server and every session keep running on the server.

## Security model

- **Trust boundary = the tailnet.** Only my enrolled devices can route to the
  `*.ts.net` host. WireGuard encrypts the wire; Serve adds TLS on top.
- **Remote is opt-in and default-safe.** With no `YAAC_ALLOWED_HOSTS` /
  `YAAC_TRUST_PROXY` and no `tailscale serve`, the server is exactly as
  loopback-locked as today. Nothing about installing this weakens the local
  default.
- **Tokens are durable and revocable.** A lost laptop is handled by
  `yaac auth token revoke laptop` on the server — no server restart, no
  effect on other tokens or the webapp.
- **Never Funnel.** Public exposure is explicitly not part of this; Serve is
  tailnet-scoped.
- **Credentials stay single-user/global.** The proxy still injects the one
  set of Claude/GitHub creds under `~/.yaac` — correct for a solo developer,
  and the reason multi-user is a different project.

## Deliberately out of scope

Per tight-YAGNI: build nothing here for a future multi-user world.

- No per-user identity, login, or authz — one token-holder, full access.
- No per-user credential vault — global creds are right for one person.
- No public/Funnel exposure, no hosted control plane, no control-plane/runner
  split.
- No split-origin frontend, so no real CORS layer.

If "a teammate needs in" ever arrives, that's the separate Approach C/D work
from the survey, not an extension of this.

## Risks & open questions

- **Tailscale Serve header behavior** (`Host`, `X-Forwarded-Proto`) — verify
  empirically; the Layer-2 design is written to tolerate either Host value.
- **WebSocket idle timeouts.** `/events` has no server heartbeat (`src/server/
  events.ts`); a proxy idle-timeout could drop it. Correctness is already
  covered by client auto-reconnect (`src/frontend/lib/reconnect.ts`), but a
  periodic app-level ping (the PTY bridge already speaks `ping`/`pong` —
  `src/server/pty-bridge.ts:166`) is cheap hardening if drops are frequent.
- **Cluster reboot durability** with the podman kind provider — confirm the
  node container and Jobs return cleanly after a server reboot.
- **Build-id skew** between an updated client CLI and the server server —
  Layer 1 downgrades this to a warning; confirm that's the behavior we want.
- **Server hardware** must support user namespaces / idmapped mounts
  (ext4/xfs/btrfs); a cheap VM that can't nest may not qualify.
- **No new runtime dependencies** are anticipated (Tailscale is external,
  systemd is the OS). If any are added, pin exact versions (`pnpm add -E`).

## Phased delivery

1. **Phase 1 — token store + CLI contexts (Layer 1).** Pure code; validate
   end-to-end over a plain `ssh -L 8787:127.0.0.1:8787 server` tunnel, no
   Tailscale yet. Lands the durable-token + `ServerTarget` refactor + the
   `context`/`auth token` commands with their unit + e2e tests.
2. **Phase 2 — Tailscale posture (Layer 2).** `YAAC_ALLOWED_HOSTS`, the
   `X-Forwarded-Proto`-aware `Secure` cookie behind `YAAC_TRUST_PROXY`. Swap
   the SSH tunnel for `tailscale serve`. Webapp now reachable from a phone.
3. **Phase 3 — lifecycle (Layer 3).** systemd unit, cluster-reboot durability,
   documented runbook. After this, closing the laptop is a non-event.
4. **Phase 4 — forwarded ports (optional, as needed).** Option B (configurable
   forwarder bind + external-host injection, extending
   `plans/forwarded-port-env.md`) for tailnet-direct dev servers, and/or
   Option C (`yaac port-forward`) for a localhost-preserving, token-gated
   tunnel that works over any context. Independent of Phases 1–3.
