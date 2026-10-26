# Accounts: invited users with email and password

Today a remote yaac server admits only tailnet users (docs/remote-hosting.md).
This plan adds an `accounts` access mode. In it, the install's owner can
invite people by email. They sign in with an email and password, from a
browser, the CLI, the desktop app or the iOS app, and need no Tailscale.
Tailnet users keep working exactly as they do now.

Authentication runs inside the yaac server, using better-auth. The server
already pins better-auth for its encryption helpers. There is no separate
identity provider or auth proxy.

The server is fronted by either `tailscale serve` or `tailscale funnel`, and
both are equally valid. yaac runs the same behind either:

- **`serve`:** only tailnet devices can reach the server, so in practice no
  account user gets in. That is fine for an install that wants none.
- **`funnel`:** the same `srv.<tailnet>.ts.net` name is also published on
  the public internet, on 443, with no inbound port, and TLS still ends on
  the server's machine.

Switching between them is a `tailscale` command; nothing in yaac changes.

## Goals and non-goals

Goals:

- Invited users can use every client, including every WebSocket: terminal,
  chat, forwards and the auth relay.
  - Browser, desktop app and iOS app: sign in on the server's own login page.
  - CLI: sign in with a device code.
- Only the install's owner can invite, list and remove account users.
- Accepting an invite proves the email address. Password reset and email
  change are verified by email too.
- Passwords follow NIST SP 800-63B-4 (see "Password policy"): at least 8
  characters, no composition rules, and screened against common and easily
  guessed passwords offline. Screening against known breaches
  (`haveIBeenPwned`) is on by default, and the owner can turn it off.
- Mail goes out through any SMTP server. Gmail with an app password is the
  documented easy path.
- Everything is on 443 at the server's existing origin, so tailnet users'
  registrations keep working.

Non-goals for v1:

- Open signup. Users are invited, and are trusted teammates as tailnet users
  are today (docs/multi-user.md "Trust model").
- Passkeys, two-factor, and Google or GitHub sign-in. All are better-auth
  plugins and can be added later without changing the mode.
- A custom domain. Funnel only serves `*.ts.net` names (see "Later").

## How a request flows

```
tailnet device ── WireGuard ─────────────┐
public client ── Funnel relay (funnel) ──┤
                                         ▼
          srv.<tailnet>.ts.net:443  (tailscale serve or funnel, on the server machine)
              strips client Tailscale-* headers, overwrites X-Forwarded-For;
              tailnet peer → Tailscale-User-Login; Funnel → Tailscale-Funnel-Request: ?1
                                         ▼
                              yaac 127.0.0.1:8787
   identify(): Tailscale-User-Login (no Funnel marker) → tailnet user (unchanged)
               otherwise a better-auth session (cookie, or bearer) → account user
               otherwise 401
```

`tailscale serve` (`ipn/ipnlocal/serve.go`, `addTailscaleIdentityHeaders`)
deletes client-supplied `Tailscale-User-*` and `Tailscale-Funnel-Request`
headers on every request it forwards. It then sets `Tailscale-Funnel-Request:
?1`, and no user, for Funnel traffic, and the user's identity for a tailnet
peer. So a public client cannot pose as a tailnet user. A tailnet device
still reaches the node directly over WireGuard; Funnel's relays carry only
public clients.

## The `accounts` access mode

### Mode and transitions

- `AccessMode` (`@yaac/shared/types`) gains `'accounts'`. It admits tailnet
  callers exactly as `tailnet` does, and adds account users.
- `yaac server start --tailnet <host> --accounts` and `yaac cluster install
  --tailnet --accounts` ask for it. `--accounts` without `--tailnet` is
  refused, because the owner and the origin both come from the tailnet.
- **The owner** is the built-in user (`BUILT_IN_USER_ID`), the row `--owner
  <login>` gives a tailnet login (`recordAccessMode`). The mode needs that
  row to have a login, since otherwise nobody could invite.
- Transitions, in `settleAccessMode` (`#main/access-mode`):
  - `local` → `accounts` needs `--owner`, as `local` → `tailnet` does.
  - `tailnet` → `accounts` needs `--owner` only if the built-in user has no
    login yet.
  - `accounts` → `tailnet` is allowed, since it only narrows who gets in.
    Account rows and data stay, and their sign-in is refused until the mode
    returns.
  - `accounts` → `local` is refused, as `tailnet` → `local` is.
  - A server nested in a workspace refuses `accounts`, as it refuses
    `tailnet`.

### Moving the credentials API off `/api/auth`

better-auth takes the whole `/api/auth/*` prefix, in every mode, so the
existing API there moves first, in its own change. That API covers tool
sign-in, tool installs, git credentials and plan usage (`routes/auth.ts`,
mounted with `.route('/auth', authApp)` in `#main/server`). It moves to
**`/api/credentials`**, a name that covers everything it does and reads
cleanly in the typed client (`api.credentials.list.$get()`):

- `routes/auth.ts` becomes `routes/credentials.ts`, and `authApp` becomes
  `credentialsApp`. The paths under the prefix are unchanged:
  `/credentials/list`, `/credentials/:tool/login/start`,
  `PUT /credentials/:tool`, `/credentials/git/credentials`, and so on.
- About 23 typed-client call sites follow, and `tsc` finds every one:
  - in the webapp: `useAuthList`, `Credentials`, `GitCredentials`,
    `GitCredentialPicker`, `UsageBadge`;
  - in the CLI: `auth-list`, `auth-update`, `auth-clear`, `project-add`;
  - in the auth daemon: `tool-login`.
- Comments naming `PUT /auth/:tool` follow too, in `@yaac/shared` (types,
  `tool-auth-interactive`) and the auth daemon (`run`, `tool-login`).
- Tests and docs follow: the rows in `test/api/route-matrix.ts`,
  `write-routes.test.ts`, the e2e files that call them, and the mentions in
  `docs/remote-hosting.md` and `docs/multi-user.md` ("`/auth/*` and the
  `/agent/auth` socket").
- Unchanged:
  - the `/api/agent/auth` WebSocket, which is outside the prefix;
  - the `#domain/auth` module;
  - the CLI's `yaac auth …` commands, which are command names, not URLs.

The webapp is always served by the server it calls, so it never skews. A CLI
or desktop app (whose bundled auth daemon calls `PUT /credentials/:tool`)
older than the server gets 404 from its credential calls until upgraded. The
build-skew warning already says to upgrade. There is no alias for the old
paths: in `accounts` mode better-auth owns them, and an alias in the other
modes would be a compat shim for one release.

### better-auth inside the server

A new module, `api/http/accounts.ts`, builds one `betterAuth()` instance at
startup in `accounts` mode. Other modes build none, and `/api/auth/*`
answers `NOT_SUPPORTED`.

| Setting | Value | Why |
|---|---|---|
| `basePath` | `/api/auth` | better-auth's default; the credentials API moves out of the way (below) |
| `baseURL` / `trustedOrigins` | `https://<the --tailnet host>` | better-auth's own Origin check, on top of yaac's |
| `secret` / `secrets` | `secretConfig()` from `#db` | the install's existing key, already in better-auth's format |
| `database` | the Drizzle adapter over yaac's PGlite handle (`provider: 'pg'`) | one database; migrations by `drizzle-kit` as usual |
| `emailAndPassword` | `enabled: true`, `disableSignUp: true`, `minPasswordLength: 8`, `requireEmailVerification: true`, `sendResetPassword` | invite-only; reset by email |
| `emailVerification` | `sendVerificationEmail`, used for email changes | |
| `user.changeEmail` | enabled, verified by email | |
| `session` | better-auth's defaults (a session lasts 7 days and is extended, at most once a day, while in use), with no cookie cache | a deleted session is refused on its very next request |
| `rateLimit` | `enabled: true` (its default is production only), `storage: 'database'`, tighter `customRules` for sign-in, reset requests and device-token polling | the login form is public under `funnel`; limits survive restarts |
| `advanced.ipAddress.ipAddressHeaders` | `['x-forwarded-for']` | `serve` writes it, so it is the client's real address |
| `advanced.useSecureCookies` | `true` | `__Secure-` cookies, `HttpOnly`, `SameSite=Lax` |
| plugins | yaac's `passwordPolicy()`, `haveIBeenPwned({ enabled })`, `bearer()`, `deviceAuthorization({ verificationUri: '/device', validateClient: (id) => id === 'yaac-cli' })` | password screening; the breach check (on unless the owner turns it off); CLI tokens; CLI sign-in (its `/device/token` returns the session token as `access_token`, which `bearer()` accepts) |

Details:

- **Mounting.** The handler is mounted at `/api/auth/*`.
  `isPublicPath` lets that prefix through identification, since sign-in has
  to work before identity exists. yaac's Host, Origin and Sec-Fetch-Site
  guards still run first.
- **Tables.** better-auth's tables get `auth_` names (`user.modelName` and
  so on) so they never collide with yaac's `users`: `auth_user`,
  `auth_session`, `auth_account`, `auth_verification`, `auth_rate_limit`
  and the device-code table. Their Drizzle definitions are generated once
  by better-auth's CLI into an internal `#db` module. The migration is
  `drizzle-kit generate --name add_accounts`.
- **Version.** The catalog pins better-auth 1.7.6, which is past the 1.6.11
  fix for CVE-2026-45337 in `deviceAuthorization`. Upgrades follow
  better-auth's security advisories promptly, since its endpoints face the
  internet under `funnel`.

### Password policy

The rules follow NIST SP 800-63B-4, the current US standard that most
password policies cite:

- **Length.** At least 8 characters (`minPasswordLength: 8`) and at most
  128 (better-auth's default). Spaces and any Unicode are allowed, and
  nothing is truncated.
- **No composition rules.** No required digits, symbols or mixed case, and
  no forced rotation. NIST forbids both: they push users toward predictable
  patterns without making passwords harder to guess.
- **Screening, always on and offline.** NIST requires checking a new
  password against a blocklist of commonly used, expected or compromised
  values. yaac does this with **zxcvbn-ts** (`@zxcvbn-ts/core` with the
  `language-common` and `language-en` dictionaries), the maintained
  TypeScript port of Dropbox's zxcvbn. It estimates how many guesses a
  cracker needs by matching against:
  - dictionaries of common passwords, names and words;
  - keyboard walks, repeats, sequences, dates and l33t substitutions.

  The user's email, name and the server's hostname are passed as extra words,
  so "yaac-srv-2026" scores as weak as it is. A password scoring below 3 (of
  0–4) is refused, with zxcvbn's own feedback ("add another word or two",
  "avoid dates") in the error. Nothing leaves the server.
- **Breach screening, on by default.** `haveIBeenPwned` checks against
  hundreds of millions of leaked passwords. It sends only the first five
  characters of the password's SHA-1 hash to `api.pwnedpasswords.com`.
  - **It fails closed:** while that API cannot be reached, no password can
    be set or reset.
  - **The owner can turn it off,** in Settings → Users ("Also check new
    passwords against known breaches"), for an install whose server has no
    outbound internet.
  - **The refusal names the cause:** "couldn't reach the breach-check
    service; try again, or ask the owner to turn the check off".
  - **The setting is read live.** The plugin reads its `enabled` option on
    each call, so yaac passes a getter over the setting and the instance
    need not be rebuilt.

`passwordPolicy()` is a small yaac better-auth plugin. Its `hooks.before`
runs the zxcvbn check on `/change-password` and `/reset-password`. The invite
accept route calls the same check, and `isPasswordCompromised` when breach
screening is on, since that route is not one of better-auth's own.
zxcvbn-ts runs only on the server: the webapp shows the server's feedback on
submit rather than shipping several megabytes of dictionaries. Its packages
are pinned once in the catalog and listed in both `packages/server` and the
root manifest, as nodemailer is.

NIST SP 800-63B-4 asks for 15 characters when a password is the only
factor, and allows 8 when it is one of two. yaac's 8 is the two-factor
minimum, kept on purpose for single-factor accounts too: a longer minimum
mostly yields padded, predictable passwords. Until two-factor lands (see
"Later"), the zxcvbn score is what keeps short passwords strong.

### Sign-in lockout

Per-IP rate limits do not stop guesses at one account spread over many
addresses, so failed password sign-ins are also counted per account.
better-auth has no lockout for password sign-in, so it is part of
`passwordPolicy()`:

- **Counting.** A `sign_in_failures` row per normalized email holds the
  consecutive failures and a `lockedUntil` time. The plugin's
  `hooks.before` on `/sign-in/email` refuses while the account is locked.
  Its `hooks.after` counts a failure, and a success clears the row.
- **Unknown addresses are counted and refused the same way,** with the
  same error, so the lockout cannot be used to learn which addresses have
  accounts.
- **Temporary, not permanent.** After 10 consecutive failures, sign-in is
  refused for 1 minute. Each further failure while locked out doubles the
  wait, up to 1 hour. NIST SP 800-63B-4 asks for at most 100 consecutive
  failures per account, and warns that hard lockouts let anyone lock a user
  out on purpose.
- **The real user always has a way in.**
  - A password reset by email clears the lockout.
  - The lockout covers only password sign-in: a session the user already
    holds keeps working, and so does tailnet access for a linked user.
- **The lock does not leak.** The error says "too many failed attempts, try
  again later or reset your password", without saying how long.

### yaac users and principals

- `users` gains `authUserId` (text, unique, nullable): the better-auth user
  this row belongs to. A row has a `login` (tailnet), an `authUserId`
  (account), or both. Only the built-in user of a `local` install has
  neither.
- **One person, one user.** A tailnet login and an account whose verified
  email is the same address, compared case-insensitively, are the same
  yaac user: one row, the same projects, credentials and settings, however
  they reach the server. The `Principal` still says which way the request
  came (`tailnet` or `account`), and ownership checks compare `userId`, so
  every check holds unchanged.
- **Links are made when a side first appears, never by merging two rows.**
  - **An invite is accepted:** if a row has that address as its `login` and
    no `authUserId`, the new account attaches to it. This includes the
    owner's own row, so the owner can invite themself to sign in from off
    the tailnet with a password.
  - **A tailnet login is seen for the first time:** `seeTailnetUser` looks
    for a row with no `login` whose account email matches, and attaches the
    login to it before creating a row.
  - **Two separate rows exist and would collide,** which only an email change
    can cause: the change is refused. An email change to an address that is
    another user's tailnet login or account email answers "that address
    belongs to another user". Merging two users' data is out of scope.
- **Only verified emails link.** An account's email is verified by the
  invite link and every change by the verification mail, so an address can
  be linked only by someone who receives mail there.
- **Tailnet logins that are not addresses never link.** Tailscale's GitHub
  and passkey logins look like `alice@github` and `alice@passkey`, and no
  one can be invited at those addresses, because no mail reaches them.
- **A tailnet admin who can choose login names reaches linked accounts.** A
  tailnet with a custom OIDC identity provider can name a login anything,
  including an invited user's email, and through the link reach that
  account user's data. Today it can already pose as any tailnet user, so
  the trust given to the tailnet admin is the same in kind. It now extends
  to account users, and `docs/multi-user.md` says so.
- **Removing an account** (`DELETE /api/accounts/:id`) on a linked row deletes
  the better-auth user and its sessions and clears `authUserId`. The
  person's tailnet access, if any, continues.
- `Principal` gains `{ kind: 'account'; userId; email; name }`. `User` gains
  `email: string | null`. The webapp and `yaac remote add` show `login ??
  email`.
- `seeAccountUser(authUserId, email, name)` mirrors `seeTailnetUser`: it
  finds the row by `authUserId`, and is refreshed at most hourly.

### Identifying a caller

`identifyRequest` in `api/http/web-auth.ts`, in `accounts` mode:

| The request | Is treated as |
|---|---|
| has `Tailscale-User-Login` and no `Tailscale-Funnel-Request` | that tailnet user (unchanged) |
| carries a valid better-auth session, as a cookie or `Authorization: Bearer` | that account user |
| neither | refused: 401 `UNAUTHENTICATED`, with `signIn: true` in the body so clients show sign-in |

The session is looked up with `auth.api.getSession({ headers })`, which
also runs on WebSocket upgrades. A session for an unverified email cannot
exist (`requireEmailVerification`). Loopback without serve is refused, as in
`tailnet` mode, bar `yaac-mama`.

### Invites

Invites are yaac routes rather than a better-auth plugin, so they go through
`identify()` and the route matrix like any other.

- **`POST /api/invites { email }`** (owner only).
  - It stores a token in better-auth's verification table, through its
    internal adapter, with a 7-day expiry. Only the token's hash is kept.
  - It emails `https://<host>/invite/<token>`.
  - On a `containerless` install the owner's invite dialog says, before it
    sends, that the invitee will be able to reach everything the host
    account can, including every other user's data and credentials. It
    reuses the containerless wording in `@yaac/shared/setup-copy`. The
    email carries the same sentence.
  - It refuses an address that already has an account, or while no SMTP
    settings exist. An address that is only a tailnet login is accepted,
    and the account links to that user (see "yaac users and principals").

  Invites are only ever delivered by email, never shown for copying. That
  is what makes accepting one proof of the address.
- **`GET /api/invites`** and **`DELETE /api/invites/:id`** (owner only).
  These list pending invites and revoke one.
- **`POST /api/invites/accept { token, name, password }`** (public,
  rate-limited).
  - It checks the token is valid and unexpired, and that the password is at
    at least 8 characters and passes the password policy above.
  - It creates the better-auth user with `emailVerified: true` and a
    credential account (password hashed by better-auth's hasher), and spends
    the token.
  - The SPA then signs in through `/api/auth/sign-in/email` as normal.
- **`GET /api/accounts`** and **`DELETE /api/accounts/:id`** (owner only).
  These list account users and remove one's access. Removing deletes the
  better-auth user's sessions and credential account, so every client is
  refused on its next request. It keeps the yaac user row, so their
  projects stay attributed.

### Mail

- One `smtp_settings` row: host, port, TLS mode (`tls` or `starttls`),
  username, password and From address. The password is sealed with
  `symmetricEncrypt` and the install key, as git and tool credentials are.
- Routes (owner only): `GET` returns the settings with the password
  omitted, `PUT` saves them, `DELETE` clears them, and `POST
  /api/settings/smtp/test` sends a test message to an address.
- Sending uses nodemailer, a new dependency. It is pinned once in the
  catalog and listed in both `packages/server` and the root manifest,
  because the published CLI bundle leaves npm dependencies external.
- Messages are plain text with the link: invite, email verification,
  password reset and email-change confirmation.
- `docs/remote-hosting.md` documents Gmail: a dedicated account, 2-Step
  Verification, an app password, and `smtp.gmail.com:465`. Resend and
  Postmark are the options for mail from your own domain.

### Other routes

- **`GET /api/access`** (public) answers `{ mode, accounts: boolean }`, so
  clients know whether to offer sign-in before they hold a session.
- **Outside `accounts` mode,** every account, invite and SMTP route refuses
  with `NOT_SUPPORTED`, so a client asking directly learns this install has
  none.
- **Route matrix.** Every new route gets a row in `test/api/route-matrix.ts`
  with its access level (`public` or a new owner-only level) and the same
  answer under both drivers. This includes the `/api/auth/*` catch-all.

## Clients

### Webapp

New SPA pages:

- **`/login`:** email and password, and "forgot password".
- **`/invite/:token`:** name, password and confirmation. On a
  `containerless` install, a warning above the form says the account will
  reach everything the server's host account can, including other users'
  data and credentials. The page learns the driver from `GET /api/health`,
  which already reports it without identification.
- **`/reset-password`.**
- **`/device`:** enter and approve a CLI code, using the
  `deviceAuthorization` plugin's approve endpoint.
- **Settings → Account** (account users): change password, change email,
  sign out.
- **Settings → Users** (owner): invites and accounts.
- **Settings → Email** (owner): SMTP settings and test.

Any 401 with `signIn: true` sends the page to `/login?next=<path>`. Settings
→ General → "Open on your phone" keeps working, since the origin does not
change.

### CLI

- **`yaac remote add <url>`.** When `GET /api/access` reports accounts and
  `whoami` answers 401, it runs the device-code flow:
  - it prints `https://<host>/device` and a code;
  - it polls `/api/auth/device/token`;
  - it stores the session token;
  - it re-probes `whoami` and prints who the server says you are.
- **`yaac remote login [url]`** (new) does the same for a saved server.
  **`yaac remote logout [url]`** (new) revokes the token on the server and
  deletes it locally.
- **Storage.** Tokens go in `~/.yaac-client/sessions.json`, mode 0600,
  keyed by origin. `server.json` stays credential-free, as documented.
- **Sending them.** `createServerFetch` and `probeServer` send `Authorization:
  Bearer <token>` (the `bearer` plugin). So do the `ws` sockets in
  `shared/src/events.ts`, `shared/src/port-tunnel.ts` and
  `cli/src/commands/ws-terminal.ts`, which take `headers` on connect.
- **Tailnet users** never see the flow, because their probe succeeds.

### Desktop app

- The window shows the server's own `/login` page, so the session cookie
  lands in the window's Electron session. Nothing is injected.
- **Main-process connections** read that cookie from
  `session.cookies.get({ url: origin })` and send it as `Cookie` on each
  connect: the `flow.ts` probe, `/events`, the forwarder's tunnels. Electron's
  cookie API sees `HttpOnly` cookies.
- **The auth daemon** gets the cookie from the main process over its message
  port each time it reconnects.
- **The Servers page** treats 401 with `signIn: true` as connectable. It
  loads the page, which shows the login form, rather than marking the server
  "(refused)".
- **The Tailscale-not-running banner** applies only when `GET /api/access`
  reports no accounts.

### iOS app

- The `WKWebView` shows the server's `/login` page, and the cookie lands in
  its data store. This is the same as Safari, with no
  `ASWebAuthenticationSession` and no custom-scheme callback. iOS Password
  AutoFill works in the form.
- **`ServerStore`'s probe** treats 401 with `signIn: true` as connectable,
  and shows the page instead of "refused". Its "Tailscale is probably off"
  hint applies only to servers without accounts.
- **The preview tunnel** (`PortForward.swift`) reads the cookie from
  `WKHTTPCookieStore` and sets it on its `URLRequest` before opening
  `/api/forward/attach`.
- **The README's "How it reaches a server"** changes: the app now holds a
  credential, the session cookie in its web view data store.

## Security model changes

These are the points `docs/remote-hosting.md` "Security model" must state.
They replace "The tailnet is the trust boundary" and "Never use `tailscale
funnel`":

- Under `funnel`, the server's origin is on the public internet. Without
  signing in, anyone can reach `/api/health`, the SPA and its assets,
  `GET /api/access`, better-auth's endpoints under `/api/auth/*` (sign-in,
  verification, reset, device codes; sign-up is disabled), and `POST
  /api/invites/accept`. Everything else needs a tailnet identity or a
  session.
- **Sign-in endpoints** are rate-limited per client IP, from the
  `X-Forwarded-For` that `serve` writes. Passwords are at least 8
  characters, screened by zxcvbn, and checked against known breaches unless
  the owner turns that off.
- **Passwords can be phished,** unlike passkeys. Two-factor or passkeys are
  the planned follow-ups.
- **Clients now hold credentials:** a session cookie in the browser, the
  desktop app and the iOS app, and a bearer token in
  `~/.yaac-client/sessions.json` for the CLI. Removing an account deletes
  its sessions, so every client is refused on its next request.
- **The owner is the first role** that is not shared by all users. Only they
  invite, remove accounts and set mail. `docs/multi-user.md` "There is no
  admin role" changes accordingly.
- **Account users share the trust model of tailnet users.** Under
  `containerless` that means any user can act as any other, and as the host
  account. The docs say plainly that inviting someone to a containerless
  install gives them the machine. So do both ends of an invite: the owner's
  invite dialog and email, and the invitee's accept page (see "Webapp").
- **The SMTP password** is sealed with the install key, like other
  credentials.

Other docs to update in the same change:

- `docs/multi-user.md`: account users; the owner role.
- `docs/server-selection.md`: the sessions file.
- `docs/cli.md`: the new commands and flags.
- `packages/desktop/README.md` and `ios/README.md`: sign-in and probes.

## Install

### Host server

```
yaac server start --tailnet srv.<tailnet>.ts.net --accounts [--owner <login>]
tailscale serve --bg http://127.0.0.1:8787      # tailnet only
tailscale funnel --bg http://127.0.0.1:8787     # or: also the public internet
```

There are no extra processes. Funnel needs the `funnel` node attribute in
the tailnet policy. Then the owner opens Settings → Email, saves the SMTP
settings, sends a test, and invites people from Settings → Users.

### Cluster install

`yaac cluster install --tailnet --accounts [--funnel]` uses the operator
fronting (`tailnetFronting` in `drivers/k8s/install/server-fronting.ts`).
`--funnel` adds `tailscale.com/funnel: "true"` to the server Ingress. Two
things to check:

- the server pod's egress reaches the SMTP host, and
  `api.pwnedpasswords.com` (unless breach screening is turned off);
- the operator's proxy writes `X-Forwarded-For` and strips identity headers
  the same way host `serve` does.

kind with host `serve` fronting (`serveFronting`) works as on a host:
`tailscale funnel` in place of `tailscale serve`.

## Testing

- **`unit:server`: identification and accounts.** A real better-auth
  instance runs on PGlite. Mocks sit at the process boundaries only: a fake
  SMTP listener in `packages/test-utils`, and a stubbed `fetch` for the
  breach API. Covered:
  - every row of the identify table, including WebSocket upgrades;
  - invite create, accept, expire and revoke;
  - an accept with a 7-character password, a long but guessable one
    (the user's own email plus a year), a spent token, and an address that
    already has an account;
  - linking, in both orders (tailnet login first, then account, and the
    reverse), with a mixed-case address on one side. The linked user's
    tailnet and account principals reach the same projects. An email change
    onto another user's address is refused. Removing the account of a
    linked user keeps their tailnet access;
  - breach screening: refused when the stubbed API lists the password,
    refused when the API is unreachable, and skipped while the setting is
    off;
  - removing an account refusing its cookie and bearer immediately;
  - non-owners refused by every owner route;
  - rate limits holding across a restart;
  - the per-account lockout:
    - it engages after 10 failures from different addresses;
    - the wait doubles while locked, up to an hour;
    - an unknown address gets the same refusal;
    - a reset, or a success, clears it;
    - an existing session keeps working.
- **`unit:server`: `settleAccessMode`.** Every transition above.
- **The route matrix.** Rows for every new route under both drivers.
  `identity-flow.test.ts` gains an account principal, so ownership checks
  run for an account user against tailnet users' data.
- **`test/e2e-containerless/`.** One file, `accounts-suite`, with one
  server:
  - the owner (tailnet headers on loopback, which containerless admits as
    serve) configures SMTP and invites;
  - the fake SMTP listener captures the link;
  - the invitee accepts, signs in and uses the API and a WebSocket;
  - the owner removes them, and their next request fails.

  The suite turns breach screening off through the owner setting, so it
  makes no outbound call, and the setting's route is exercised end to end.
  The check's behavior is covered by the unit tests.
- **`test/e2e-cli/`.** `remote add` and `remote login` through the device
  flow, `remote logout`, and `server start --accounts`. Each new option
  gets coverage, as the CLI rule requires.
- **By hand:**
  - a Playwright script in `test-playwright-scripts/` drives login, invite
    and reset in the browser;
  - a runbook covers the desktop app and the iOS app, on a phone off Wi-Fi
    through Funnel.

## Phases

0. **Spikes**, each proving one assumption against real software before
   code depends on it:
   - better-auth's Drizzle adapter on PGlite;
   - `getSession` on a Hono WebSocket upgrade;
   - the device flow from the CLI;
   - cookies for native connections in Electron and on iOS;
   - Funnel throughput to a public client.
1. **Server and webapp.**
   - the credentials API's move to `/api/credentials`, first and in its own
     change;
   - the mode and the better-auth mount;
   - the password policy;
   - identification;
   - invites, accounts and mail;
   - the SPA pages;
   - route-matrix and unit coverage;
   - docs.

   Browser access works at the end of this phase.
2. **Clients.** CLI device sign-in and the sessions file, desktop
   main-process cookies, the iOS probe and tunnel, and the auth daemon.
3. **Cluster install:** `--accounts` and `--funnel`.
4. **Open sockets.** Removing an account, signing out or resetting a
   password closes that session's open WebSockets. Today they stay up until
   they drop, as tailnet sockets do when a device leaves the tailnet.

## Later

- **Passkeys and two-factor** (`@better-auth/passkey`, `twoFactor`). A
  passkey is bound to the host it was created on (WebAuthn's relying party
  ID), so a later move to another domain means registering new ones;
  passwords and two-factor carry over.
- **Google or GitHub sign-in** through better-auth's social providers, for
  invited addresses only.
- **Cloudflare Tunnel for a custom domain.** `cloudflared` traffic does not
  pass through `serve`, so nothing strips a forged `Tailscale-User-Login`
  from it. It needs its own yaac listener on which tailnet headers are
  ignored and only sessions count, plus better-auth's `baseURL` and
  `trustedOrigins` widened to the new origin.
