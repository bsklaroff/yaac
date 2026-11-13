# Public sites

A **site** is a project's app published at a hostname, served by a locked,
supervised workspace called a **release**. A deploy starts a new release
with each of the site's repos at a commit, waits for it to be ready, points
the hostname at it and stops the old one. Sites exist only under the k8s
driver, on kind and on byo, with two edges: Cloudflare Tunnel publishes a
site on the internet, and a tailnet site under the install's site domain is
served only to its tailnet, each request carrying the caller's tailnet login
(see "Tailnet sites"). Everything behind the router is the same for both.
An edge that owns its own TLS and DNS is docs/plans/self-hosted-site-edge.md.

Under `containerless` every `/api/site` route answers `NOT_SUPPORTED`. A
containerless workspace runs unsandboxed with real credentials, so
publishing one would publish the host.

## Public traffic never reaches the yaac server

The server trusts network position. A request that names a loopback `Host`
and did not come through `tailscale serve` is the owner
(docs/remote-hosting.md), and the ingress policies are what make that safe
(docs/server-in-cluster.md "The ingress policy is the wall"). So public
traffic takes a path that never passes through the server's listener or
pod, and none of the pods on that path may dial the server. A server
restart or upgrade never drops a site either.

```
internet ─► Cloudflare ─► yaac-site-tunnel-cloudflare (cloudflared, outbound on 7844)
                              │
tailnet device ─► yaac-site-tunnel-tailnet (tailscaled + tailgate; see "Tailnet sites")
                              │
                              ▼
                          yaac-site-router (Envoy; a listener per edge, routes by Host)
                              │
                              ▼
                          Service yaac-site-<site id>  (headless, selects the live release)
                              │
                              ▼
                          release workspace pod :<port>  (gVisor, egress via the proxy)
```

The server only reconciles these objects. It is never on the data path.

## The edge

**Cloudflare Tunnel.** cloudflared dials out to Cloudflare on TCP/UDP 7844,
so the cluster needs no public IP, open port, load balancer or
certificate, on a laptop's kind cluster and on a byo cluster alike. TLS ends
at Cloudflare, and the tunnel encrypts the hop to cloudflared. DNS lives in
the user's Cloudflare zone.

**A router of our own.** The tunnel is remotely managed: the user creates
it in the Cloudflare dashboard and gives yaac its token. Every public
hostname in the dashboard points at the same origin, the router's Service
(`http://yaac-site-router:8080`; cloudflared runs in the router's
namespace). The router picks the site by `Host`. So yaac needs only the
tunnel token, never a Cloudflare API token, the routing is testable
without Cloudflare, and nothing in the dashboard can point the tunnel
anywhere but the router.

**Setup.**

1. In Cloudflare, create a tunnel and copy its token.
2. `CF_TUNNEL_TOKEN=… yaac cluster install`. Install keeps the token in a
   Secret and applies the tunnel and router. A later install without the
   token keeps the Secret.
3. For each site's hostname, add a public hostname to the tunnel with the
   router as its service. `yaac site create` prints what to enter.

**The tunnel's routes are the boundary.** yaac accepts any well-formed
hostname for a site, and the name is public as soon as a tunnel route
covers it. With one public hostname per site, a name goes live only once
the Cloudflare admin adds it, so the admin reviews each one. A wildcard
public hostname (`*.example.com`) or a catch-all rule pointing at the
router instead makes every name under it public the moment any admin of
the install creates a site on it, including names such as
`www.example.com` or `login.example.com` meant for something else. Only
admins publish sites (docs/multi-user.md "Roles"), so a wildcard is as
safe as the trust put in every admin; otherwise route one public hostname
per site.

**Objects.** The edge is install's, like the server fronting; what changes
with sites is the server's, under the `yaac` field manager
(`cluster/site-edge.ts`):

| Object | Applied by | What it is |
|---|---|---|
| Secret `yaac-site-tunnel-cloudflare` | install | the tunnel token |
| Deployment `yaac-site-tunnel-cloudflare` | install, only with the Secret | cloudflared, 2 replicas, `tunnel --no-autoupdate --metrics 0.0.0.0:2000 run`; ready (`/ready`) while it holds a connection to Cloudflare |
| Secret `yaac-site-tunnel-tailnet` | install | the tailnet tunnel's auth key and the site domain |
| Deployment `yaac-site-tunnel-tailnet`, its ServiceAccount, Role and serve-config ConfigMap; Secret `yaac-site-tunnel-tailnet-state` | install, only while that Secret holds both | tailscaled and tailgate, 1 replica; see "Tailnet sites" |
| Secret `yaac-site-tunnel-tailnet-tls` | the admin, or cert-manager | the site domain's wildcard certificate |
| Deployment + Service `yaac-site-router` | install | stock Envoy (the image netd pins), 2 replicas |
| the tunnels' and router's NetworkPolicies | install | see "Network policy"; their node-address halves are re-rendered when nodes change |
| ConfigMap `yaac-site-routes` | server | the router's route tables |
| Service and NetworkPolicy `yaac-site-<site id>`, per site | server | the headless Service selecting the live release, and the policy admitting the router to it |

Every edge Deployment runs at the `yaac-infra` priority. Without a token the
router is still applied, so the e2e harness and the self-hosted edge use
it. The e2e harness applies it beside the server Deployment it deploys per
file.

**The router.** It has a static listener per edge, 8080 for public sites
and 8081 for tailnet ones. Each reads its own route table, the routes
ConfigMap's `rds.json` and `rds-tailnet.json`, and both share its CDS
file, all read through Envoy's filesystem dynamic config with
`watched_directory`, which picks up a ConfigMap's atomic symlink swap
without restarting Envoy or draining a listener, so adding a site never
cuts another site's WebSockets. A site is a virtual host only in its own
edge's table, so no `Host` the Cloudflare tunnel could be configured to
send reaches a tailnet site. Each site is a virtual host
for its hostname whose cluster is its Service by absolute name, resolved as
`STRICT_DNS` every second. The Service is headless, so the name resolves to
the live release's pod IP. A ClusterIP would hide a flip from Envoy: pooled
keep-alive connections to it stay pinned to the old pod by conntrack. With
pod IPs, new requests move as soon as DNS changes, and connections to the
old release finish. Where CoreDNS answers `cluster.local` names without
its cache (kind and the `infra/` clusters; docs/cluster-setup.md "Uncached
cluster DNS"), the router sees a flip within about a second. An unknown
`Host` gets a 404 and a site with no live release a 503. WebSocket upgrades
are on and the route timeout is off.
Envoy appends to `X-Forwarded-For`, trusting the tunnel in front (cloudflared
or tailgate) as one hop.

The kubelet can take up to about a minute to deliver a ConfigMap change,
so a new site routes within a minute. Only site create, edit and delete
change the table; a deploy changes the Service's selector.

## Tailnet sites

A site whose hostname is under the install's **site domain** (a DNS zone
its admin owns, `apps.example.com`, given to `yaac cluster install
--site-domain`) is a tailnet site; any other is public. There is no edge
setting: the hostname says which, `siteEdgeOf` in `@yaac/shared/site-edge`
derives it for the server, the CLI and the webapp, and every site entry
carries it. A tailnet site's hostname must be exactly one label under the
domain, which is what a wildcard certificate covers, and needs a `tailnet`
install (docs/remote-hosting.md "Access modes"), since a `local` one has no
logins to stamp. It is published under the same roles as a public site.

The domain is kept with the tunnel's auth key in the Secret
`yaac-site-tunnel-tailnet`, as the Cloudflare tunnel's Secret keeps its
token, and install sets it on the server Deployment from there, so a later
install need not name `--site-domain` again. Without that record, a re-run
that left the flag out would drop the domain and turn every tailnet site
public. A domain needs an auth key the first time, and a key needs a
domain, so install refuses a run that would leave the tunnel with only one.

Once recorded, the domain is fixed: install refuses another, since a site's
edge follows from its hostname, and a new domain would turn the old one's
tailnet sites public and pull any public site under the new one onto the
tailnet. To change it, move or delete the sites under the old domain,
delete the Secret, and install with the new domain and an auth key.
Deleting the Secret alone removes the domain and the tunnel.

The app decides what a login may do. yaac only guarantees that the
`Tailscale-User-Login` header a tailnet site receives is true.

**The names resolve only on the tailnet.** The tailnet's split DNS sends
the zone to the tailnet tunnel, which answers every name under it with its
own tailnet address. No site has a record in public DNS. The zone must still
be a real domain, because browsers trust only certificates a public
authority issued, which a DNS-01 challenge proves ownership for.

**The tailnet tunnel** (`yaac-site-tunnel-tailnet`) is one pod with one
replica, since it is one tailnet device with one address; while it
restarts no tailnet site answers. A site adds nothing to it, to Tailscale
or to DNS. Install applies it only once given an auth key
(`TS_SITE_AUTHKEY`, kept in the Secret with the domain, so a later install
without either keeps the tunnel), waits for it to join and prints its
tailnet address. Neither container has privilege:

- **tailscaled** is Tailscale's stock image, digest-pinned and mirrored like
  cloudflared, in userspace networking mode. It joins once as a tagged
  device and keeps its state in the Secret `yaac-site-tunnel-tailnet-state`,
  so the device and its address survive a restart. It runs as uid 1000 and
  is the only container given an API token, by a projected volume, whose
  Role may write only that Secret. Its serve config forwards 443 and 80 to
  tailgate as raw TCP behind a PROXY v1 header naming the caller's tailnet
  address, and userspace mode delivers every other port of the device, 53
  among them, to the same port on 127.0.0.1.
- **tailgate** (`k8s/tailgate`, an image of yaac's own, shares nothing with
  the egress proxy, so a proxy change never rolls the tunnel) runs as uid
  1001, so tailscaled's local API, which gives write access to a peer of its
  own uid, gives tailgate only reads. It answers A
  and AAAA for every name under the zone with the device's addresses and
  refuses other names, binding 53 through the `ip_unprivileged_port_start`
  sysctl. Its 443 and 80 listeners bind 127.0.0.2, where serve forwards and
  the forward of other ports never dials, so the PROXY header they believe
  can only have come from serve: a peer dialing the device's 8443 directly
  reaches nothing. The tailnet ACL's port list (below) is defence in depth,
  not what identity depends on. On 443 it ends TLS with
  `yaac-site-tunnel-tailnet-tls`, reloading it when the Secret changes and
  the new certificate matches its key, and asks tailscaled's local API who
  holds the caller's address. A caller with no user (a tagged device, or an
  address the tailnet does not know) gets a 403. Otherwise it drops every
  `Tailscale-*` and `X-Forwarded-*` header the client sent (app
  capabilities included), sets
  `Tailscale-User-Login`, `Tailscale-User-Name` (Q-encoded when not
  ASCII, as Tailscale's own proxies do), `X-Forwarded-For` and
  `X-Forwarded-Proto: https`, and forwards the request, its body still
  framed, to the router's 8081 with `Host` unchanged. An upgrade's two
  connections are joined only once the router answers 101; any other answer
  is relayed and the connection closed. On 80 it redirects to
  `https://`. It holds no list of sites: a name no site has resolves, and
  the router answers 404.

**The certificate** is a wildcard for the site domain in the Secret
`yaac-site-tunnel-tailnet-tls`, which yaac neither obtains nor renews. The
admin creates it by hand, or points a cert-manager Certificate at that name
with a DNS-01 issuer, the only challenge that works for names the internet
cannot reach. Without it tailgate is not ready, and install, `GET
/site/edge` and the check say so.

**The router's tailnet listener** answers 403 to a request without
`Tailscale-User-Login` (an RBAC filter), so an app sees only requests with
a login, whatever sent them. The public listener drops the
`Tailscale-User-Login`, `-Name`, `-Profile-Pic`, `Tailscale-App-Capabilities`
and `Tailscale-Headers-Info` request headers (Envoy removes headers only by
name), so an app written for the tailnet edge and published on the public
one by mistake sees no identity or capability rather than one the internet
chose.

**Who may reach a site.** Every tailnet site is behind one device, so the
tailnet's ACLs decide who reaches the tunnel, not which site: a grant to its
tag on TCP 443 and 80 and on port 53 admits a user to all of them. Telling
sites apart is the app's job.

**Agents** reach a tailnet site at the same URL and act as their
workspace's owner: the egress proxy carries the request to the router's
8081 and stamps the project owner's login, if the project's allowlist names
the host or the zone; `*` does not count (docs/workspace-egress.md "Tailnet sites",
docs/multi-user.md "Credentials"). An app cannot tell a person's request
from their agent's. A release has no identity, so its requests to a tailnet
site are refused.

**Setup.**

1. Pick the site domain and put a wildcard certificate for it in the
   Secret `yaac-site-tunnel-tailnet-tls`.
2. Create a Tailscale auth key for a tag (`tag:yaac-sites`), and grant the
   users who should reach sites access to that tag on 443, 80 and 53.
3. `TS_SITE_AUTHKEY=… yaac cluster install --tailnet --site-domain
   apps.example.com`.
4. In the Tailscale admin console's DNS settings, add the address install
   prints as a nameserver restricted to the site domain. yaac holds no
   Tailscale API credential, so it cannot do this itself.

No Tailscale operator is involved, so this works whichever way the server
itself is fronted.

## Network policy

None of these adds a peer to the server's ingress, which admits no pod.

- **Cloudflare tunnel**: egress to public addresses on TCP and UDP 7844
  only, DNS, and the router's 8080. Ingress only from node addresses on its
  metrics port, for the kubelet's probe.
- **Tailnet tunnel**: egress to public addresses on any port (Tailscale's
  coordination and relay servers, and peers; one on a private address is
  reached through a relay, since the floor cuts those ranges), DNS, the
  router's 8081, and the apiserver for tailscaled's state Secret. Ingress
  only from node addresses on its two health ports; tailnet traffic arrives
  inside connections tailscaled dialed out.
- **Router**: ingress from Cloudflare tunnel pods on 8080, from tailnet
  tunnel pods and the egress proxy (see "Agents") on 8081, and from node
  addresses on its readiness port. Egress to DNS and to pods labelled
  `yaac.site-id`.
- **Per site**: pods labelled `yaac.site-id=<id>` admit router pods on the
  site's port. Every release of the site carries the label from launch, so
  the policy does not change across deploys. It is unioned with the
  workspace ingress lock, which still admits the proxy on streamd's port.

A compromised release reaches what any workspace reaches over the network:
its egress goes through the proxy and its allowlist. It cannot dial the
router, the tunnel, other releases or the server. Nor can it write where
other workspaces of the project read (see "Sites and releases"), bar its
own step logs: the project's agents read those with `yaac-mama logs`, so
whatever a release prints, including what the internet got it to print,
reaches their context as untrusted text.

`yaac cluster check`'s `sites` gate holds probe pods carrying each tunnel's
and the router's labels to the same policies, and requires that they fail
to dial the server's API, the proxy's control port and a workspace pod that
is not a release, and the Cloudflare one the router's 8081. With a
Cloudflare tunnel installed it reports whether it is connected; with a
tailnet one, whether it has joined and holds a certificate, and, where the
checking machine is on the tailnet, whether the zone resolves to it.

## Sites and releases

A site belongs to a project. Its owner creates, edits, deploys and starts
it only while an admin of the install (docs/multi-user.md "Roles"); its
owner, admin or not, and any admin may stop and delete it, so a site can
always be taken down; and every user may list and view it
(docs/multi-user.md "Authorization"). Demoting an owner stops nothing:
their live releases keep serving and are still supervised, but they
cannot deploy again. A hostname is unique in the install,
and may be any name: only names the tunnel routes ever reach the router,
so which are public is decided in the Cloudflare account, by whoever
administers it (see "The edge" for why that means one route per site).
yaac holds no Cloudflare API token, so it cannot check that a site's
hostname is routed. Within the install a hostname is first come, first
served: once a site
lets one go (deleted, or edited to another), any admin may create a site
on it, and the tunnel already routes it, so admins who share an install
share its hostnames too.

A site names its hostname, the port its releases serve on, the named
workflow each release runs (docs/workflows.md), its repos (`sites.repos`),
optionally a volume, which no other site may name and which cannot be
deleted while named, and whether it follows (see "Following").

**Repos.** A site names at least one repo, each at a branch on origin or at
a full commit, given when the repo is added. Nothing falls back to a default
branch: which branch is published is the owner's choice, and a default
branch renamed on the remote would otherwise change what the site serves.
The layout follows from the count, as for any workspace: one repo sits at
the release's root, several in their folders. A site has no cwd of its own:
a release runs no agent, and its workflow says where its steps start
(docs/workflows.md "Repos"). The site's repos must include every repo its
workflow names. Every branch named is checked as for following: on origin
now, and not `origin/…`, `refs/…` or `agent/…`.

Editing the hostname moves it at once; the port, workflow, volume and repos
apply from the next deploy, and an edit is refused while a deploy runs. "Built
from a repo" means named in the site's repos or in the commits its last
release ran: unlinking or deleting such a repo is refused, and so is
renaming the folder of one a site of several repos keeps in its folder,
since a replacement is a fresh checkout under the folder's current name and
the steps name folders.

A **release** is a workspace with `workspaces.siteId` set, started by a
deploy with each repo at a commit. It differs from an ordinary workspace in
these ways:

- **Locked.** `assertInteractive` refuses it: no sessions, terminals, added
  steps, file writes or allow-host, and no forward but to its admin port
  (see "Admin port"). Workspace stop,
  restart and timeout refuse it with `CONFLICT` naming `yaac site`; only
  the server stops one, unless its site no longer names it (a stop that
  failed, a site deleted under it), when its owner may. `yaac-mama` has no
  site verbs, so an agent can neither deploy nor stop production, except
  by pushing to a branch a following site names (see "Following"). It can
  watch one: `yaac-mama list` shows each release with its site, whether
  the hostname points at it, the site's address and its commits, and
  `yaac-mama logs` reads its steps' logs.
- **Mounts nothing shared.** It runs no agent and faces the internet, so it
  gets only its own checkout, the main clone's `.git` read-only, its own
  step logs, the tmux socket dir and the staged helper commands: no tool
  home, history, skill, shared memory or `cacheVolumes`, nothing it could
  poison for the project's dev workspaces.
- **Cut off from the server.** It may send nothing to `yaac.internal`, which
  carries `yaac-mama` and git to a hosted project's remote, and needs
  neither, since the server makes its checkout. The proxy answers 403 to a
  pod labelled `yaac.site-id` (`k8s/proxy/pod-watch.ts`), so a site never
  opens a connection into the server process, and the server's yaac-mama
  listener refuses a workspace whose row has `siteId`. Each check is enough
  alone. streamd is unaffected: the server dials it to drive the release.
- **No credentials.** Its egress registration names an owner key no user's
  credentials are pushed under (`NO_CREDENTIALS_OWNER_KEY`), so the proxy
  swaps in no tool, git or ssh credential, and the launch hands it no git
  credential either, so a project needs none to deploy. The project's
  environment and secrets apply as for any workspace, and the run secrets
  its workflow names arrive as their real values (docs/workflows.md), for
  a key the app signs with: its owner's deploy approves the commits, and
  setting it to follow its branches and commits.
- **One image.** A deploy records the image its release launched, and every
  replacement launches that image again, so a release never changes under
  a later image config edit. The registry GC keeps a site's images though
  nothing runs them (docs/image-gc.md).
- **Long-running.** No timeout, never a prewarmed spare. Its graph needs a
  service, and it is ready once every other step has succeeded and every
  service is ready.
- **Outranks dev workspaces.** The `yaac-release` PriorityClass sits
  between workspaces and builders, so node pressure evicts dev workspaces
  first. It never preempts one.

**Supervision**, at two levels:

- **The serving release's service that exits opens again** in its window,
  after a backoff from 1 s to 5 min that resets once it ran 10 minutes,
  and its log keeps the crash above the new run. In a deploy's new
  release, a service that exits fails the deploy at once.
- **A live release whose runtime is gone** (an evicted pod, a node restart)
  is replaced, not restarted: a deploy of the same commits and image, with
  the graph, volume, port and repo layout that release ran rather than edits
  made since,
  whose release is `rerunOf` the dead one, in a fresh checkout, as a
  Deployment replaces a failed pod from its spec. The dead release keeps its logs and
  its volume lease is taken over. Replacements back off the same way while
  each new one dies within 10 minutes of taking the hostname.

**Host reboots.** A reboot leaves kind's node containers stopped
(docs/cluster-setup.md "After a restart"). Install gives them a restart
policy where this podman supports one and asks for the engine's restart
service on Linux, so the cluster, then the server, then the replacements
come back without a command. On macOS the podman machine is not covered.

## Admin port

A site may name an **admin port**, for an admin view of the live app that
needs no login of its own. It is the one port a release offers
(`offeredForwards`), declared at launch and again when a server restart
declares forwards anew; the project's forwarded ports and a persisted
"forward this port" fan-out skip releases. So the site's owner reaches it
the way they reach any workspace's port, as the release's Preview in the
webapp or with `yaac forward`, and the yaac server's own owner check
(`/forward/attach`) is its whole access control. `assertInteractive` lets
forwards into a release through on that ground: the driver's `dialPort`
dials no port a workspace does not offer.

The router never serves it, and the per-site policy admits the router only
on the site's port, so the internet cannot reach it. An admin port equal to
the site's port is refused. The admin server runs
as another service step of the release, in the same pod, so it can share
the volume. It cannot open an embedded database another process holds
(PGlite, SQLite without WAL); serve the admin routes from the app's own
process on a second listener, or keep the data in a Postgres service step.

An edit moves the admin port at once: the running releases stop offering
the old one, so new connections to it are refused, and offer the new one.
A restart then declares what the site names, which is what the edit
already offered. Only a release started since listens on a new port. Each
deploy is a new workspace, so the Preview to open is the live release's,
which the site's row in project settings links to.

## Deploys

A deploy is a state on the site's row, advanced by the `sites` reconcile
step on workspace and window changes, when a step of a release changes
state, and when a drain or backoff is due,
so a server restart mid-deploy resumes it. Every change to a site's row
(a deploy's start, an edit, a stop or delete, the reconcile) holds the
site's lock, and a stop or delete ends what the site runs before letting
go of it, so no release outlives the row that names it. A release is
forgotten only once its stop succeeds, so a failed stop is retried.

1. **Launch.** Resolve a commit per repo (the ref the deploy names for it,
   else its setting: its branch's tip on origin, or its commit) and start a
   release there, titled with them (`shop @ 1a2b3c4d` for one repo at the
   root, `shop @ web@1a2b3c4d api@5e6f7a8b` otherwise).
2. **Build.** The release runs the steps that do not need the volume.
3. **Hand over** (sites with a volume; see below).
4. **Ready.** Wait for every step, up to the deploy's timeout (15 minutes
   unless it names one).
5. **Flip.** Write the site Service's selector, in one write. The router
   sees the new pod at its next DNS refresh, a second later where cluster
   DNS is uncached.
6. **Drain.** Keep the old release for 30 s, which covers that refresh and
   lets in-flight requests finish, then stop it. Its app gets `SIGTERM`
   first. A flip while an earlier drain is under way stops that release at
   once.

A deploy that fails or times out stops its release, which keeps its logs,
and the site keeps the release it had. A second deploy while one runs is a
`CONFLICT`, unless it is of the same commits (equal maps over the same
repos), when it is that deploy, with that deploy's deadline. Rolling back is
deploying earlier commits; `yaac site show` lists recent releases with their
commits. `yaac site stop` stops the live release and the router answers
503; `yaac site start` deploys the last release's commits and image again,
in its layout. Without a volume, a flip has no gap.

What a release ran is kept per repo, by repo id, in four maps on the site's
row (`releaseCommits`, `deployCommits`, `lastDeployCommits`,
`failedCommits`), so a deploy stays one compare-and-set and single-row
patches, and the record survives an edit that takes a repo off the site.

### Following

A site may follow (`--follow`): while it serves, the `sites` reconcile step
computes its **target**, each repo's branch tip in its main clone or the
commit it names, and deploys it whenever it differs from what the site
serves and from what last failed, as its project's owner, and only while
that owner is an admin. While they are not, following is paused, and `site
show` and the webapp say so. A repo at a commit never moves, so following
some repos and not others is naming a commit for the others; the flag is
the site's rather than each repo's, so what a site serves reads off its
settings.

The step runs after every fetch of any repo, so a push to a hosted project
deploys within seconds, and any other remote within the five-minute origin
refresh (docs/server-git.md), which fetches every repo a running workspace,
a live release included, has a checkout of. Before a follow deploy starts,
each of the site's repos at a branch must have been fetched by a fetch that
started after the step first saw this target; one that was not is fetched
in the background, whose landing runs the step again, so the pass never
waits on the network and a refresh, whose fetches land at different times,
deploys once rather than once per repo that moved. Measured from each
fetch's start, it converges however long fetches take. A fetch that failed
counts for the whole refresh period, so a remote that is down holds the
others up only that long; its repo deploys at its last fetched tip, which
`releaseCommits` shows. Pushes to two repos seconds apart can still deploy the first
without the second, then both: a change that spans repos must work in that
order, or the site is taken off `follow` while it lands. Public traffic
never reaches the server, so there are no webhooks. A push during a deploy
is deployed once that deploy ends.

A target whose deploy fails is not tried again: the site keeps serving the
last release that worked, as after any failed deploy, until a branch moves
on or the owner deploys by hand, and `site show` names the commits it is
not retrying. That matters most with a volume, where each attempt takes the
site down for the handoff. A failure after the handoff leaves the old
release replaced at its own commits, against what the migration left (see
"Migrations").

**Whoever may push a branch the site names publishes the site.** That
includes the project's agents, which push with its credential, and on a
hosted project every workspace of it and of every share of it, since a push
fans out to each. yaac does not stop them: the branch's protection is the
remote's to set. A hosted remote has none beyond the default-branch guard,
and agents land work by pushing to the default branch
(docs/hosted-projects.md), so follow a branch there only if an agent
publishing is acceptable. A person setting a site to follow, or changing the
repos or workflow of a following site, approves each branch and each commit
it names for the run secrets of its workflow, refused before anything is
written; a follow deploy runs as the server and passes on those. So whoever
may push a branch gets those values too, and can print them into the
release's step logs, which the project's agents read (docs/workflows.md
"Run secrets"); on a hosted repo shared with another user, that includes
them.

A branch must exist on origin when it is named, by its own name: one that
reads as a ref (`origin/main`, `refs/heads/main`) would follow a branch so
named, which anyone who may push could create, and `agent/*` branches are
each one workspace's, so all three are refused.

A following site deploys only its target: `site deploy` without `--ref`
deploys it, and a deploy naming any other ref is a `CONFLICT`, since the
next pass would deploy the target over it. To roll back, stop following
(`--no-follow`), then deploy the commits. Stopping following publishes
nothing, so it is taken mid-deploy too, and from anyone who may stop the
site. A stopped site follows nothing until it is started.

### Volumes: a staged handoff

A volume keeps its one-holder lease (docs/workspace-volumes.md "The
lease"). Two releases writing at once is not safe, even on one node:
gVisor keeps file locks inside each sandbox, so two pods' SQLite cannot see
each other's locks, and Postgres reads another pod's `postmaster.pid` as
stale. So a deploy relaxes mounting, not writing:

- A pod's mounts are fixed at launch, so the new release is created with
  the volume mounted while the old one still holds the lease, recorded as
  its next holder (`volumes.nextHolderWorkspaceId`). Only a deploy stages a
  volume, and a staged volume counts as held: every other launch gets
  `VOLUME_HELD` until the release takes it or is gone.
- The graph names `volume` in `needs` for the steps that use it. It is no
  step of its own: it counts as succeeded once the release holds the
  lease. Only the steps that wait on it are told `YAAC_VOLUME_DIR`.
- Once the other steps are done, the deploy stops the old release, waits
  for its pod to go, passes the lease, and the volume's steps start. A
  release's stop skips the ignored-file clean other stops do first, so the
  old release serves intact until it is signalled. A volume held by
  anything but a release of this site fails the deploy.
- On byo a volume is its own ReadWriteOnce claim, so the new release is
  pinned to the old one's node by name; while the old one has no node yet,
  the deploy fails rather than risk the attach.

The site is down from the old release's stop until the flip: its shutdown
plus the app's start, not its build. If the new release fails after the
handoff, the old one is gone, so the site replaces it, and the replacement
takes the volume back once the failed release's pod is gone.

### Migrations

A migration is a step between the database and the app, and runs after the
handoff, when no old code runs:

```jsonc
{
  "install": { "run": "pnpm install --frozen-lockfile" },
  "build":   { "run": "pnpm build", "needs": ["install"] },
  "db":      { "run": "postgres -D $YAAC_VOLUME_DIR/pg", "service": true,
               "needs": ["volume"], "ready": "pg_isready" },
  "migrate": { "run": ["pg_dump -Fc -f $YAAC_VOLUME_DIR/pre-deploy.dump",
                       "pnpm db:migrate"], "needs": ["db", "build"] },
  "server":  { "run": "pnpm start --port 3000", "service": true,
               "needs": ["migrate"], "ready": "curl -sf localhost:3000/health" }
}
```

If the migration fails, so does the deploy, and the release that replaces
the old one runs against what the migration left. A tool that wraps each
migration in a transaction leaves the old schema; otherwise the dump is the
way back. A replacement reruns the graph, so
the migration runs again and must find nothing to do. Deploys of a site
never overlap, so migrations never race. A rollback does not undo a schema.

## Surfaces

- **API**: `/api/site/edge`, `/list`, `/show` (readers), `/create`,
  `/edit`, `/deploy`, `/start` (the project's owner, while an admin) and
  `/stop`, `/delete` (the project's owner, or any admin). `/create` and
  `/edit` take `repos` (each a folder or id at a branch or commit; on edit
  the whole list) and `follow`; `/deploy` takes `refs` (folder or id to
  branch or commit) beside `ref`, the form for a site of one repo. Commits
  are answered per repo, `{ dir, commit }`.
  `/edge` answers both tunnels' state and the site domain, and every site
  entry its edge.
- **CLI**: `yaac site create|edit|list|show|deploy|stop|start|delete`, the
  project first, and `yaac cluster install` for the tunnels and
  `--site-domain` (docs/cli.md). What `site create` prints follows the
  edge: the Cloudflare route to add, or the `https://` address and what the
  tailnet tunnel still lacks. `list` and `show` print the edge.
- **Webapp**: a Sites section in project settings, with both tunnels' state
  and the site domain at its top, a form with a row per repo (include,
  branch or commit, starting empty) and a Follow switch, and a deploy
  dialog with a ref per repo. The edge is in view while naming a site (a
  line under the form that follows the hostname being typed), after
  creating it, on its row and when deploying it, which is what stands in
  for an explicit choice: a hostname mistyped out of the site domain reads
  as public before anything is deployed. A release's workspace view is
  read-only, with "release of `<site>`" on its header.
- **Modules**: `#domain/sites` (settings, the hostname rule, deploys,
  supervision), `cluster/site-edge.ts` (every edge object), the `sites`
  reconcile step, `k8s/tailgate`, and in `k8s/proxy` the site route.

## Not yet

- **One-time hostname setup.** Each site's hostname is added to the tunnel
  by hand. A wildcard (`*.example.com`) would cover them all, if a
  remotely-managed tunnel takes one (Cloudflare's docs do not say), but
  it would also let every admin of the install publish any name under the
  zone.
- **A release's own egress allowlist.** A release uses its project's.
- **Per-site access lists** for tailnet sites: which users may reach a site
  (a router rule on the login) and which projects' workspaces may. One
  device means the tailnet's ACLs cannot separate sites.
- **`ts.net` names** for tailnet sites, which would need a Tailscale
  Service or operator proxy per site, a **second replica** of the tailnet
  tunnel (a second device and address), and **more than one site domain**.
- **Marking agent requests** to a tailnet site with a header naming the
  workspace. People and agents share one listener, so a person could send
  it too; an app could use it to attribute, never to authorize.
- **A stateful deploy with no gap**, which needs the state in a long-lived
  workspace that releases reach over the network.
