# Site identity: one-click sign-in for tailnet users

The issuer of docs/plans/site-identity.md signs people in by email code.
This plan adds a "Continue with Tailscale" button to it: a person on the
install's tailnet signs in with one click, and an agent in a workspace
signs in as its owner without the owner's inbox.

Sign-in comes from [Dex](https://github.com/dexidp/dex) with its
`authproxy` connector, run unmodified in the issuer's own pod, which Logto
offers as a sign-in button. yaac changes in two small ways: a public site
may also answer a tailnet hostname, and an agent's request to a tailnet
site says it came over HTTPS (see "The yaac changes").

It builds on the issuer as that plan leaves it and redoes none of it: one
more step in the issuer's workflow, one connector in Logto and one setting
on the issuer's site.

## How a sign-in flows

```
browser ─► app site ─► auth.example.com  (Logto, the issuer's public hostname)
             └─ "Continue with Tailscale" ─► dex.<site domain>  (Dex in the same pod,
                                              at the issuer's tailnet hostname)
                                              reads tailgate's Tailscale-User-Login,
                                              returns to Logto without a prompt
        ◄─ back to the app, as for any other sign-in
```

A request through the tailnet edge carries a `Tailscale-User-Login` header
that yaac guarantees is true: tailgate drops any copy the client sent and
sets the caller's login (docs/public-sites.md, "Tailnet sites"). Logto
cannot sign someone in from a header, so Dex does it and Logto treats Dex
as an upstream OIDC provider.

## Dex in the issuer's pod

Dex is one more service step of the issuer's release:

- **Image:** the Dex binary, copied from its official image at a pinned
  version into the issuer's `Dockerfile.yaac`.
- **Store:** a second database in the release's Postgres, which the
  issuer's `migrate` step creates if it is absent. One Postgres then holds
  all of the issuer's state, and one dump backs it up.
- **Listener:** 5556, which the issuer site names as its tailnet port, with
  `dex.<site domain>` as its tailnet hostname.
- **Client secret:** a run secret the workflow names
  (docs/project-config.md, "Run secrets"), since Dex compares it and no
  proxy swap can stand in.

Browsers reach Dex at `https://dex.<site domain>`, through the tailnet
edge. Logto reaches Dex's token and key endpoints at `127.0.0.1:5556`,
inside the pod. No request between the two leaves the pod, so the release
needs no path to a tailnet site.

Dex's config file, with one connector and one client:

```yaml
issuer: https://dex.<site domain>
web:
  http: 0.0.0.0:5556
connectors:
  - type: authproxy
    id: tailscale
    name: Tailscale
    config:
      userHeader: Tailscale-User-Login
      userIDHeader: Tailscale-User-Login
      emailHeader: Tailscale-User-Login
      userNameHeader: Tailscale-User-Name
      groupHeader: Tailscale-User-Groups
staticClients:
  - id: logto
    name: Logto
    secretEnv: LOGTO_CLIENT_SECRET
    redirectURIs: ['https://auth.<public zone>/callback/<Logto connector id>']
oauth2:
  skipApprovalScreen: true
```

**Every header setting is named.** `authproxy` reads the user's id, email
and groups from `X-Remote-User-Id`, `X-Remote-User-Email` and
`X-Remote-Group` unless told otherwise, and the tailnet edge does not drop
those. Left at their defaults, a tailnet user could send their own true
login with an `X-Remote-User-Email` of someone else and sign in as them.
Each setting therefore names a `Tailscale-*` header: tailgate and the
egress proxy drop every header with that prefix that a client sent, and
set only the login and name. Nothing sets `Tailscale-User-Groups`, so Dex
sees no groups.

With one connector and no approval screen, Dex shows no page of its own. On
its callback, `authproxy` reads the login header and returns an identity
whose email is the login, marked verified. The tailnet listener refuses a
request without a login, so the callback cannot be completed from anywhere
but the tailnet.

A process inside the pod could call Dex on loopback with a login header of
its choosing. Only the issuer runs there, and it can already sign anyone
in, so this adds no trust.

## In Logto

Add Dex with Logto's generic OIDC social connector, labelled "Continue
with Tailscale". The connector takes each endpoint by itself and does no
discovery, so the browser's and the backend's can differ:

- authorization endpoint `https://dex.<site domain>/auth`;
- token endpoint `http://127.0.0.1:5556/token`;
- `idTokenVerificationConfig` with JWKS URI `http://127.0.0.1:5556/keys`
  and issuer `https://dex.<site domain>`;
- client `logto` and its secret.

Logto matches the Dex identity to the existing user with that email. A
login with no Logto user is refused under "sign in only", as is one that is
not an email address: Tailscale's GitHub and passkey logins look like
`alice@github`, and no user can be created for those.

The button shows for everyone, but works only from a tailnet device: off
the tailnet, `dex.<site domain>` does not resolve.

## Trust

A tailnet whose admin can choose login names (a custom OIDC identity
provider) can name a login after any listed email, and through Dex sign in
as that user. yaac already trusts the tailnet admin to that extent for
tailnet sites. The same trust now covers every app behind the issuer, and
the issuer's setup guide must say so. An install that does not trust its
tailnet admin leaves the Dex connector out.

## The yaac changes

### A site may also answer a tailnet hostname

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
that carry one. The egress proxy already sends every name under the site
domain to that listener with the owner's login, so agents reach a tailnet
hostname as they reach any tailnet site. The site is still a public site
(`siteEdgeOf` reads its hostname), and a release still has no identity and
reaches no tailnet site.

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

### An agent's request to a tailnet site says it came over HTTPS

A person's request reaches a tailnet site with `X-Forwarded-Proto: https`,
which tailgate sets. An agent's reaches it with none: the egress proxy
ends the workspace's TLS, drops every `X-Forwarded-*` header and sets only
the owner's login and name (`stampIdentity` in `k8s/proxy/mitm.ts`). The
router then reports the scheme of its own plain connection from the
proxy, so the app sees `http`.

An app that trusts its proxy for the scheme treats such a request as
insecure. It redirects it to `https://`, where the agent already is, or
refuses to set the secure cookie that holds the session. Either stops an
agent signing in to a tailnet app, which is what this plan is for.

So `stampIdentity` also sets `X-Forwarded-Proto: https`. That is true of
every request it stamps, since the proxy refuses plain HTTP to a tailnet
site (docs/workspace-egress.md, "Tailnet sites"). An app then cannot tell
a person's request from their agent's by this header either.

## Agents

An agent's browser follows the app to Logto and chooses "Continue with
Tailscale". The egress proxy carries the request to `dex.<site domain>`
with the owner's login, provided the project's allowlist names that host
(docs/workspace-egress.md, "Tailnet sites"), and Dex signs the agent in as
the owner.

The allowlist entry is the owner's consent, and it covers more than one
site: an agent that reaches Dex can sign in as its owner to every app
behind the issuer that admits them. An entry for the whole zone
(`*.apps.example.com`) covers Dex too, including one made before the
issuer existed. The issuer's setup guide must say so, and recommend naming
tailnet sites one by one in projects whose agents should not hold that.

Logto's sessions do not record that an agent made the request, so an app
cannot tell an owner from their agent, as on tailnet sites today.

## Operating

Dex is pinned in the issuer's `Dockerfile.yaac` and upgraded with it, on
its own security advisories. It deploys with the issuer, so the two never
run at versions that were not tested together.

## Verify before building

Each of these is a short test on a scratch install that already runs the
issuer:

1. Logto's OIDC connector accepts loopback `http://` token and JWKS
   endpoints beside a public authorization endpoint.
2. A Dex identity attaches to the existing user with that email, rather
   than failing or creating a duplicate, and one with no matching user is
   refused.
3. The app's access rule applies to a sign-in through Dex.
4. A tailnet request carrying `X-Remote-User-Email`, `X-Remote-User-Id`
   and `X-Remote-Group` signs in as the caller's own login, with no
   groups.
5. Dex cannot be reached from the internet or from a release: the public
   listener answers 404 for `dex.<site domain>` and routes nothing to the
   tailnet port, and the egress proxy answers 403 to a release.
6. An agent's request to a tailnet site arrives with `X-Forwarded-Proto:
   http` today, and an agent completes a sign-in to a tailnet app that
   sets a secure session cookie once the proxy sets `https`.

## Alternatives considered

- **Dex as a tailnet site of its own.** Logto's backend would then have to
  call a tailnet site, which a release cannot do: it has no login to
  stamp. Letting it through takes a way into tailnet sites that carries no
  identity, which every app there would have to reason about, and a second
  release, volume and deploy to keep in step with the issuer's.
- **Trusted-header sign-in in the issuer itself.** Logto has none. An
  issuer of our own on better-auth would
  (docs/plans/site-identity.md, "Alternatives considered"), at the cost
  of yaac owning the authentication code.
