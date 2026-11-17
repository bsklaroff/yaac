# Site identity: one sign-in for apps hosted on yaac

Apps published as yaac sites (docs/public-sites.md) that support OpenID
Connect sign people in through one identity provider, the **issuer**, which
is itself an ordinary site. People sign in with a code sent to their email,
and later with Google. The issuer's admin decides, per app, which emails
and groups may sign in.

The issuer is [Logto](https://github.com/logto-io/logto) (open-source
edition, MPL-2.0), run unmodified. yaac itself gains no identity code: no
account tables, no allowlists, no login pages. Its one change is a set of
headers each edge drops (see "The yaac change").

It depends on docs/plans/preview-pane-loopback-origin.md, which is how the
issuer's admin console is opened (see "The admin console").

One-click sign-in for tailnet users, and for agents acting as their owner,
builds on this issuer and is docs/plans/site-identity-tailscale.md.

## Goals and non-goals

Goals:

- An app that supports OIDC sign-in, such as fluxer, uses the issuer with
  configuration only, never a change to its source.
- Sign-in by email code. Google sign-in can be added later from the admin
  console.
- Per-app allowlists of emails and of **email groups** (named sets of
  emails), managed in the issuer's admin console. Open signup is off.
- One sign-in covers every app: after the first, signing in to another app
  only bounces through the issuer.

Non-goals:

- **Gating apps that do not speak OIDC.** yaac's router does not check
  identity. Such an app can run an OIDC proxy (oauth2-proxy or similar) as a
  step of its own release, in front of the app, pointed at the issuer.
- **Revoking live app sessions.** The allowlist is checked when someone
  signs in. Removing an email stops their next sign-in; a session the app
  already issued lasts until it expires or the app's admin removes the user.
- **Containerless installs.** They have no sites.

## How a sign-in flows

```
browser ─► app site (e.g. chat.example.com) ─► "Sign in with SSO"
        ─► auth.example.com  (Logto, the issuer's public hostname)
             ├─ email code
             └─ Google (later)
        ◄─ back to the app with a code; the app's backend redeems it at Logto
```

1. The app sends the browser to the issuer's authorization endpoint.
2. Logto signs the person in, or recognizes the session it already holds.
3. Logto checks the app's access rule. A person not on it is refused, so the
   app never sees them and never creates an account for them.
4. The app's backend exchanges the code for tokens at Logto. That request
   leaves the app's release through the egress proxy and comes back in
   through Cloudflare to the issuer's public hostname.

## The issuer

### Running Logto as a site

The issuer is a project of its own, published as a public site:

- **Image:** a layered `Dockerfile.yaac` (docs/project-config.md) that adds
  PostgreSQL and Logto, copied from the official image at a pinned version.
- **Workflow**, shaped like the migration example in docs/public-sites.md
  ("Migrations"):
  - `db`: a Postgres service step whose data directory is on the site's
    volume.
  - `migrate`: a one-shot step that dumps the database to the volume, seeds
    it if it is empty (Logto's `db seed --swe`), and applies the schema
    changes of the pinned version (Logto's `db alteration deploy`). It runs
    on every deploy and finds nothing to do when the version has not moved.
  - `logto`: the Logto service step, with its public listener on 3001 and
    its admin listener on 3002.
- **Site:** hostname `auth.<public zone>`, port 3001, admin port 3002, and a
  volume.
- **Environment:**
  - `ENDPOINT=https://auth.<public zone>`
  - `DB_URL` pointing at the local Postgres
  - `TRUST_PROXY_HEADER=1`, since TLS ends at the edge
  - `ADMIN_ENDPOINT` unset, which leaves the console at Logto's default,
    `http://localhost:3002`

### The admin console

The issuer site names 3002 as its admin port, so the router never routes
it and only the site's owner can reach it, through yaac's owner check on
the forward (docs/public-sites.md, "Admin port"). The console's first
visitor becomes Logto's admin, so the admin port settles both who
administers the issuer and how its first admin is created.

The owner opens the console as the live release's Preview in the desktop
app, which the site's row in project settings links to. This needs the
preview pane of docs/plans/preview-pane-loopback-origin.md, which loads a
workspace's port at `http://localhost:<port>` and sends the pane's
loopback traffic to that workspace. Logto serves the console only to a
browser at the console's configured origin, `http://localhost:3002` by
default, and answers any other origin on that port with the sign-in pages.
The pane is at exactly that origin for every release, so `ADMIN_ENDPOINT`
stays unset and nothing has to be configured to match.

Without that pane no way to the admin port holds that origin across
deploys. A workspace hostname (`3002.<id8>.localhost`,
docs/workspace-hostnames.md) names the release. A forwarded port is at
3002 only when no other workspace on the server held host port 3002 when
the release launched, and a deploy launches the new release while the old
one still holds it (docs/port-forward-tunnel.md). So the console is
reached from the desktop app only, not from a browser tab or the iPhone
app.

Logto does not tell its two listeners apart by port. It serves the console,
and the sign-up of that first admin, to any request whose URL has the
console's origin, on either port. With `TRUST_PROXY_HEADER=1` it builds
that URL from `X-Forwarded-Host` and `X-Forwarded-Proto`. So the console
stays off the internet only if no public request can carry a forwarded host
of its choosing, which the yaac change below ensures.

### Mail

Only 80, 443 and git over ssh leave a workspace
(docs/workspace-egress.md), so Logto's SMTP connector cannot be used here.
The issuer uses one of Logto's HTTP email connectors (Postmark, AWS SES,
Mailgun, SendGrid), or its generic HTTP connector for another provider.

- The admin enters the provider's API key in the connector's settings in
  Logto's console. Logto keeps it in its database, on the volume, beside
  its accounts and signing keys. yaac holds no mail setting.
- The provider's API host is on the issuer project's egress allowlist.
- Logto's Node process must trust the egress proxy's CA, as any workspace
  process does (docs/workspace-egress.md, "CA trust in a workspace").

### Who may sign in

Everything in this section is configured in Logto's admin console. yaac
holds none of it.

| Concept | In Logto |
|---|---|
| Sign-in method | Email identifier, verified by a code. Passwords off. |
| No open signup | Sign-in mode "sign in only". |
| An allowed email | A user created with that email. |
| An email group | A role, given to each of its members. |
| An app's allowlist | The app's access rule (Logto's app-level access control), naming users and roles. |

App-level access control is part of the open-source edition. It has no
license or quota check in Logto's code (`koa-app-access-control.ts`,
`libraries/application-access-control.ts`).

### Licensing

Logto's paid self-hosted license unlocks a fixed list of features
(`packages/schemas/src/consts/license.ts`):

- hiding "Powered by Logto";
- a custom sign-in UI bundle and CSP;
- more than one console member;
- mandatory MFA;
- IdP-initiated SSO;
- more than three SAML apps;
- Logto's hosted email service.

None of these is needed here. The single console member is no limit,
because the console sits behind the admin port.

Each upgrade should check that file, and `guardTenantUsageByKey` in
`packages/core/src/libraries/quota.ts`, for features newly placed behind
the license. Forking under the MPL to remove the checks is legal, but means
carrying a patch through every security upgrade, so the issuer runs the
official code.

## Connecting an app

1. In Logto, register the app as a traditional web app with the redirect
   URI the app documents, and give it an access rule.
2. In the app, set the issuer URL (`https://auth.<public zone>/oidc`) and
   the client ID and secret Logto shows.
3. On the app's project, add the issuer's hostname to the egress allowlist.

Inside a yaac pod every outside hostname resolves to the egress proxy's
sinkhole address, `198.18.0.1` (docs/workspace-egress.md). Apps that refuse
an OIDC provider at a non-public address need that check turned off; this
is configuration, not code.

**fluxer** as the worked example:

- Set `FLUXER_SSO_ALLOW_PRIVATE_ADDRESSES=true`.
- In fluxer's admin panel, set its SSO to enabled with the issuer and the
  client credentials.
- Turn on `auto_provision`, and turn on `enforced` once the admin's own
  account is linked. Without `enforced`, fluxer's own signup bypasses the
  allowlist.
- Leave `allowed_domains` empty, since Logto already filters who signs in.

fluxer's redirect URI is `<web app>/auth/sso/callback`. It requires PKCE
(S256), an asymmetrically signed ID token, plain JSON from `/userinfo`, and
a verified `email` claim, all of which Logto provides.

The same steps work for an app on a tailnet site. Its users' browsers reach
the public issuer over the internet, and its backend reaches it through the
egress proxy.

## The yaac change: each edge drops the headers nothing vouches for

An app behind an edge that ends TLS has to trust some request headers,
and it trusts them whoever wrote them. yaac vouches for these and no
others:

| Edge | Headers an app may trust | Set by |
|---|---|---|
| Both | `X-Forwarded-For`, `X-Forwarded-Proto` | the edge and the router |
| Public | `CF-*` (`CF-Connecting-IP` and the rest) | Cloudflare |
| Tailnet | `Tailscale-User-Login`, `Tailscale-User-Name` | tailgate, or the egress proxy for an agent |

Logto needs `X-Forwarded-Proto` to set its secure cookies, and believes
`X-Forwarded-Host` too, which selects the admin console (see "The admin
console"). So each edge drops the headers that carry the same kind of
claim and that nothing in front of it sets.

**The public listener.** The router's public route table already removes
the Tailscale identity headers (`TAILNET_IDENTITY_HEADERS` in
`cluster/site-edge.ts`). Envoy removes request headers only by name, so
the table gains the names in use:

- `X-Forwarded-Host`, `-Port`, `-Prefix`, `-Server`, `-Scheme` and `-Ssl`,
  and `Forwarded`, which frameworks read to rebuild the URL a client asked
  for;
- `X-Real-IP` and `True-Client-IP`, which frameworks read for the client's
  address, some of them before `X-Forwarded-For`;
- `X-Forwarded-User`, `-Email`, `-Groups`, `-Preferred-Username` and
  `-Access-Token`, which an auth proxy sets and the app behind it trusts.

A Cloudflare zone that turns on `True-Client-IP` loses it; `CF-Connecting-IP`
carries the same address.

**The tailnet edge.** tailgate and the egress proxy's site route already
drop every `Tailscale-*` and `X-Forwarded-*` header a caller sent. They
also drop every `CF-*` header, and `Forwarded`, `X-Real-IP` and
`True-Client-IP`. A `CF-*` header means something only on the public edge,
so an app written for that edge and published on the tailnet would
otherwise believe a client address, or a Cloudflare Access user, that a
tailnet caller chose.

`Host` is unchanged on both edges and still names the site, so an app
loses nothing.

**What the lists leave out.** Every auth proxy has identity headers of its
own (`X-Remote-User`, `Remote-User`, `X-Auth-Request-Email` and many
more), and no list names them all. An app that takes a user from one must
have it set by a proxy inside its own release, which drops the client's
copy. docs/public-sites.md says so beside the table above.

## Operating the issuer

- **The issuer project is the most sensitive project on the install.**
  Anyone who can deploy it decides who can sign in to every app that trusts
  it. That includes agents with push access to its repo. Keep it
  owner-only, deploy pinned commits rather than following a branch, and do
  not give agents push access to it.
- **Upgrades** pin a Logto version in `Dockerfile.yaac` and follow Logto's
  security advisories, which are frequent. The `migrate` step applies the
  new version's schema changes after the handover, and its dump is the way
  back if they fail.
- **Deploys** have a handover gap, because the site has a volume. During it,
  new sign-ins fail and sessions apps already hold are unaffected.
- **The volume holds every account, access rule and signing key, and the
  mail provider's API key.** It needs
  backing up like any site volume, and its backups are as sensitive as the
  project.

## Verify before building

Each of these is a short test on a scratch install:

1. "Sign in only" sends no code to an unknown address, and refuses a
   Google identity with no matching user rather than creating one.
2. Access rules by role apply to every sign-in path, social connectors
   included.
3. Logto runs in a layered yaac image, Postgres on the volume survives a
   deploy's handover, and a version bump's schema changes apply in the
   `migrate` step.
4. The admin console works in the desktop app's preview pane at
   `localhost:3002` with `ADMIN_ENDPOINT` unset: creating the first admin,
   signing in without leaving the pane, and its calls to the issuer's
   public hostname.
5. A request to the public hostname with `X-Forwarded-Host: localhost:3002`
   and `X-Forwarded-Proto: http` gets the sign-in tenant, not the console,
   once the router drops the header. The same request before the change
   shows what the change closes.
6. An HTTP email connector, with its key set in Logto's console, delivers
   through the egress proxy.
7. fluxer completes a sign-in through the outbound-and-back path with
   `FLUXER_SSO_ALLOW_PRIVATE_ADDRESSES=true`.

## Alternatives considered

- **Our own issuer on better-auth.** Fits exactly: any mail API, and
  trusted-header sign-in for tailnet users with nothing beside it. But
  yaac would own the authentication code and its security fixes. It is
  the fallback if a check above fails.
- **Pocket ID.** Simpler (one container, SQLite, email codes for pre-created
  users, groups per client), but it sends mail only by SMTP and has no
  upstream sign-in, so neither Google nor Tailscale sign-in
  (docs/plans/site-identity-tailscale.md) fits.
- **An identity check in yaac's site router.** It would check every request
  instead of each sign-in, but its session cookie never reaches native and
  mobile clients, whose requests carry only the app's own token. It would
  also put identity and allowlists back inside yaac, and fail closed for
  every gated site during each issuer deploy.
