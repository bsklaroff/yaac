# Agent notifications on the desktop app and iPhone

## Goal

Let an agent tell its user something when they may not be watching: a long
run finished, a result they asked about is ready, it needs them. Each
notification shows both on the yaac desktop app and on the user's iPhone.

Decisions (confirmed with the user):

- **Only `yaac-mama` sends them**, for now: `yaac-mama notify [--title T]
  "<message>"`. The server sends none of its own.
- **Every notification goes to both** the desktop app and the phone.
- **One switch, Settings → General → Notifications**, turns them on or off
  for the user. It replaces the Sounds switch, and the waiting chime goes
  with it.
- Since only `yaac-mama` sends notifications, the desktop shell's automatic
  "workspace waiting" notifications go too. Its dock badge (the count of
  waiting workspaces) stays.
- **Phones are reached through a push relay** that holds the APNs key, run
  as a yaac public site on the maintainers' always-on cluster. The relay is
  open to any caller that has a device token (the trust model is below);
  binding tokens to servers is deferred.

## How it fits together

```
yaac-mama notify ─► server (domain/notifications)
                      ├─► /api/events "notification" frame ─► desktop shell ─► OS notification
                      └─► POST <relay>/v1/push, once per phone ─► push relay ─► APNs ─► iPhone
iPhone app ─► PUT /api/config/push-device (on connect) ─► push_devices row
```

The notification goes to the owner of the calling workspace's project, the
same user `workspacePrincipal` acts for.

## 1. `yaac-mama notify`

**Script** (`workspace-bin/yaac-mama`): a `notify` case taking an optional
`--title <title>` and exactly one non-empty message; it calls `run notify
"$1" title "$title"` (an empty title is dropped by `run`). Add it to the
header comment, the usage text and the unknown-command list.

**Server** (`domain/workspaces/mama.ts`):

- Add `'notify'` to `MAMA_COMMANDS` (`@yaac/shared/types`, with a sentence
  in its comment) and `notify: ['title']` to `COMMAND_ARGS`.
- `runNotify`: trim the body; refuse an empty one (`notify needs a
  message`) and one over 1000 characters, which keeps the APNs payload well
  under its 4 KB limit. The title is `normalizeTitle(--title)`, else
  `<project name> · <workspace title, else generated title, else short
  id>`, so the user can tell which workspace is asking. Read the project
  row for its name and owner rather than `caller.principal.userId`, since
  `Actor` includes `system`, which has no user.
- Output: `Notification sent.`, plus one `A phone could not be reached:
  <reason>` line per failed phone. When the user has notifications off:
  `Not sent: the user has turned notifications off in their settings.`,
  with exit 0, so an agent does not retry.

**Skill** (`builtin-skills/yaac-mama/SKILL.md`): the usage line, a bullet
saying when to use it (the user asked to be told, or the agent needs them
and they may not be watching; not for routine progress), the 1000-character
cap, and that a user may have them off. Add "notify/alert/ping the user" to
the description's triggers.

## 2. The setting

- **Storage**: a `notifications` key in the `preferences` table, `'0'` for
  off; absent means on. `getNotificationsEnabled(owner)` and
  `setNotificationsEnabled(owner, enabled)` in `db/preferences.ts`, on the
  `#db` barrel.
- **Routes** on `configApp`: `GET /api/config/notifications` answers
  `{ enabled, phonePush }`, where `phonePush` says whether this server has
  a push relay configured. `PUT` takes `{ enabled }`. Both are owner,
  caller-scoped, 200 under both drivers in `test/api/route-matrix.ts`.
- **Webapp**: a `NotificationsField` in Settings → General in place of the
  Sounds field: a switch backed by the two routes (React Query, key
  `['notifications']`). Its hint says agents can notify you on the desktop
  app and iPhone, plus "This server has no push relay, so only the desktop
  app gets them" when `phonePush` is false.
- **Remove the chime**: the waiting effect in `App.tsx`, `lib/sound.ts`
  and its test, `soundEnabled`/`setSoundEnabled` and the `yaac.sound.v1`
  entry in the store's persisted table (and its row in `persist.test.ts`),
  and the `cuelume` dependency (`pnpm --filter @yaac/frontend remove
  cuelume`). The leftover `yaac.sound.v1` localStorage key is harmless and
  needs no cleanup.
- `@yaac/shared/waiting` (`newlyWaiting`, `waitingKeys`) then has no
  callers; delete it and its test. Unread state still uses
  `waitingSinceMs`, so that stays; fix the comments in
  `runtime/agents/acp-client.ts` and `runtime/status/status-store.ts` that
  mention the chime or desktop notifications.
- `test-playwright-scripts/frontend-simplify-test.js` toggles the Sounds
  switch; point its step 3 at another persisted preference.

## 3. Desktop delivery

**Server push channel.** `#lib/notify` stays the outbound channel, so add a
second listener beside the snapshot signal:
`onUserNotification(fn)` and `sendUserNotification(owner, notification)`.
Unlike the snapshot signal it carries content, since a notification is not
state a client could read back. `server-run.ts` wires it to the hub.

**Hub** (`api/events.ts`): `EventHub` keeps a `Map<WsLike, userId>` instead
of a set; `add(ws, userId)` takes the user, which `ws-routes.ts` reads from
the request's principal when the `/api/events` socket upgrades. A new
`notify(owner, notification)` sends one frame to that user's connections
only. Snapshots still go to everyone.

**Wire type** (`@yaac/shared/types`): `UserNotification { title, body,
projectId, workspaceId }`, and `ServerEvent` gains `{ type: 'notification';
data: UserNotification }`.

**Clients of `/api/events`:**

- `@yaac/shared/events` (`startEventsMonitor`): parse any well-formed frame
  and dispatch by type; add an optional `onNotification` callback.
  `yaac forward` passes none.
- **Desktop shell** (`packages/desktop/src/main.ts`): `onNotification` shows
  an Electron `Notification({ title, body })`; clicking it calls
  `showWindow()`. Delete `AttentionMonitor` and `notificationFor`;
  `attention.ts` shrinks to `badgeText(snapshot)`, the waiting count. Drop
  the window's `autoplayPolicy: 'no-user-gesture-required'`, which existed
  only for the chime.
- **Webapp** (`lib/useEvents.ts`): today it treats every frame as a
  snapshot, so it must check `type === 'snapshot'` and ignore the rest. A
  plain browser tab therefore shows nothing (see open questions).

## 4. iPhone registration

**Rows.** A `push_devices` table: `token` (text, primary key), `owner`
(uuid, references users), `topic` (the app's bundle id), `sandbox`
(boolean: signed for APNs' development environment), indexed by owner.
Generate the migration after the newest one on main with `drizzle-kit
generate --name add_push_devices`. `db/preferences.ts` gets
`savePushDevice(owner, device)` (upsert on token: a token is one app
install on one phone, so registering it again moves it to whoever
registered last), `listPushDevices(owner)` and `deletePushDevice(token)`.

**Route.** `PUT /api/config/push-device` with `{ token: hex 32–200 chars,
topic: [A-Za-z0-9.-]{1,155}, sandbox }`, owner, caller-scoped, 200 under
both drivers in the route matrix. It has no delete: a stale token is
pruned when APNs reports it gone.

**App** (`ios/`):

- `Yaac/Notifications.swift`:
  - an `AppDelegate`, attached with `@UIApplicationDelegateAdaptor`, that
    sets itself as the `UNUserNotificationCenter` delegate, hands the
    device token (hex) to `Push`, ignores a registration failure (the
    Simulator, or a build without the entitlement), and presents a
    notification that arrives while the app is open as a banner with sound;
  - a `@MainActor` `Push` singleton: `register(with: origin)` asks for
    `.alert` and `.sound` permission (iOS prompts once), then sends the
    token if it has one, else queues the origin and calls
    `registerForRemoteNotifications()`; when the token arrives it is sent
    to every queued origin. Sending is a best-effort `PUT` through
    `ServerStore.probeSession` with `topic: Bundle.main.bundleIdentifier`
    and `sandbox` from `#if DEBUG`.
- `YaacApp.swift`: `.task(id: store.connected)` calls `Push.shared.register`
  for each server connected to. This keeps `ServerStore` free of push code,
  so `YaacTests` is unaffected. A server keeps the token, so the phone goes
  on getting a server's notifications after switching to another.
- `ios/Yaac.entitlements` with `aps-environment` = `development`, named by
  `CODE_SIGN_ENTITLEMENTS` in `Yaac.xcconfig`. It sits outside the
  synchronized `Yaac/` folder so it is not bundled as a resource.
- **Signing.** Enable Push Notifications on the App ID and regenerate the
  `yaac App Store` profile that Release signs with, or Release builds fail.
  A free Apple ID's personal team cannot sign push at all, and the iPhone
  setup guide supports such builds, so the README must say to set
  `CODE_SIGN_ENTITLEMENTS` empty for them; the app then runs without
  notifications. A build under another bundle id gets none either, since
  the relay serves only yaac's.

## 5. Server to relay

`#domain/notifications`, a new sealed folder (`index.ts` barrel, a
`#domain/notifications` imports entry, and `notifications` added to
`SEALED_FOLDERS` in `eslint.config.js`), exporting:

- `sendNotification(owner, notification)` → `{ off: true } | { off: false;
  failures: string[] }`. If the user has notifications off it returns `off`
  and sends nothing anywhere. Otherwise it calls `sendUserNotification`,
  then POSTs one push per registered device to the relay in parallel. A
  result with `gone` deletes the device; every failure is logged with the
  first 8 characters of the token and returned as a reason.
- `phonePushConfigured()`: whether `YAAC_PUSH_RELAY_URL` is set and parses.

The relay call uses `fetch` with `redirect: 'error'` (as feedback does: the
configured relay is the only place a notification may go) and a 15 s
timeout. A non-2xx answer becomes `the push relay answered HTTP <n>:
<error>`; no relay configured becomes `this server has no push relay
(YAAC_PUSH_RELAY_URL)`.

**Contract** (`@yaac/shared/push-relay`, used by both sides):
`PUSH_RELAY_PATH = '/v1/push'`; a zod `pushRequestSchema` (`token`,
`topic`, `sandbox`, `title` 1–200, `body` 1–1000, `data`: at most 8 string
entries, keys ≤ 64 and values ≤ 200 characters, carrying `projectId` and
`workspaceId`); `PushResult = { ok: true } | { ok: false; gone: boolean;
reason: string }`. The relay answers 200 with a `PushResult` once APNs has,
400 for a malformed request, 403 for a topic it does not serve, 429 over a
rate.

**Configuration.** `env.pushRelayUrl` (`YAAC_PUSH_RELAY_URL`, an origin) in
`packages/shared/src/env.ts`. `buildServerEnv` in `server-deploy.ts`
passes it through to the cluster's server pod, as install does for other
operator settings. Unset, only the desktop app gets notifications.

## 6. The push relay

APNs accepts pushes to an app only from its developer team's key, and the
key cannot go to every install. So one relay holds it and every yaac server
sends through it.

**Package** `packages/push-relay` (`@yaac/push-relay`, private; depends on
`@yaac/shared` and `tsx`; `start` runs `tsx src/main.ts`). Add it to the
eslint zone that limits server and auth-daemon to `@yaac/shared`, a
`unitProject('packages/push-relay')` in `vitest.config.ts`, and a row in
CLAUDE.md's package table. `process.env` is read only through
`@yaac/shared/env`.

- `src/apns.ts`: the APNs client. One HTTP/2 session per push
  (`node:http2`) to `https://api.push.apple.com`, or
  `api.sandbox.push.apple.com` when `sandbox`, POST `/3/device/<token>`
  with `apns-topic`, `apns-push-type: alert`, `apns-priority: 10` and a
  provider token: an ES256 JWT (`{ alg: ES256, kid }`, `{ iss: teamId, iat
  }`) signed with `crypto.sign('sha256', …, { dsaEncoding: 'ieee-p1363'
  })` and reused for 50 minutes, since APNs refuses tokens older than an
  hour and refreshed more often than every 20 minutes. The payload is
  `{ aps: { alert: { title, body }, sound: 'default' }, ...data }`. A 410,
  or the reason `BadDeviceToken`, `DeviceTokenNotForTopic` or
  `Unregistered`, is `gone`. A 10 s session timeout; it never throws.
- `src/relay.ts`: `createRelay(key)` returns an unbound `http.Server`.
  `GET /health` answers 200; `POST /v1/push` reads at most 16 KB, validates
  with the shared schema, refuses any topic but `com.bsklaroff.yaac.ios`
  (403), applies the rate limits, pushes and answers the result. It
  identifies the caller by `CF-Connecting-IP`, which Cloudflare sets and a
  client cannot forge, since a site's traffic arrives only through the
  tunnel. It logs failures with a token prefix and never logs or stores the
  title or body.
- `src/main.ts`: reads `YAAC_APNS_KEY` (the `.p8` PEM), `YAAC_APNS_KEY_ID`
  and `YAAC_APNS_TEAM_ID` (`env.apnsKey`, undefined unless all three are
  set), exits 1 without them or if the key does not parse, and listens on
  8080. Refusing to start makes a deploy without the key fail instead of
  going live.
- `workflow.json`: the step graph a release runs: `install` (`pnpm install
  --frozen-lockfile --filter @yaac/push-relay...`), then the `relay`
  service (`pnpm --filter @yaac/push-relay start`, ready when `curl -sf
  http://127.0.0.1:8080/health` passes).
- `testEnv.apnsOrigin` (`YAAC_TEST_APNS_ORIGIN`) points the client at a
  test's own plain-text HTTP/2 server instead of Apple's.

**Limits.** Fixed one-minute windows: 120 pushes per caller, 20 per device.

### Trust model

Nothing authenticates a server to the relay. A device token is what lets a
caller reach a phone; it is 32 random bytes, so it cannot be guessed, and
the phone gives it only to servers it connects to. So:

- Anyone holding a yaac phone's token (the operator of a server that phone
  connected to, or anyone with a copy of that server's database) can have
  the relay send that phone notifications with any text, up to 20 a
  minute, indefinitely. Removing the server from the app does not revoke
  the token.
- Nobody can reach a phone without the yaac app, or another app's users:
  APNs rejects a token that does not belong to the push's topic, and the
  relay serves only yaac's topic, which also keeps the key from pushing to
  the team's other apps. Nobody else can sign an app under yaac's bundle
  id to collect tokens.
- Every push is signed with the maintainers' key, so abuse through the
  relay reads as the maintainers' to Apple. A notification can only show
  text and open the app.

The user accepted this for now. Paseo makes the same trade by sending
through Expo's push service.

**Deferred: binding tokens to servers** (Orca's design). Each server gets
its own key pair; the phone registers its token with the relay bound to
that server's public key and gives the server only a relay-issued handle;
each push carries the server's signature; the phone can unbind a server.
That makes a leaked token useless elsewhere, at the cost of a relay
database and a registration call from the app. The server's call to the
relay would change shape but nothing else in this plan would.

### Deploying it

On the always-on cluster, as a site of this repo's own project, using
workflows and run secrets (docs/workflows.md):

1. In the Apple developer portal, create a key with the Apple Push
   Notifications service enabled and note its key id and team id. One key
   serves both APNs environments.
2. `yaac config env yaac YAAC_APNS_KEY --run-secret < AuthKey_<id>.p8`,
   and `yaac config env yaac YAAC_APNS_KEY_ID=<id> YAAC_APNS_TEAM_ID=<team>`
   as plain variables.
3. Add `api.push.apple.com` and `api.sandbox.push.apple.com` to the
   project's egress allowlist. No secret rule names them, so the proxy
   tunnels them untouched. That matters: APNs needs HTTP/2, and the
   proxy's MITM path (`k8s/proxy/mitm.ts`) does not appear to support it.
4. `yaac workflow create yaac push-relay --file
   packages/push-relay/workflow.json --secret YAAC_APNS_KEY`, then `yaac
   site create yaac push --hostname <host> --port 8080 --workflow
   push-relay`, route the hostname in the Cloudflare tunnel, and `yaac site
   deploy yaac push --wait`. A deploy approves the commit it runs. Do not
   set the site to follow a branch: that approves the branch, giving the
   key to whoever can push it, the project's agents included.
5. Start servers with `YAAC_PUSH_RELAY_URL=https://<host>`, or make it the
   default (see open questions).

## 7. Tests

- `packages/server/test/domain/workspaces/mama.test.ts`, a `notify`
  describe: delivered to the owner with the default and a given title;
  nothing sent and `Not sent:` when off; empty and overlong messages
  refused. Capture deliveries with `onUserNotification`.
- `packages/server/test/domain/notifications/send.test.ts`, against a
  stand-in relay on a real `http` listener (the process boundary):
  delivery to connections and every phone, a gone phone deleted and a
  refused one kept with its reason; a server with no relay reporting it per
  phone while the desktop still gets it; nothing anywhere when off;
  `phonePushConfigured` needing a URL that parses.
- `packages/server/test/db/preferences.test.ts`: one describe per new
  function.
- `packages/server/test/api/events.test.ts`: a notification reaches only
  its user's connections; update `hub.add` calls for the user argument.
- `packages/server/test/drivers/k8s/install/server-deploy.test.ts`:
  `YAAC_PUSH_RELAY_URL` reaches the pod.
- `packages/push-relay/test/relay.test.ts`, against a stand-in APNs on a
  real HTTP/2 listener that verifies each JWT with the key's public half:
  a push and a gone answer; other topics, malformed bodies, unknown paths
  refused and `/health` up; both rate limits.
- `packages/shared/test/events.test.ts`: notification frames reach
  `onNotification`, malformed or unknown ones are dropped.
- `packages/desktop/test/attention.test.ts`: `badgeText` only.
- `packages/frontend/test/settings-general.test.tsx`: the switch saves
  through the route and shows the no-relay hint.
- `test/api/route-matrix.ts`: the three new rows.
- e2e: in `test/e2e-containerless/workspace-suite.test.ts`, after the
  rename case, open `/api/events` (extend `collectSnapshots` in
  `@yaac/test-utils/events-ws` to also collect notifications), run
  `yaac-mama notify` and expect the frame; turn the setting off and expect
  `Not sent:`; a bare `notify` exits 2. A matching case in
  `test/e2e-cli/workspace-mama-suite.test.ts` covers the k8s relay path
  (host-only).

Still to verify by hand: the iPhone build (prompt, token registration,
background and foreground delivery, the switch), an archive's
`aps-environment`, the desktop notification and click, and a real site
deploy of the relay (the filtered install inside a release, and `curl` in
the project image).

## 8. Docs when it ships

- New `docs/notifications.md`: the sources, the two channels, the setting,
  the relay, its trust model and how to deploy it. Delete this plan.
- `packages/desktop/README.md` ("Attention signals" and the manual
  checks), `ios/README.md` (files table, a Notifications section replacing
  the "does not do" entry, signing and TestFlight steps, the free Apple ID
  caveat, the setup guide's first connect, manual checks).
- `docs/sessions.md`, `docs/agent-modes.md`: drop mentions of the chime and
  of desktop notifications keyed on waiting spells.
- `docs/multi-user.md`: a `yaac-mama notify` reaches only the project's
  owner.
- `docs/layered-server.md`: the second channel on `#lib/notify`.
- `docs/environment-variables.md`: `YAAC_PUSH_RELAY_URL`.

## Open questions

- **A default relay URL.** Feedback now defaults to `yaac.dev`. Giving the
  relay a hostname there (say `push.yaac.dev`) and making it the default
  would give other installs phone notifications with no setup; it could
  reuse feedback's rule of keeping the value a server was last started with.
- **`aps-environment` on archive.** Release signs manually with the App
  Store profile while the entitlements file says `development`; Xcode
  should sign it as `production`. Check on the first archive.
- **Debug or not** is decided by `#if DEBUG`. A Release build run from Xcode
  with development signing would register as production and get nothing.
- **Tapping a notification** only opens the app. The payload carries
  `projectId` and `workspaceId`, so opening that workspace is a small
  follow-up on both the desktop and the phone.
- **Browser tabs** show nothing. The Web Notifications API could cover a
  desktop browser later, but the desktop shell would then need to stop the
  page it hosts from showing a second copy.
- **Privacy.** The relay sees every notification's text in transit. A
  Notification Service Extension could decrypt payloads on the phone if
  that matters.
- **Containerless.** An agent there reaches the API as the user, so it
  could turn the setting back on. That matches what it can already do to
  every other setting there.
