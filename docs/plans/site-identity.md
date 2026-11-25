# Site identity: an issuer for apps hosted as sites

Apps hosted as yaac sites sign people in through one OIDC issuer,
`yaac-idp`: a small server in a repo of its own, built on
[better-auth](https://better-auth.com) and run as a public site like any
other. It signs a person in by a code sent to their email. A person on the
install's tailnet signs in with one click instead.

The issuer is not part of yaac, and the yaac server never sees a sign-in.
yaac changes in one small way: a public site may also answer a tailnet
hostname (see "The yaac change").

**Built so far:** the issuer's public and admin listeners, with sign-in by
email code. The `yaac-idp` repo's README is the reference for those.
**Still to build:** the tailnet door, which is the issuer's tailnet
listener, its door plugin and the "Continue with Tailscale" button in
`yaac-idp`, and the tailnet hostname and port of a public site in yaac.
Until then an install signs people in by email code alone, as one with no
site domain always will.

## What an install needs

Sites exist only under the k8s driver, so the issuer does too.

| For | The install needs |
|---|---|
| the issuer, and sign-in by email code | the Cloudflare tunnel, a public hostname routed to it for the issuer, and an account with a mail provider that has an HTTPS API |
| "Continue with Tailscale" as well | a site domain: a `tailnet` install with the tailnet tunnel, its wildcard certificate and the tailnet's split DNS (docs/public-sites.md "Tailnet sites") |

- **The public edge is required.** An app's release must reach the
  issuer's token and key endpoints, and a release reaches no tailnet site.
  An install with tailnet sites and no Cloudflare tunnel therefore cannot
  run the issuer.
- **The site domain is optional.** Without one there is no tailnet
  hostname to give the issuer, so it has no door and people sign in by
  email code alone.
- **The site domain is a real domain, with nothing in public DNS.** Its
  wildcard certificate is issued by proving ownership of the zone, and its
  names resolve only on the tailnet.

## What yaac-idp is

One Node process: better-auth with three of its plugins and one of the
issuer's own.

- `emailOTP` signs a person in by a six-digit code, good for five minutes
  and three attempts.
- `oauthProvider`, from `@better-auth/oauth-provider`, is the issuer: the
  authorization code flow with PKCE, the token and userinfo endpoints and
  the discovery document.
- `jwt` signs the tokens. Its keys are in the database, the private halves
  encrypted with the issuer's secret.
- The issuer's own plugin is the tailnet door (see "The tailnet door").

It listens on three ports, one for each way into a release:

| Listener | Site setting | Reached | Serves |
|---|---|---|---|
| public | the site's port | from the internet, at `auth.example.com` | the OIDC endpoints, the sign-in page, the return from the tailnet door |
| tailnet | its tailnet port | from the tailnet, at `idp.<site domain>` | the tailnet door, and nothing else |
| admin | its admin port | by its owner's forward | registering apps, adding and removing users |

The issuer's URL is its public hostname, and better-auth's `baseURL` is
fixed to it, so no request header changes what the discovery document
names. An app's release calls the token and key endpoints there through its
project's egress allowlist. The issuer cannot be a tailnet site: a release,
like any workspace, reaches none (docs/public-sites.md "Tailnet sites").

## How a sign-in flows

```
browser ─► app site ─► auth.example.com/oauth2/authorize
             │           no session: the sign-in page
             │
             ├─ by email:   enter the address, then the code sent to it
             │
             └─ by tailnet: "Continue with Tailscale" ─► idp.<site domain>
                              reads tailgate's Tailscale-User-Login,
                              returns to auth.example.com with a one-time token
        ◄─ back to the app with an authorization code, either way
```

The authorize endpoint sends a browser with no session to the sign-in
page, with the request it interrupted as a signed query. A sign-in that
carries that query back continues the request, so the sign-in page holds
no OAuth code.

## The tailnet door

A request through the tailnet edge carries a `Tailscale-User-Login` header
that yaac guarantees is true: tailgate drops any copy the client sent and
sets the caller's login (docs/public-sites.md "Tailnet sites"). The door
turns that header into a session at the public hostname.

A cookie set at `idp.<site domain>` is never sent to `auth.example.com`, so
the door cannot set the session itself. It hands one back:

1. "Continue with Tailscale" sets a nonce cookie at the public hostname and
   sends the browser to the door with the nonce and the signed query.
2. The door reads the login, finds the user with that email (see "Who may
   sign in" for a login with none), starts a session for them and mints a
   token for it with better-auth's
   `oneTimeToken` plugin: single use, good for three minutes. It redirects
   to the public hostname's return route with the token, the nonce and the
   query.
3. The return route checks the nonce against the cookie, redeems the token
   for the session cookie and continues the authorization request.

**The nonce ties the return to the browser that pressed the button.** A
return link signs its holder in as whoever went through the door. Without
the nonce a tailnet user could send theirs to someone else, who would then
use the app as the sender without knowing it.

**The door reads two headers and no others**: `Tailscale-User-Login` and
`Tailscale-User-Name` (Q-encoded when not ASCII). tailgate drops every
`Tailscale-*` header a caller sent before setting its own, so nothing a
client sends reaches the door under those names.

**The door is served on the tailnet port alone.** The router's tailnet
listener refuses a request without a login, the per-site policy admits only
the router to that port, and the public listener never routes to it. The
public port has no such route, and the router's public table drops the
header anyway.

**The login is the user's email, marked verified.** A login that is not an
email address is refused: Tailscale's GitHub and passkey logins look like
`alice@github`, and a user is keyed on an address a code could be sent to.

A process inside the pod could call the door on loopback with a login of
its choosing. Only the issuer runs there, and it can already sign anyone
in, so this adds no trust.

The button shows for everyone but works only from a tailnet device: off the
tailnet, `idp.<site domain>` does not resolve.

## Who may sign in

The issuer proves that a person controls an email address. What that
address may do is each app's decision.

- **Closed**, the default: only users added on the admin port sign in, by
  either way, and a code is sent to no one else (`emailOTP`'s
  `disableSignUp`). A new issuer therefore admits nobody until its owner
  adds the first users.
- **Open**, a setting of the issuer's: a first sign-in by either way
  creates the user. It suits an app meant for the public.

Anyone on the internet can ask an open issuer to mail a code to any
address. better-auth limits how often one client may ask, three times a
minute by default, and takes the client from an `X-Forwarded-For` that
holds a single address, which is what the edge hands an app
(docs/public-sites.md "Headers an app may trust"). The limit is per client,
not per address mailed, so the mail provider's own sending limits are the
backstop.

## Apps

A person registers an app on the admin port: its name and redirect URIs.
The admin routes check no caller, so they are served on that port alone,
and the yaac server's owner check on the forward, which forwards a
release's ports only at a loopback address, is their whole access control
(docs/public-sites.md "Admin port"). The issuer refuses what a browser
sends from other pages. No agent in a cluster workspace can reach an admin
port; one in a containerless workspace on the owner's machine can, as any
program there can.

The plugin's `adminCreateOAuthClient` registers a client only for a session
its `clientPrivileges` option admits. The issuer gives its own call from the
admin routes a session that names no user, and `clientPrivileges` admits
that one alone, so a signed-in person registers nothing on the public port.

- Apps are registered with `skip_consent`: they are the install's own, and
  a consent page would ask a person to approve their own team's app.
- PKCE is required, the plugin's default.
- Dynamic registration stays off.

The app's project then holds three settings: the issuer's URL and the
client id as variables, and the client secret as a project secret whose
rule names the issuer's token endpoint and the `client_secret` form field.
The egress proxy puts the secret in the request, so neither the app's
release nor the agents working on the app hold it (docs/project-config.md
"Environment variables and secrets"). The project's allowlist names the
issuer's hostname.

## The issuer's own settings

- **`BETTER_AUTH_SECRET`** is a run secret the issuer's workflow names
  (docs/project-config.md "Run secrets"). It signs cookies and the
  sign-in page's query and encrypts the signing keys, so no proxy swap can
  stand in.
- **Mail** goes through a provider's HTTPS API, since a release's egress
  carries only HTTP. The API key is a project secret with a rule for the
  provider's host, which the allowlist names, so the release never holds
  the key either.
- **The site** names a volume, its three ports, and `idp.<site domain>` as
  its tailnet hostname.

## State

Everything the issuer keeps is one PGlite database, a Postgres data
directory on its site's volume: users, sessions, apps, signing keys and
pending codes. PGlite is Postgres running inside the issuer's process, so
the release has no database service. Only one process may open the
directory, so the admin routes are a listener of the issuer's process, not
a second service step (docs/public-sites.md "Admin port"), and the issuer
closes the database when it is told to stop.

The tables are managed with drizzle, as the yaac server's are:

- better-auth reads and writes through its drizzle adapter (`provider:
  "pg"`) over `drizzle-orm/pglite`.
- The drizzle schema is written by hand, in the yaac server's style, for
  the models better-auth and the issuer's plugins define. A test compares it
  with the tables and fields better-auth reports, and so names what a
  better-auth upgrade or a new plugin adds or drops.
- drizzle-kit turns each schema change into a named migration, checked in
  beside it. better-auth's own `migrate` command works only with its
  built-in adapter and is not used.

The workflow's `migrate` step needs the volume, so it runs after the
handoff, when no older release has the directory open. It opens the
database, writes a dump of it to the volume (`dumpDataDir`, consistent
because nothing else has the database open), applies the checked-in
migrations with drizzle's `migrate`, and closes it before the server step
starts.

The dialect is Postgres, so an issuer that outgrows one process moves to a
Postgres service step with the same schema and migrations.

A user's `sub` is their row's id. An issuer that loses its volume gives
every user a new one, and each app that keys its accounts on `sub` loses
the link to them. Volumes are not in the cluster backups
(docs/workspace-volumes.md "Not yet"), so an issuer should not hold
accounts that matter until they are.

## Trust

**The tailnet admin.** A tailnet whose admin can choose login names (a
custom OIDC identity provider) can name a login after any email, and
through the door sign in as that user. yaac already trusts the tailnet
admin to that extent for tailnet sites. The same trust now covers every app
behind the issuer, and the issuer's setup guide must say so. An install
that does not trust its tailnet admin sets no tailnet hostname on the
issuer, which leaves the door unreachable.

**Whoever deploys the issuer.** Code that runs as the issuer can sign
anyone in to every app behind it. Deploying a published site takes an admin
in person, on commits a person approved (docs/public-sites.md
"Publishing"). An issuer set to follow a branch hands that to whoever may
push the branch, the project's agents included, so the issuer names a
commit or follows a branch only people push to.

## The yaac change

A public site may name a **tailnet hostname** and a **tailnet port**: a
second door into the same release, open only to the tailnet, where every
request carries a true login.

- **Settings.** `tailnetHostname` and `tailnetPort`, both or neither, on a
  public site of an install with a site domain. The hostname is one label
  under the site domain and unique among every site's hostnames. The port
  differs from the site's port and its admin port.
- **Router.** The tailnet hostname is a virtual host in the tailnet
  listener's route table, routed to a second cluster on the site's Service
  at the tailnet port. The public table does not name it, so no request
  from the internet reaches that port.
- **Policy.** The per-site NetworkPolicy admits router pods on the tailnet
  port as well as the site's port.
- **Edits.** The tailnet hostname moves at once and the tailnet port from
  the next deploy, as the site's own hostname and port do.

Nothing else changes. The tailnet listener still answers 403 to a request
without a login, so the process on the tailnet port sees only requests
that carry one. The site is still a public site (`siteEdgeOf` reads its
hostname), and a workspace reaches its tailnet hostname no more than it
reaches a tailnet site.

An app using this must serve its tailnet-only routes on the tailnet port
alone. A request on the site's own port never carries a login, since the
public listener drops the header.

The setting reaches the API, CLI and webapp like any other site setting:

- fields on site create and edit, covered by the existing site rows in
  `test/api/route-matrix.ts`;
- `yaac site` options to set and clear them, each with an e2e test;
- fields in the site form, and the tailnet address in `site list` and
  `site show`.

The change is generic. An app on the internet that wants a door for
teammates only, such as an admin view that knows who is asking, needs the
same thing.

## Agents

An agent in a workspace signs in to nothing behind the issuer. It reaches
the issuer's public hostname as it reaches any site on the internet, but
not the door, since a workspace reaches no tailnet site, and it has no
inbox for a code.

An agent outside yaac, on a tailnet device that belongs to a user, comes
through the door as that user, like their browser.

Reaching a tailnet site as an agent, with an identity of its own, is
docs/plans/site-agent-access.md.

## Operating

- **Upgrades are a deploy of the issuer's site.** better-auth is pinned in
  the issuer's repo and moved on its security advisories. No yaac release
  is involved, and a yaac upgrade never interrupts sign-in.
- **A deploy has a gap.** The issuer has a volume, so its site is down from
  the old release's stop until the new one is ready (docs/public-sites.md
  "Volumes: a staged handoff"). Nobody signs in meanwhile. A person already
  signed in to an app stays so, since each app keeps its own session.
- **One release.** A release whose pod is lost is replaced, and until then
  nobody signs in.

## Not in this plan

- **Signing in to the yaac server from off the tailnet.** The server
  identifies a caller by the tailnet, and public traffic never reaches it
  (docs/remote-hosting.md "Security model"). Changing that is a change to
  what the server trusts, not a use of this issuer. If it is ever wanted,
  the server would be a client of an issuer its host names, and an issuer
  run as a site could then make an admin of anyone.
- **Passkeys and second factors**, which better-auth has plugins for.
- **An agent registering an app** for a site it is building.

## Verify before building

The email-code issuer answered the checks that needed no tailnet: it is
closed unless set open, its discovery document names the public hostname
whatever `Host` a request carries, a request to the public port carrying
`Tailscale-User-Login` signs no one in, and better-auth's drizzle adapter
runs over `drizzle-orm/pglite` with a dump that loads into a fresh
database. These remain, each a short test on a scratch install:

1. A sign-in endpoint of the issuer's own plugin that carries the signed
   query and creates a session continues the authorization request. If only
   better-auth's own sign-ins do, the return route redirects to the
   authorize endpoint with the original parameters, where the session now
   exists.
2. A one-time token minted for a session the door started redeems once on
   the public listener, sets the session cookie there, and is refused a
   second time and without the nonce cookie.
3. A sign-in through the door attaches to the existing user with that
   email, rather than failing or creating a duplicate, and a login that is
   not an email address is refused.
4. A closed issuer refuses an unknown login at the door, and an open one
   creates the user.
5. The door cannot be reached from the internet or from a release: the
   public listener answers 404 for `idp.<site domain>` and routes nothing
   to the tailnet port, and a release's request for that name reaches
   nothing.
6. An app's release completes a token exchange with a placeholder client
   secret, which the egress proxy replaces in the form body. The issuer
   registers every app for `client_secret_post`, and accepts a secret sent
   that way in its own tests; what is unchecked is the proxy's swap.

## Alternatives considered

- **The issuer inside the yaac server.** An issuer must be reached by
  browsers on the internet and by releases, and the server admits neither:
  its ingress policy is part of how it identifies callers
  (docs/server-in-cluster.md "The ingress policy is the wall").
  Sign-in code facing the internet would run in the process that holds
  every user's credentials, every site's sign-in would stop for each yaac
  upgrade, and a better-auth fix would wait on a yaac release. The server
  pins better-auth for its at-rest encryption alone, and the issuer plugin
  needs a newer one.
- **An install-managed pod**, shipped with yaac as tailgate is. It needs no
  setup, but ties the issuer to yaac's releases and puts its state in an
  object install must manage. Worth another look if setting the site up by
  hand proves to be what stops people.
- **Unmodified Logto, with Dex for the tailnet button.** No sign-in code of
  our own, at the cost of three services in the issuer's pod (Logto, its
  Postgres and Dex) and an OIDC hop between two of them. Dex's `authproxy`
  connector also reads its user from `X-Remote-*` headers unless every one
  is renamed, and the tailnet edge does not drop those.
