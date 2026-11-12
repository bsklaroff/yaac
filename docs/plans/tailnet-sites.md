# Tailnet sites

docs/public-sites.md publishes a site on the internet through Cloudflare
Tunnel. This plan adds a second edge: a site published only on the
install's tailnet, under a domain that resolves only there, where every
request carries the caller's tailnet login. People open it in a browser.
Agents reach the same URL from their workspaces and act as their
workspace's owner. Everything behind the router stays as it is: releases,
deploys, volumes, following.

The app decides what a login may do. This plan only guarantees that the
`Tailscale-User-Login` header a tailnet site receives is true.

## The site domain

An install may have one **site domain**, a DNS zone its admin owns
(`apps.example.com`), given to `yaac cluster install`. Every name directly
under it is a tailnet site's: `kaneo.apps.example.com`.

- **A site named under the site domain is a tailnet site**, and any other
  site is a public one. There is no edge setting to choose, so no schema
  change: the hostname says which. A hostname must be exactly one label
  under the domain, which is what a wildcard certificate covers.
- **The names resolve only on the tailnet.** The tailnet's DNS settings
  send the zone to the tailnet pod (split DNS), which answers every name under
  it with its own tailnet address. No record for a site exists in public
  DNS.
- **The zone must be a real domain**, because browsers trust only
  certificates a public authority issued, and those are issued only for
  domains whose owner passes a DNS challenge. The challenge record is the
  one thing published; site names are not.

A tailnet site needs a `tailnet` install (docs/remote-hosting.md "Access
modes"), since a `local` install has no logins to stamp. It is created,
edited, deployed and started by its project's owner while an admin, the
rule for public sites.

## The edge

```
tailnet device ──(WireGuard)──► yaac-site-tunnel-tailnet   one pod, one tailnet device
                                  tailscaled: forwards 443, 80 and 53 to
                                  tailgate:   DNS for the zone; TLS; who is calling
                                      │
                                      ▼
                                  yaac-site-router :8081  (the tailnet listener)
                                      │
                                      ▼
                                  Service yaac-site-<site id> ─► release pod :<port>
```

One pod serves every tailnet site. A site adds a Service, a NetworkPolicy
and a route, as a public site does, and nothing at the tailnet pod, in
Tailscale or in DNS.

### The tailnet pod

`yaac-site-tunnel-tailnet` is a one-replica Deployment that install
applies only once given a Tailscale auth key, as the Cloudflare tunnel is
applied only with its token. The two are the site tunnels, each named for
the network it brings sites in from: this one, and
`yaac-site-tunnel-cloudflare` for cloudflared (see "Renaming the
tunnel"). Its two containers, tailscaled and tailgate, share a uid and
tailscaled's socket.

**tailscaled** is Tailscale's stock image, digest-pinned and mirrored like
cloudflared, in userspace networking mode, so it needs no privilege. It
joins the tailnet once with the auth key, as a tagged device. Its state is
a Secret, so the device and its tailnet address survive a restart; the
zone's DNS setting names that address. Its serve config is static:
connections to 443 and 80 are forwarded to tailgate as raw TCP behind a
PROXY protocol header, version 1, one text line carrying the caller's
tailnet address. Userspace mode already delivers UDP and TCP 53 to the
pod's loopback.

**tailgate** is yaac's, an image of its own built from `k8s/tailgate/`,
as the proxy's and netd's are from their folders. It shares nothing with
the egress proxy's image. That image carries Tor, an ssh client and a
cluster client tailgate has no use for, and a change to the proxy would
otherwise roll the tailnet pod and cut every tailnet site's connections.
What the two could share is small: tailgate reads a one-line header where
the proxy parses version 2's binary one, and its DNS answers AAAA and
refusals the proxy's stub never sends. It does three things:

- **DNS.** It answers A and AAAA for any name under the site domain with
  the tailnet pod's own tailnet addresses, and refuses every other name.
- **TLS.** It ends TLS on 443 with the certificate in the Secret
  `yaac-site-tunnel-tailnet-tls`, reloading it when the Secret changes.
  On 80 it redirects to `https://`.
- **Identity.** For each connection it asks tailscaled who holds the
  address in the PROXY header (the local API's `whois`). A caller with no
  user, which is what a tagged device is, gets a 403. Otherwise it removes
  every `Tailscale-User-*` and `X-Forwarded-*` header the client sent,
  sets `Tailscale-User-Login`, `Tailscale-User-Name`, `X-Forwarded-For`
  (the tailnet address) and `X-Forwarded-Proto: https`, and forwards the
  request, or a WebSocket upgrade, to `yaac-site-router:8081` with `Host`
  unchanged.

tailgate holds no list of sites. A name under the zone that no site has
resolves, and the router answers 404.

The tailnet pod has one replica because it is one tailnet device with one
address. While it restarts, no tailnet site answers; open connections
drop.

### The certificate

tailgate serves whatever `yaac-site-tunnel-tailnet-tls` holds: a wildcard
for the site domain. yaac does not obtain or renew it. The admin creates
the Secret, by hand or by pointing cert-manager's Certificate at that
name with a DNS-01 issuer, which is the only challenge that works for
names the internet cannot reach. Without the Secret tailgate is not
ready, and install and `GET /site/edge` say what is missing.

### The router's tailnet listener

The router gains a second static listener on `SITE_ROUTER_TAILNET_PORT`
(8081), with its own route table, a second RDS file in the routes
ConfigMap. The cluster file is shared.

- **The two route tables are disjoint.** A public site is a virtual host
  only on 8080, a tailnet site only on 8081. So no `Host` that Cloudflare
  could be configured to send reaches a tailnet site.
- **The tailnet listener refuses a request without
  `Tailscale-User-Login`** with a 403, so an app sees only requests with a
  login, whatever sent them.
- **The public listener removes `Tailscale-User-*` request headers.** An
  app written for the tailnet edge and published on the public one by
  mistake, a mistyped hostname say, then sees no identity instead of one
  the internet chose.

Timeouts and WebSocket upgrades match the public listener, and tailgate
is the one trusted hop for `X-Forwarded-For`.

### Network policy

- **Tailnet pod egress**: public addresses, for Tailscale's coordination
  and relay servers and its peers; DNS; and the router on 8081. Not the
  server, the proxy or any workspace. Peers on a private address are
  reached through a relay, since the floor cuts those ranges.
- **Tailnet pod ingress**: node addresses on its health port, for the
  kubelet. Tailnet traffic arrives inside connections tailscaled dialed
  out.
- **Router ingress** admits on 8081 the tailnet pod and the egress proxy
  (see "Agents"). The Cloudflare pods are not admitted to 8081.
- **Per site**, unchanged: release pods admit router pods on the site's
  port. A tailnet release is as locked, credential-free and cut off from
  the server as a public one.
- **The server's ingress** gains no peer. Tailnet traffic to a site never
  passes through the server.

### Who may reach a site

Every tailnet site is behind one device and one port, so the tailnet's
ACLs decide who reaches the tailnet pod, not which site. An ACL grant to
its tag on TCP 443 and 80 and on port 53 admits a user to all of them.
Telling sites apart is the app's job until yaac keeps a list per site
("Not in this plan").

### Renaming the tunnel

`yaac-site-tunnel` becomes `yaac-site-tunnel-cloudflare`, since the bare
name no longer says which of the two tunnels it is.

- **Renamed**: the Deployment, the Secret holding its token, its two
  NetworkPolicies and the `app` label they select; the `SITE_TUNNEL_*`
  constants, which gain `CLOUDFLARE`; the check gate's probe; the driver
  verb `siteTunnelStatus` and the `tunnel` field of `SiteEdgeStatus`,
  which become `siteCloudflareStatus` and `cloudflare` beside the tailnet
  pod's.
- **Kept**: `CF_TUNNEL_TOKEN`, which is Cloudflare's name for what it
  holds, and "the tunnel" in prose and messages for Cloudflare Tunnel
  itself.

An install from before the rename has its token in the Secret
`yaac-site-tunnel`, and install keeps the tunnel only while its Secret
exists. Renaming in code alone would have the next install without
`CF_TUNNEL_TOKEN` find no Secret and remove the tunnel, taking every
public site down until someone supplied the token again. So the rename
carries two pieces of compat, removed together:

- **Install moves the tunnel.** When the old Secret exists and the new one
  does not, `ensureSiteEdge` copies the token to the new name. It then
  applies the new Deployment, waits for it to connect, and only then
  deletes the old Deployment, Secret and policies. cloudflared runs any
  number of connectors for one tunnel, so the two overlap without a gap.
- **The router admits both labels.** Install rolls the server before it
  reaches the edge, and the new server re-renders the edge's policies as
  it starts. If the router then admitted only the new label, the old
  pods would be cut off until install caught up. So the router's ingress
  policy also names `app: yaac-site-tunnel`. Only someone who can already
  write to the namespace can create a pod with that label.

Both get one entry in docs/legacy-compat-shims.md: they read the old
Secret and label; removed too early, an install that has not run `yaac
cluster install` since loses its public sites at the next one; and they
are safe to remove once no supported upgrade starts from a version that
applied `yaac-site-tunnel`.

## Agents

A workspace pod is not on the tailnet and cannot resolve the site domain.
The egress proxy carries its request to the router and says who the
workspace's owner is.

```
workspace ─► netd ─► egress proxy (MITM; stamps the owner's login)
                         │
                         ▼
                     yaac-site-router :8081 ─► release pod
```

### The route

The proxy is given the site domain when the server deploys it. For a
request to a name under it the proxy:

1. checks the workspace's allowlist as for any host. A project reaches a
   tailnet site only if its allowlist names it, or the whole zone
   (`*.apps.example.com`), because the request will carry its owner's
   identity: the entry is the owner's consent, as allowing `github.com` is
   consent to spend their git credential there. A refused attempt shows
   on the blocked-hosts badge, where one click allows it;
2. ends the workspace's TLS with a leaf for the hostname, as for any host
   it injects into;
3. sends each request, and each WebSocket upgrade, as plain HTTP to
   `yaac-site-router:8081` with `Host` unchanged. The destination is the
   server's choice, not the workspace's, so the non-public guard does not
   apply, as for the mama relay. This is the `upstreamRedirects` path,
   which stops being test-only.

A name under the site domain never takes the direct dial. A plain-HTTP
request to one is refused with a 403 naming the `https://` URL, and a
CONNECT to one is handled as above whatever port it names.

### Identity

A workspace's registration gains `identity`, the login and display name
of the project's owner, handed down by `#domain/workspaces` with the rest
of the registration. A release has none, as it has no credentials.

On the site route the proxy removes every `Tailscale-User-*` and
`X-Forwarded-*` header the workspace sent, then sets
`Tailscale-User-Login` and `Tailscale-User-Name` from the registration.
It does this after every registered and dynamic injection, so a project
secret's rule that names one of these headers cannot override it.

The proxy answers 403 itself, without dialing, when the workspace has no
identity: a release, or a workspace registered before this shipped, which
gets one at its next restart.

So an app sees the same header from a person's browser and from that
person's agent, and cannot tell them apart. Marking agent requests is in
"Not in this plan".

### The reserved port

The egress proxy is now admitted to the router on 8081, and it also dials
whatever a workspace's allowlist names. A project whose allowlist held an
exact entry for the router's address could otherwise CONNECT to
`<router>:8081` and send a request with any `Host` and any login. Policy
cannot tell that dial from the site route, since both come from the proxy.

So `resolveUpstream` takes the destination port and refuses a non-public
address on `SITE_ROUTER_TAILNET_PORT`, whatever the allowlist says. This is
the proxy-side twin of the ports its egress policy cuts on node addresses.
Only the site route, whose target the proxy names itself, dials that port.

The proxy's egress policy gains router pods on 8081, by selector.

## Setup

1. Pick the site domain and get a wildcard certificate for it into the
   Secret `yaac-site-tunnel-tailnet-tls`.
2. Create a Tailscale auth key for a tag (`tag:yaac-sites`), and grant the
   users who should reach sites access to that tag on 443, 80 and 53.
3. `TS_SITE_AUTHKEY=… yaac cluster install --site-domain apps.example.com`.
   Install keeps the key in a Secret, applies the tailnet pod, waits for
   it to join, and prints its tailnet address. A later install without
   the key keeps the Secret, and must name the same domain.
4. In the Tailscale admin console's DNS settings, add that address as a
   nameserver restricted to the site domain. Install prints this step;
   yaac holds no Tailscale API credential, so it cannot do it.

No Tailscale operator is involved, so this works whichever way the server
itself is fronted.

## Surfaces

- **No schema change and no new site option.** `#domain/sites` reads the
  site domain from the server's environment, which install sets on the
  Deployment, and derives each site's edge from its hostname.
- **Contract**: `SiteRoute.edge`; `WorkspaceRegistration.identity`; the
  tailnet pod's state beside the tunnel's, which is `absent` under
  `containerless`, where the site routes refuse first.
- **API**: a site entry carries its derived `edge`; `GET /site/edge`
  (`SiteEdgeStatus`) gains the site domain and the tailnet pod's state
  (absent, joining, no certificate, ready). No new route.
- **CLI**: `yaac cluster install --site-domain`, with its e2e-cli case.
  `yaac site create` takes no new option, and what it prints after
  creating depends on the edge: for a tailnet site, that it is one, its
  `https://` address, that only tailnet users reach it, and the tailnet
  pod's state when that is not ready, in place of the Cloudflare hostname
  to add. `site list` and `site show` print the edge.
- **Webapp**: the Sites section shows the site domain and the tailnet
  pod's state beside the tunnel's. The site form says which edge the
  hostname being typed belongs to, under the field and updating with it:
  a tailnet site, reached only by tailnet users, or a public one, on the
  internet once the tunnel routes it. With a site domain set, the field's
  hint shows a name under it. The note after creating follows the edge
  as the CLI's output does, and each site's row and the deploy dialog
  carry the edge. So the edge is in view while naming the site, after
  creating it and when deploying it, which is what stands in for an
  explicit choice: a hostname mistyped out of the site domain reads as
  public before anything is deployed.
- **Modules**: `cluster/site-edge.ts` (the tailnet pod's objects, the
  listener, the route tables, the policies), `policy-manifests.ts` (proxy
  egress), `egress/proxy-registration.ts` (`identity`), `#domain/sites`
  (the hostname rule and the derived edge), `k8s/tailgate`, and in
  `k8s/proxy`: `dispatch.ts` (the route and refusals), `mitm.ts` (the
  headers), `upstream.ts` (the reserved port).
- **Images**: `k8s/tailgate` is a build context like `k8s/proxy`: a
  self-contained package, npm-installed in the image, run through tsx,
  its tag a `contextHash()`, built and pushed by install, with its own
  `unit:` project. tailscaled's image joins the digest-pinned mirrors.
  Both get their rows in CLAUDE.md's package and image tables.

## `yaac cluster check`

The `sites` gate adds: a pod labelled as the tailnet pod must fail to
dial the server, the proxy's control port and a workspace that is not a
release, as the Cloudflare pods' and the router's probes must; a pod
labelled as a Cloudflare pod must fail to dial the router's 8081. With
the tailnet pod installed it reports one that has not joined or has no
certificate, and, where the checking machine is on the tailnet, a zone
that does not resolve to it.

## Testing

- **`unit:server`**, through `syncSites` against `fakeCluster`: a mixed
  list yields disjoint route tables. `#domain/sites`: the derived edge,
  the one-label rule, the refusal on a `local` install. Install: the
  tailnet pod's objects exist exactly with the key's Secret.
- **tailgate's own tests**, on real sockets with a fake tailscaled
  socket: a caller with a user is stamped and forwarded, forged headers
  are replaced, a caller without one gets a 403, the DNS answers only the
  zone, a changed certificate is served.
- **The proxy's tests**: a site-routed request is redirected and stamped;
  a forged login from the workspace and one from a project secret's rule
  are both overwritten; no identity is a 403 with no dial; plain HTTP to
  a site is refused; a non-public dial to 8081 is refused with and
  without an exact allowlist entry.
- **e2e**: one file with a release that echoes its request headers,
  published under a site domain in a server running in `tailnet` mode. A
  workspace's `curl https://<site>` returns its owner's login whatever
  header it sent; a workspace of a project that has not allowed the host
  is blocked; a CONNECT to the router's 8081 is refused; the hostname
  answers 404 on the public listener. No tier has a tailnet, so e2e does
  not run tailscaled. One case runs tailgate's image beside a stand-in
  for tailscaled's socket and sends it a request, so the image the global
  setup builds (`yaac-test-tailgate:<hash>`) is exercised as built.
- **By hand, on a real tailnet**: the tailnet pod joins, a browser resolves a
  site and gets the app with its own login, a tagged device gets a 403, a
  device off the tailnet resolves nothing, and the tailnet pod keeps its
  address across a restart.

## Phases

0. **The rename**, as its own change: `yaac-site-tunnel` to
   `yaac-site-tunnel-cloudflare`, with its compat ("Renaming the
   tunnel"). It touches the reference docs that name the old objects
   (docs/public-sites.md, docs/server-in-cluster.md).
1. **People.** The site domain, the tailnet pod, the tailnet listener with
   its rules, the policies, status. A tailnet site works in a browser.
2. **Agents.** The site route, `identity`, the stamping, the reserved
   port. Shipped together: the route without the reserved port is the
   forgery described above.
3. **The check gate and the reference docs**: this plan folds into
   docs/public-sites.md, with the proxy's half in
   docs/workspace-egress.md and the agent identity in docs/multi-user.md.

## Verify before building

Read from Tailscale's source at the pinned 1.102.4, not yet run: serve's
TCP forward sends a PROXY protocol header, userspace mode forwards UDP to
loopback, the local API has `whois`, and the state Secret records the
device's addresses. Still to check:

- A tailnet's split DNS accepts a tailnet address as the nameserver for
  a zone.
- tailgate can bind port 53 unprivileged (the `ip_unprivileged_port_start`
  sysctl), and tailscaled's local API admits a second container of the
  same uid.
- Envoy reads two RDS route tables from two files of one watched
  directory, and a route can require a header's presence.
- A WebSocket upgrade passes through the proxy's redirect path to a real
  upstream; only mocks, which do not speak it, use that path today.

## Not in this plan

- **Per-site access lists**: which users may reach a site (a router rule
  on the login) and which projects' workspaces may. With one pod the
  tailnet's ACLs cannot separate sites, so this is the first follow-up.
- **`ts.net` names and public DNS records** for tailnet sites. One device
  has one `ts.net` name, and a name per site would need a Tailscale
  Service or an operator proxy each.
- **Obtaining the certificate.** yaac reads the Secret; cert-manager or
  the admin fills it.
- **A second replica of the tailnet pod.** It would be a second device
  and address.
- **More than one site domain.**
- **Marking agent requests**, with a header naming the workspace. Both
  paths share one listener, so a person could send it too; an app could
  use it to attribute, never to authorize.
- **Discovery across projects.** `yaac-mama list` shows a site only to
  its own project's agents.
