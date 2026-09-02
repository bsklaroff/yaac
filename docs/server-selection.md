# How a client finds its server

Every client on a machine — the CLI, the desktop shell, the auth daemon —
reaches its yaac server the same way, whatever substrate that server runs on
and wherever it is: an **origin plus a durable token**, recorded in
`~/.yaac-client/server.json`. There is no local case, no lock to read, and no
client that starts a server.

```
yaac server start ──(containerless)──┐
                                     ├─► registerServer(origin, driver)
yaac cluster install ──(k8s)─────────┘            │
                                                  ▼
                             ~/.yaac-client/server.json
                       { url, token, enabled, saved, driver }
                                                  │ the only thing they read
                    CLI ─ desktop ─ auth daemon ─ test fixtures
```

## Why there is no local case

A client cannot dial a server just because one is running on this machine.
Under `k8s` the server is a pod (docs/server-in-cluster.md): its lock belongs
to the pod's uid, and the port in it is the one it binds *inside* the pod, so
`127.0.0.1:<that>` on the host is some unrelated listener — quite possibly
another yaac, which would answer and be believed. Reaching that server means
reaching the published origin with a token.

Once that is true for one substrate it may as well be true for both, and being
true for both is worth more than the shortcut: a containerless server
registers itself the same way, so nothing above the seam branches on where the
server runs. The CLI has no lock fallback, the desktop has no "Local server"
row, and a bug in one substrate's path cannot hide behind the other's.

## The registration

`registerServer(origin, driver)` in `@yaac/shared/server-config` is the one
bootstrap in the system, and both commands that stand a server up call it:
`yaac server start` for the host process it spawned, `yaac cluster install` for
the Deployment it applied.

1. If `server.json` already saves a token for `origin` and that token still
   authenticates, keep it. A routine `yaac server start` must not invalidate
   the token every other client on this machine is holding.
2. Otherwise read the server lock and, with its per-boot secret as the bearer,
   revoke-then-create the durable token `local-client`. Revoke-then-create
   because a token's value only leaves the server at creation, so a stale one
   cannot be recovered, only replaced.
3. Write the origin, the token and the driver in one atomic write.

The bootstrap works because the lock is on the **shared** data dir: a host
server writes it directly, and a pod writes it into the hostPath it mounts, so
either way the host can read the secret that authenticates as the server
itself. The token it buys is durable because the lock secret is per boot — a
config holding the old secret would be answered `BAD_BEARER` by the server's
own replacement.

A failed mint degrades to an empty token, which is correct on a
credential-optional install (`isCredentialOptional` keys on configuration, not
on the bind address) and a printed warning on one that requires a credential,
where an empty token is a lockout.

`yaac server run` registers nothing. It is the server process — bind, write
the lock, serve — and it is what `start` spawns detached, what the server
image's `CMD` runs in the pod, and what the e2e fixtures spawn directly. The
pod could not register even if it wanted to: the client-local tier is not
mounted into it. So `yaac server start` registers on its "already running" path
as well as after a fresh spawn, and a server someone ran in the foreground is
adopted by running `start` against it.

## What `server.json` holds

```json
{ "url": "http://127.0.0.1:8787", "token": "…", "enabled": true,
  "saved": [ { "url": "…", "token": "…" } ], "driver": "containerless" }
```

`url`/`token` are the selected server; `enabled` deselects it without losing
the token; `saved` remembers every server ever configured so a client can
switch back without re-entering one. The machine has one selection at a time —
`saved` is history, not contexts.

`driver` is which substrate **this install** runs, not which substrate the
selected server runs. It is top-level rather than per-entry because its readers
ask about this data dir ("is there a host server to start, or a Deployment to
converge?"), and that does not change when the selection points at another
machine — so `yaac remote set https://elsewhere` cannot unlock a host `yaac
server start` on a k8s install. A server elsewhere has no recorded driver at
all; its snapshot reports one live. `recordedDriver` reads the field, and
`assertHostServerAllowed` is the refusal it feeds.

`yaac remote unset` therefore rewrites the file rather than deleting it:
dropping `driver` with the selection would leave a k8s install unable to refuse
a host start, which is two writers on one PGlite directory.

## Deselected means unreachable

`yaac remote off` (and a fresh install) leaves nothing selected, and every
client then says so:

```
No yaac server selected.
    Start one on this machine with `yaac server start` (or `yaac cluster install` on a k8s install),
    or point at one with `yaac remote set <url> --token <token>`.
```

All three commands are named because which one applies is a property of the
install, and this message is exactly what prints when nothing on disk says
which kind of install it is.

Nothing recovers from this by starting a server. `yaac open` reports and exits;
the desktop shell shows its picker. `yaac server start` is the only starter,
which is what keeps a client from spawning a host process beside a Deployment.

## Build skew is a warning

Client and server upgrade independently, and on this machine the server may be
a Deployment carrying an older bundle, so a build-id difference is a
once-per-client warning on the request path rather than an error
(`describeBuildSkew`). A loopback origin gets the fix named: roll the server
onto this build. The only place a mismatch is still fatal is `yaac server
start`, which compares the lock's build id to its own before it reports success.

Pure clients that ship no server code — the desktop shell, the auth daemon —
pass `warnOnBuildSkew: false`: they have no build identity to compare, and any
server they can reach serves them its own matching SPA.

## The desktop shell

The shell is a client like any other. It resolves `server.json`, mints a
one-time exchange token, and loads `<origin>/?token=…`; it never reads a lock
and never starts a server (see packages/desktop/README.md).

When no server is reachable — nothing selected, or the selected one refused the
mint — the window shows a **picker** instead of an error dialog, because with
no server there is no SPA to render a settings pane and a dialog over a blank
window leaves nothing to click. The picker is shell-owned, rendered as an HTML
string on a `data:` URL exactly like the boot splash, so it needs no renderer
bundle: it states the failure verbatim, lists every saved origin with a Connect
button, and takes a new origin plus token. Its buttons drive the same preload
bridge the SPA's Settings → Server section uses, so both paths land on the same
re-validated main-process handlers.

Connect on the *already selected* origin is a real retry, not a no-op — from
the picker that button is how a server that has since come back gets reached,
and answering "no change" would strand the window on the failure.
