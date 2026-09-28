# Tailscale-only authentication: delete the token machinery

This is phase 1 of docs/plans/multi-user-deployment.md, planned to the level
of files and functions. The server stops asking whether a credential is valid
and starts asking who is calling. There are two answers. A request is
**local** if it reached the bind without passing through anything. It is
**tailnet** if `tailscale serve` forwarded it and stamped the caller's identity
on it. Durable tokens, one-time exchange tokens, web-session cookies, the
lock-secret bearer, `YAAC_REQUIRE_AUTH` and `YAAC_TRUST_PROXY` all go.

The plan refines the multi-user doc in three places, each argued below:

- It adds no `YAAC_IDENTITY` knob. The rule is derived from the request.
- It replaces `tailscale-only` with a Host rule that fails closed.
- It keeps the nested-server relaxation instead of deleting it.

## What changes for a user

| | Today | After |
|---|---|---|
| Local CLI, desktop, browser | No credential on a loopback-only install. A durable `local-client` token in `server.json` otherwise | No credential, ever. `server.json` is `{url, enabled, saved[{url}], driver}` |
| Remote CLI | `yaac auth token create laptop` on the server, then `yaac remote set <url> --token …` | `yaac remote set https://srv.<tailnet>.ts.net`. The device's tailnet user is the identity |
| Remote browser or phone | Paste a token into the connect splash, which is traded for an HttpOnly cookie | Open the ts.net origin. Nothing to paste |
| Desktop app | Mints a one-time token and loads `/?token=…` | Loads the origin |
| Revoking a lost device | `yaac auth token revoke laptop` | Remove the device from the tailnet in the Tailscale admin console |
| Who may reach a fronted server | Anyone on the tailnet who holds a token | Anyone the tailnet's ACLs let reach the server's device (see "Open decisions") |
| Server env for remote hosting | `YAAC_ALLOWED_HOSTS` + `YAAC_TRUST_PROXY` | `YAAC_ALLOWED_HOSTS` only |

## Step 0: verify the Tailscale facts on a real node

The design rests on how `tailscale serve` behaves. Check each fact against a
real node before writing code, and record the answers in the rewritten
docs/remote-hosting.md.

1. On proxied tailnet requests, serve sets `Tailscale-User-Login` and
   `Tailscale-User-Name`. It **strips** client-supplied copies of both.
   Check whether a non-ASCII display name arrives encoded (RFC 2047).
2. Serve sets `X-Forwarded-For` on every request it proxies, including
   requests from tagged devices and from Funnel. That makes XFF the
   "came through serve" signal even when no user header is present.
3. Serve preserves the client's `Host`. Today's need for
   `YAAC_ALLOWED_HOSTS` implies it does. Also check what arrives when a
   tailnet client forges `Host: 127.0.0.1`: expect the identity headers and
   XFF regardless.
4. Serve carries all of the above on WebSocket upgrade requests.
5. A request from a tagged device, and one through Funnel, arrives with XFF
   and no `Tailscale-User-Login`.
6. The Tailscale Kubernetes operator's **Ingress** (`ingressClassName:
   tailscale`) proxy adds the same identity headers. docs/plans/cloud-k8s.md
   step 6d depends on this and lists it among its checks. If it does not,
   the fallback is in workstream A.

## The identity rule

One middleware, `identify()` in `packages/server/src/api/http/web-auth.ts`,
replaces `cookieOrBearerAuth`. It runs after the Host, CORS, Origin and
Sec-Fetch-Site guards, which are unchanged. Upgrades pass through it as they
do today.

```
proxied   = request has X-Forwarded-For, or any Tailscale-User-* header
loopback  = Host's hostname is 127.0.0.1 or localhost

proxied, with Tailscale-User-Login      → { kind: 'tailnet', login, name }
proxied, without it                     → 401 UNAUTHENTICATED
                                          ("tailscale serve sent no user identity:
                                            a tagged device or Funnel")
not proxied, loopback Host              → { kind: 'local' }
not proxied, non-loopback Host,
  server inside a worktree              → { kind: 'local' }
not proxied, non-loopback Host,
  top-level server                      → 401 UNAUTHENTICATED
                                          ("reached as <host> without tailscale serve")
```

Public paths skip the rule: `/health`, `/`, and `/assets/*`. The SPA shell
stays public so that an unidentified browser can load and say what is wrong.
`POST /worktree/mama` drops off the public list. Its callers are
containerless worktrees at loopback, which are local, and the route still
checks its own per-worktree bearer. `POST /auth/web-session` goes with the
exchange.

The middleware stores the result with `c.set('principal', …)`. Two readers
consume it in this phase:

- A new `GET /whoami` route. It replaces both `GET /auth/web-session` (the
  SPA's probe) and `GET /tokens` (the CLI's "does my credential work" probe).
- `requestLogger`, which appends the login to each line. That gives the log
  an audit trail now that no token name identifies a device.

`Principal` is a wire type in `@yaac/shared/types`, because the SPA and the
CLI read `/whoami`. Phase 2's `domain/access` imports it from there.

### Why a Host rule, not a `YAAC_IDENTITY` knob

A knob can be left off. A server that is fronted but not told so would then
treat all fronted traffic as local. Deriving the answer from the request
fails closed:

- Any request addressed to a non-loopback name has to carry serve's identity.
- The Host check already admits only loopback and `YAAC_ALLOWED_HOSTS`.
  Setting `YAAC_ALLOWED_HOSTS` is therefore what opts a server into remote
  access, and remote access is then identity-only.
- Misconfigurations are refused, not silently trusted. Examples: an nginx
  front with no XFF, an L4 exposure, or Funnel.

That also makes `tailscale-only` unnecessary. The fronting that needs it,
the in-cluster tailnet fronting, never presents a loopback Host.

What the rule cannot stop is a client forging `Host: 127.0.0.1` over a path
that is not serve and not loopback. Every such path has to be either closed
or trusted:

- **Host server**: `server run` refuses a non-loopback `YAAC_BIND_ADDR`
  unless `YAAC_IN_CLUSTER` is set. Only the Deployment sets `0.0.0.0` today.
  A host bound to a LAN address would otherwise be an open door, and it
  already is one on a loopback-only install. This closes it.
- **kind fronting**: the port mapping listens on host `127.0.0.1`, and the
  Envoy forwarder is TCP, so headers pass through untouched. Unmediated
  reach is limited to host processes and nodes, and both are local by the
  standing reasoning of docs/remote-hosting.md. The server pod's ingress
  NetworkPolicy keeps worktree pods off the bind. It becomes load-bearing
  for authentication, as the multi-user doc says.
- **tailnet fronting**: today it is an L4 LoadBalancer, so any tailnet
  device can forge any header. It has to become L7 before the token gate
  goes (workstream A, which is cloud-k8s step 6d). The same applies to an
  install still fronted by a surviving L4 Service: it must be re-installed,
  not merely restarted, onto the release that removes tokens.

A local process can also forge `Tailscale-User-Login: bob`. That buys it
nothing it lacks already: a local process is the owner, can read the data
dir and can hold the lock.

### Nested servers keep a relaxation

A dev worktree's inner server inherits the outer install's
`YAAC_ALLOWED_HOSTS` through the preset, and it is reached as
`http://srv.<tailnet>.ts.net:9787` through `YAAC_FORWARD_BIND`. That is a
direct TCP path with no serve and no identity. The strict rule would refuse
it, and this repo's own dev loop uses it.

So inside a worktree (`env.worktreeId` set), an unproxied request is local
whatever its Host. This is the `YAAC_WORKTREE_ID` skip, narrowed:

- Serve-proxied traffic is still identified, and still refused when it
  carries no user.
- A deliberately fronted server started from a worktree therefore loses only
  the fail-closed guard against unsupported frontings. Today it loses the
  entire gate.

The "beware" caveat in docs/remote-hosting.md shrinks to one sentence.

### What still defends a browser

Identity is now ambient for a tailnet browser, as it already is for a local
one. Any request the device makes through serve carries the user. The
defenses against a malicious site are the three browser-enforced guards,
already load-bearing on loopback:

- `Host` (DNS rebinding)
- `Origin`
- `Sec-Fetch-Site`

The `OPTIONS` → 405 refusal keeps cross-origin pages from adding custom
headers such as a forged `Tailscale-User-Login`, since any such request needs
a preflight. `SameSite=Strict` goes with the cookie. It never covered a
top-level GET, and the Origin and Sec-Fetch-Site guards already cover
everything else.

## Workstreams

### A. Prerequisite: cloud-k8s step 6d

The tailnet fronting has to move from the L4 LoadBalancer Service to the
operator's `tailscale`-class Ingress. docs/plans/cloud-k8s.md step 6d
already specifies that change: the body, the ingress peer, the
`installedFronting` record, the publish timeout, and deleting the L4 body
with no shim. It also records the two constraints this plan adds:

- The Ingress is needed for identity, not only for TLS.
- The installing machine must be an untagged device.

6d ships before workstream B, while tokens still guard the server, so it
can be verified on its own. Its "retire these first" list includes the
Step 0.6 check. The fallback, if the operator Ingress stamps no identity,
is a `tailscale serve` sidecar in the server pod. If that is rejected too,
`--tailnet` is deleted and a host-side `tailscale serve` becomes the only
fronting. Neither fallback changes anything below.

Workstream H then removes the `trustProxy: true` that 6d sets for the
interval, together with the rest of `YAAC_TRUST_PROXY`.

### B. Server (`packages/server`)

`src/api/http`:

- `web-auth.ts`: the cookie and bearer machinery goes, and `identify()` is
  added in its place.
  - Delete `cookieOrBearerAuth`, `isCredentialOptional`,
    `isLoopbackOnlyDeployment`, `sessionCookieName`, `SESSION_COOKIE_BASE`
    and `timingSafeStrEqual`.
  - Delete the `getDataDir` import that existed only for the cookie name.
  - Trim `isPublicPath`.
  - Add `identify()`, with the rule above.
- Delete `token-store.ts`.
- `index.ts`: the barrel drops the token store, `isCredentialOptional` and
  `sessionCookieName`, and exports `identify`.
- `auth.ts`: `requestLogger` reads `c.get('principal')`.

`src/api/routes/tokens.ts`: delete.

`src/main/server.ts`:

- `ServerAppDeps` loses `secret` and `tokens`, leaving `buildApp({ buildId,
  isReady })`.
- Delete both `/auth/web-session` handlers and the `setCookie` import.
- Delete `.route('/tokens', …)`.
- Add `.get('/whoami', (c) => c.json(c.get('principal')))` beside `/health`.
- Type the app as `new Hono<{ Variables: { principal: Principal } }>()`. The
  RPC client's `AppType` is unaffected, since Variables do not reach it.

`src/main/server-run.ts`:

- Delete the lock `secret`, the token store, `restoreTokens`/`loadTokens`,
  and the `?token=` start banner, which becomes a bare URL.
- Add the non-loopback-bind refusal (see "Why a Host rule").
- Add the `YAAC_REQUIRE_AUTH` tripwire (see "Upgrade").

`src/main/lifecycle.ts`: `registerLocalServer` becomes
`registerServer(origin, 'containerless', { log })`, with no
`credentialRequired`.

`src/db`:

- Delete `token-store.ts` and its barrel line.
- Delete the `tokens` table from `schema.ts`.
- Generate the migration with `pnpm --filter @yaac/server exec drizzle-kit
  generate --name drop_tokens`.
- `client.ts` keeps its 0700 directory. The comment's reason changes to
  sealed secrets.

### C. Shared (`packages/shared`)

`server-config.ts`:

- `ServerConfig` and `SavedServer` lose `token`. `readServerConfig` stops
  requiring it, so older files still parse and the next write drops the
  field.
- `withServerSelected(existing, url)` loses its token parameter.
- `probeServer(origin)` checks `/health` (reachable, and returns the build
  id), then `/whoami`. A 401 from `/whoami` throws a named
  `IdentityRejectedError` carrying the server's message, which says whether
  the device is tagged or the request was not through serve.
- `registerServer(origin, driver, { log })` shrinks to "select and record
  the driver".
- Delete `TokenRejectedError`, `LOCAL_CLIENT_TOKEN_NAME`,
  `checkSavedToken`, `mintLocalClientToken`, and the `credentialRequired`,
  `probe` and `mint` options.

`server-lock-file.ts`:

- `ServerLock` loses `secret`, and `isServerLock` stops checking it.
- `isLockLive` and `isLockReady` drop the bearer on `/health`, which was
  already public.

`server-api.ts`:

- `ServerTarget` becomes `{ baseUrl }`.
- Delete `withAuth`'s bearer, the whole 401 `BAD_BEARER` re-resolve and retry
  branch, and `peekErrorBody`.
- `resolveServerTarget` reads only `YAAC_SERVER_URL` or `server.json`.
- `NO_SERVER_SELECTED` drops `--token`.
- A 401 now means the identity was refused, so `createServerFetch`
  surfaces the server's message verbatim.

Other shared files:

- `port-tunnel.ts` and `auth-daemon.ts`: drop `secret` and the
  `Authorization` headers.
- `errors.ts`: delete `BAD_BEARER`. Keep `UNAUTHENTICATED`.
- `env.ts`: delete `trustProxy`, `requireAuth` and
  `testEnv.serverSecretOverride`, and reword the `worktreeId` doc, since
  `identify()` is its reader now.
- `mask.ts`: delete `maskToken` once its three callers are gone.
- `@yaac/shared/types`: add `Principal`.

### D. CLI (`packages/cli`)

- Delete the `auth token create|list|revoke` group from `cli.ts`, and delete
  `commands/auth-token.ts`.
- `remote set <url>` loses `--token`. `remote status` loses the token line,
  and `requireConfigured` loses its hint.
- `commands/ws-terminal.ts` and `commands/forward.ts` stop sending headers.

### E. Auth daemon (`packages/auth-daemon`)

- `connection.ts`: `connectAuthAgent({ baseUrl, log })`. The `/agent/auth`
  WebSocket carries no header.
- `run.ts`: drop the masked-token log field and the bearer on its status
  fetch.

The `/agent/auth` socket-hijack issue is untouched. It is a phase-3 fix, a
socket per principal, and removing tokens makes it neither better nor worse.

### F. Desktop (`packages/desktop`)

- Delete `mint.ts`.
- `flow.ts`: `runFlow` probes `/whoami` in place of the mint, keeping its
  role as the reachability check that lands a failure on the picker. It then
  returns the bare origin. Delete `buildWebappUrl` and `FlowDeps.mintToken`.
- `connect-page.ts`, `preload.ts`, `server-switch.ts` and `main.ts`: the add
  form and IPC take a URL only. `probeServer(origin)`.
- `events.ts` and `forwarder.ts`: drop the bearer. `ws` was chosen so the
  bearer header could be sent. Moving to Node's global `WebSocket` is
  possible but optional.
- `README.md`: rewrite the boot, `?token=` and splash sections.

### G. Frontend (`packages/frontend`)

- Delete `components/ConnectSplash.tsx` and `lib/webSession.ts`.
- `App.tsx`: the bootstrap effect becomes `GET /whoami`. The state is
  `checking | ok | unidentified`. `unidentified` renders a short static panel
  carrying the server's message, e.g. "This device reached the server
  through Tailscale but without a user identity (tagged device or Funnel)".
- `components/settings/ServerSettings.tsx` and `lib/desktopServer.ts`: the
  add form is URL-only.
- Optionally, Settings → Server shows "signed in as <login>" from `/whoami`.
  That is one line, and it is the first visible sign of identity.
- Fix the "cookie rides the upgrade" comments in `useEvents.ts` and
  `WorktreeTerminal.tsx`, and the cookie comment in `lib/api.ts`.

### H. k8s install (`packages/server/src/drivers/k8s/install`)

`server-deploy.ts`:

- `RemoteHosting` becomes `{ allowedHosts }`.
- `buildServerEnv` stops passing `YAAC_TRUST_PROXY` and `YAAC_REQUIRE_AUTH`.
- Delete `isLoopbackOnlyInstall`, the "will REQUIRE a credential" note,
  `readPodLock`, and the `credentialRequired`/`mint` plumbing in
  `writeServerRemote`, which becomes `registerServer(origin, 'k8s', { log })`.

`server-fronting.ts`: `remoteHosting()` returns `allowedHosts` only.

### I. Test utilities (`packages/test-utils`)

- `cli.ts`: drop `YAAC_REQUIRE_AUTH: '1'` from `createYaacTestEnv`, and drop
  the "no durable token" assertion after `registerServer`.
- `deployed-server.ts`: `bootstrapRemote` only registers. Drop the durable-
  token comments and the `YAAC_REQUIRE_AUTH` pass-through.
- `server.ts`: `bootInProcessServer` loses `secret`, `tokens` and
  `YAAC_SERVER_SECRET`.
- `api.ts` and `events-ws.ts`: drop the bearer. `collectSnapshots(port)` and
  `firstSnapshot(port)` lose their secret parameter, and every e2e call site
  changes mechanically.
- `vitest-setup.ts`: the strip list loses the two deleted vars. Keep
  stripping `YAAC_WORKTREE_ID`, because `identify()` reads it. Rewrite both
  comment blocks.
- Add an identity helper, `asTailnet(login, host)`. It returns headers
  (`Host`, `X-Forwarded-For`, `Tailscale-User-*`) so that any api or e2e
  test can make a tailnet call against a server whose `YAAC_ALLOWED_HOSTS`
  it stubs.

### J. Skills and Playwright scripts

- `.claude/skills/run-yaac/driver.mjs`: reads the url and runs
  `page.goto(url)`. Update `SKILL.md`.
- `test-playwright-scripts/`: 27 scripts share one shape. They mint with the
  lock secret, go to `?token=…`, then wait for `token=` to leave the URL. Do
  one mechanical sweep that drops all three steps. `lock.secret` will be
  undefined, so leaving them stale means every one of them breaks.

## Tests

The e2e and api suites currently run with a credential required, because
`createYaacTestEnv` forces `YAAC_REQUIRE_AUTH=1`. After the change they run
as local, which matches what real installs do. The tailnet path gets
explicit coverage through `asTailnet`.

**Delete:**

- `test/api/token-auth-flow.test.ts`. First move its 0700 DB-dir assertion
  into the new flow file below.
- `test/api/web-session-flow.test.ts`. First move "admits an extra Host only
  via YAAC_ALLOWED_HOSTS" to the new flow file.
- `packages/server/test/api/http/token-store.test.ts`
- `packages/cli/test/auth-token.test.ts`
- `packages/desktop/test/mint.test.ts`. Keep its build-skew-off assertion,
  moved to wherever the `/whoami` probe lands.
- `packages/frontend/test/web-session.test.ts`
- The `yaac auth token` describe in `test/e2e-containerless/remote-cli.test.ts`
- The token-only cases in:
  - `server-config.test.ts`: mint, reuse, rotate and lockout
  - `server-api.test.ts`: `BAD_BEARER` retry
  - `env.test.ts`: `trustProxy`, `requireAuth` and `serverSecretOverride`
  - `lifecycle.test.ts`: mint-fails
  - `server-deploy.test.ts`: mint via pod lock
  - `remote.test.ts`: bad token and masked token
  - `flow.test.ts` and `connect-page.test.ts`: token field, `?token=` URL

**Rewrite to the identity rule:**

- `packages/server/test/api/http/web-auth.test.ts`: the `cookieOrBearerAuth`
  suite becomes an `identify` suite covering every row of the rule table.
  That is loopback local, tailnet principal, proxied without a user, and
  non-loopback unproxied refused, each under both a top-level server and a
  worktree one. It also covers the public paths and the principal reaching
  `/whoami`. The Host, Origin and fetch-site suites stay as they are.
- `packages/server/test/main/auth-chain.test.ts`: the probe route becomes
  `/whoami`. The `YAAC_REQUIRE_AUTH` block becomes the tailnet-Host cases.
- Tests that used a 401 to prove "this path is gated at all" get a new
  trigger: a non-loopback Host with no identity. The intents are kept.
  - `websocket-compression.test.ts` (compression does not bypass the gate)
  - `worktree-cli.test.ts` (`/events` is gated)
  - `server-http.test.ts` and `server.test.ts` (the API is gated)
- `remote-cli.test.ts`:
  - The `yaac remote` describe drops `--token` and minting.
  - "set rejects a bad token" is deleted. "set reports an unidentified
    device" goes to `packages/cli/test/remote.test.ts` against a mocked
    `/whoami` 401. The e2e tier cannot easily address a test server by a
    non-loopback name, and the refusal itself is covered by `identity-flow`.
- `lifecycle.test.ts` "registers a server…", `server-deploy.test.ts`
  (posture, loopback defaults, tailnet), and `remote.test.ts`: these keep
  their subjects and lose the token assertions. The tailnet case already
  asserts the Ingress after cloud-k8s 6d, and loses only its
  `YAAC_TRUST_PROXY` expectation.
- Every other suite (`auth-daemon`, `worktree-create-suite`,
  `worktree-mama-suite`, `worktree-suite`, `routes-*`) needs mechanical
  header and fixture trims. `worktree-suite`'s mama cases keep their 401s but
  drop the "not the lock secret" comparison.

**Add:**

- `test/api/identity-flow.test.ts` (containerless api project), with
  real-socket cases:
  - A local request is identified as local.
  - `asTailnet` with `YAAC_ALLOWED_HOSTS` stubbed yields the tailnet
    principal.
  - An XFF request with no user gets a 401 carrying the tagged/Funnel
    message.
  - A non-loopback Host with no identity gets a 401.
  - The same four on a WebSocket upgrade.
  - The relocated Host and 0700 assertions.
- `route-matrix.ts`: delete the two `/auth/web-session` rows and the three
  `/tokens` rows. Add `GET /whoami` answering 200 under both drivers.
- `vitest.config.ts`: swap `web-session-flow` for `identity-flow` in
  `CONTAINERLESS_API`, and fix the comment that names `token-auth-flow`.
- `server-run`'s bind refusal and `YAAC_REQUIRE_AUTH` tripwire: cover both
  as cases in `test/e2e-containerless/server-lifecycle.test.ts`, which
  already spawns servers. Add no new file.

Removed CLI surface (`--token`, `auth token *`) loses its e2e tests along
with the code. The only new CLI behavior is the unidentified-device message,
covered above.

## Docs

- `docs/remote-hosting.md`: rewrite it to the two-answer model.
  - Setup drops `YAAC_TRUST_PROXY` and the token mint, and gains the ACL
    step (see "Open decisions").
  - The security model states the identity rule, the nested-server
    relaxation and the browser guards.
  - "Revoke a device" means the admin console.
  - Record the Step 0 answers here.
- `docs/server-selection.md`: "an origin plus a durable token" becomes "an
  origin". Delete the bootstrap-mint half of "The registration" and the
  paragraph on the lock secret. The desktop section loads the origin and
  probes `/whoami`.
- `docs/server-in-cluster.md`: the install and fronting sections change for
  the Ingress, the dropped token and the dropped `YAAC_TRUST_PROXY`. The
  NetworkPolicy's role in authentication is stated.
- `docs/port-forward-tunnel.md`: "the same bearer every other WS carries"
  becomes "the same identity".
- Also update:
  - `packages/desktop/README.md`
  - `README.md`: the remote-hosting section and the `auth token` and
    `remote set` usage
  - `AGENTS.md`: the architecture bullet that says "an origin plus a
    durable token"
  - `docs/plans/cloud-k8s.md` already assumes this plan (6d, 6e). Its
    shipped-state summary line about minting through the pod's lock
    changes when this lands.
- `docs/plans/multi-user-deployment.md`: phase 1 and "Identity terminates in
  `api/http`" are replaced by a pointer to the shipped reference, recording
  the three refinements above. When this ships, delete this plan (its
  current-state material lives in docs/remote-hosting.md).

## Upgrade and compatibility

Nothing here needs a read-time shim:

- An old `server.json` parses, because `token` is simply no longer read.
- Old cookies are ignored.
- Old locks carry an unread `secret`.
- The `tokens` table is dropped by migration.

Two consequences are accepted and named in the release notes:

- An old client against a new server. An old desktop build's `POST /tokens`
  gets a 404 and lands on the picker. An old CLI's bearer is ignored, but
  its `registerServer` mint fails. Both are ordinary build skew: upgrade the
  client.
- A new CLI reading a lock written by an old pod, or the reverse. Only the
  reverse fails, because an old CLI rejects a lock with no `secret`. The CLI
  and the pod are the same bundle except mid-upgrade.

One tripwire is worth adding, and it gets an entry in
`docs/legacy-compat-shims.md`. `YAAC_REQUIRE_AUTH=1` today protects a host
shared with other OS users. Other users can reach its loopback but cannot
read its 0700 data dir. Under the new model loopback is local, and a forged
header gains nothing. That protection is gone, and dropping it silently is
the one silent failure in this change.

So `server run` refuses to start when `YAAC_REQUIRE_AUTH` is set. The error
explains that a multi-OS-user host is not a supported shared deployment:
serve it over the tailnet, and let each person reach it by the ts.net name.

- **What it reads:** the env var.
- **What breaks silently if it goes too early:** such a host starts serving
  other OS users with no gate.
- **Safe to remove:** a release or two after this ships.

`YAAC_TRUST_PROXY` is not given a tripwire. Leaving it set is harmless.

## Sequencing

1. **Step 0** verification (no code).
2. **PR 1: cloud-k8s step 6d.** The tailnet fronting moves to the L7
   Ingress with tokens still in place. Run the k8s install tests and the
   step-4 tailnet gate over `https://`.
3. **PR 2, workstreams B–J** plus tests and docs, as one change. The client
   and server halves cannot land apart: a new CLI's `registerServer` no
   longer mints, and an old server would require the mint. Suggested
   commit order, each commit green on `pnpm lint` and the unit projects:
   1. Shared: types, `server-config`, `server-api`, lock.
   2. Server: `identify`, `/whoami`, deletions, migration.
   3. k8s install.
   4. CLI, auth daemon, desktop, frontend.
   5. Test utilities and test rewrites.
   6. Docs, skills, Playwright sweep.

   Run the containerless api, `unit:*` and e2e-containerless projects in
   the worktree. The k8s api column, `test/e2e` and `test/e2e-cli` are
   host-only and must be run there before merge, because every fixture
   changes.
4. **Then cloud-k8s step 6e (`--byo`).** It builds on the identity model
   instead of minting a token, and its `byo-install-suite` asserts
   `/whoami` rather than a `Secure` cookie. 6a–6c are independent of this
   plan and can land at any point.
5. **Follow-up: `whois`.** hostPath-mount the tailscaled socket into the
   server Deployment, or use the host's socket for a host server. Resolve
   the XFF address to a node and user. This admits tagged devices as node
   principals, and it is what "revoke a device" rests on in phase 3. Until
   it lands, tagged devices are refused. That includes the machine running
   a `--tailnet` install, and the client of the kind-byo test rig (see
   cloud-k8s 6d and 6e).

## Open decisions

- **Who on the tailnet may use the server.** Today a token holder is the
  only one who gets in. After this change, anyone who can reach the device
  through serve is a full-access principal. That is the trust model the
  multi-user doc chose ("the trust boundary is the tailnet").
  - On a shared company tailnet it means one ACL grant restricting the
    server's device or tag to the intended users.
  - The recommended answer is to document that grant as a required setup
    step and add no server-side allowlist. Phase 3's `users` table is where
    membership becomes explicit.
  - The alternative is a `YAAC_TAILNET_USERS` allowlist, about ten lines,
    which makes the single-user posture independent of ACL hygiene.
- **The tailnet fronting's fallback** if the operator Ingress sends no
  identity headers: a serve sidecar, or deleting `--tailnet` (workstream A,
  cloud-k8s 6d).
- **The `YAAC_REQUIRE_AUTH` tripwire: refuse or warn.** This plan
  recommends refusing, because the setting was an explicit request for a
  gate.

## Not in this plan

The following are phases 2–4 of the multi-user doc:

- `domain/access` and `authorize`, and principals flowing into domain verbs
- Owners on rows and per-user credentials
- The `/agent/auth` per-principal socket
- The `act` gating of the attach upgrades

This phase leaves every principal with full access. It changes how a caller
is recognized, not what a caller may do.
