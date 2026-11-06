# Public sites

A **site** is a project's app published on the public internet at a
hostname, served by a locked, supervised workspace called a **release**. A
deploy starts a new release at a commit, waits for it to be ready, points
the hostname at it and stops the old one. Sites exist only under the k8s
driver, on kind and on byo, with Cloudflare Tunnel as the edge. An edge
that owns its own TLS and DNS is docs/plans/self-hosted-site-edge.md.

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
internet ─► Cloudflare ─► yaac-site-tunnel (cloudflared, outbound on 7844)
                              │
                              ▼
                          yaac-site-router (Envoy; routes by Host)
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
| Secret `yaac-site-tunnel` | install | the tunnel token |
| Deployment `yaac-site-tunnel` | install, only with the Secret | cloudflared, 2 replicas, `tunnel --no-autoupdate --metrics 0.0.0.0:2000 run`; ready (`/ready`) while it holds a connection to Cloudflare |
| Deployment + Service `yaac-site-router` | install | stock Envoy (the image netd pins), 2 replicas |
| the tunnel's and router's NetworkPolicies | install | see "Network policy"; their node-address halves are re-rendered when nodes change |
| ConfigMap `yaac-site-routes` | server | the router's route table |
| Service and NetworkPolicy `yaac-site-<site id>`, per site | server | the headless Service selecting the live release, and the policy admitting the router to it |

Both Deployments run at the `yaac-infra` priority. Without a token the
router is still applied, so the e2e harness and the self-hosted edge use
it. The e2e harness applies it beside the server Deployment it deploys per
file.

**The router.** Its listener is static; the route table is the routes
ConfigMap's RDS and CDS files, read through Envoy's filesystem dynamic
config with `watched_directory`, which picks up a ConfigMap's atomic
symlink swap without restarting Envoy or draining the listener, so adding
a site never cuts another site's WebSockets. Each site is a virtual host
for its hostname whose cluster is its Service by absolute name, resolved as
`STRICT_DNS` every second. The Service is headless, so the name resolves to
the live release's pod IP. A ClusterIP would hide a flip from Envoy: pooled
keep-alive connections to it stay pinned to the old pod by conntrack. With
pod IPs, new requests move as soon as DNS changes, and connections to the
old release finish. An unknown `Host` gets a 404 and a site with no live
release a 503. WebSocket upgrades are on and the route timeout is off.
Envoy appends to `X-Forwarded-For`, trusting cloudflared as one hop.

The kubelet can take up to about a minute to deliver a ConfigMap change,
so a new site routes within a minute. Only site create, edit and delete
change the table; a deploy changes the Service's selector.

## Network policy

None of these adds a peer to the server's ingress, which admits no pod.

- **Tunnel**: egress to public addresses on TCP and UDP 7844 only, DNS, and
  the router's port. Ingress only from node addresses on its metrics port,
  for the kubelet's probe.
- **Router**: ingress from tunnel pods on 8080, and from node addresses on
  its readiness port. Egress to DNS and to pods labelled `yaac.site-id`.
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

`yaac cluster check`'s `sites` gate holds probe pods carrying the tunnel's
and the router's labels to the same policies, and requires that they fail
to dial the server's API, the proxy's control port and a workspace pod that
is not a release. With a tunnel installed it reports whether it is
connected.

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

A share whose source's owner removed it (docs/hosted-projects.md
"Sharing") runs nothing: its sites are not routed or supervised, and its
owner may still stop or delete them to free their hostnames.

A site names its hostname, the port its releases serve on, the step graph
each release runs (stored on the site, like a routine's), and optionally a
volume, which no other site may name and which cannot be deleted while
named, and a branch to follow (see "Following a branch"). Editing the
hostname moves it at once; the port, graph and volume apply from the next
deploy, and an edit is refused while a deploy runs.

A **release** is a workspace with `workspaces.siteId` set, started by a
deploy at one commit. It differs from an ordinary workspace in these ways:

- **Locked.** `assertInteractive` refuses it: no sessions, terminals, added
  steps, file writes or allow-host, and no forward but to its admin port
  (see "Admin port"). Workspace stop,
  restart and timeout refuse it with `CONFLICT` naming `yaac site`; only
  the server stops one, unless its site no longer names it (a stop that
  failed, a site deleted under it), when its owner may. `yaac-mama` has no
  site verbs, so an agent can neither deploy nor stop production, except
  by pushing to a branch a site follows (see "Following a branch"). It can
  watch one: `yaac-mama list` shows each release with its site, whether
  the hostname points at it, the site's address and its commit, and
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
  that name the site arrive as their real values (docs/project-config.md
  "Run secrets"), for a key the app signs with.
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
  is replaced, not restarted: a deploy of the same commit and image, with
  the graph, volume and port that release ran rather than edits made since,
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
step on workspace and window changes and when a drain or backoff is due,
so a server restart mid-deploy resumes it. Every change to a site's row
(a deploy's start, an edit, a stop or delete, the reconcile) holds the
site's lock, and a stop or delete ends what the site runs before letting
go of it, so no release outlives the row that names it. A release is
forgotten only once its stop succeeds, so a failed stop is retried.

1. **Launch.** Resolve the ref (a branch on origin, unless named the one
   the site follows or else the project's default, or a full commit) and
   start a release there.
2. **Build.** The release runs the steps that do not need the volume.
3. **Hand over** (sites with a volume; see below).
4. **Ready.** Wait for every step, up to the deploy's timeout (15 minutes
   unless it names one).
5. **Flip.** Write the site Service's selector, in one write. The router
   sees the new pod at its next DNS refresh.
6. **Drain.** Keep the old release for 30 s, which covers that refresh and
   lets in-flight requests finish, then stop it. Its app gets `SIGTERM`
   first. A flip while an earlier drain is under way stops that release at
   once.

A deploy that fails or times out stops its release, which keeps its logs,
and the site keeps the release it had. A second deploy while one runs is a
`CONFLICT`, unless it is of the same commit, when it is that deploy, with
that deploy's deadline. Rolling back is deploying an earlier commit;
`yaac site show` lists recent releases. `yaac site stop` stops the live
release and the router answers 503; `yaac site start` deploys the last
release's commit and image again. Without a volume, a flip has no gap.

### Following a branch

A site may follow a branch on origin (`--follow <branch>`): while it
serves, the `sites` reconcile step deploys the branch's tip whenever it is
not the commit the site serves, as its project's owner, and only while
that owner is an admin. While they are not, following is paused, and
`site show` and the webapp say so. The step runs after every fetch of the
project's origin, so a push to a hosted project deploys within seconds,
and any other remote within the five-minute origin refresh
(docs/server-git.md), which fetches every project with a running
workspace, a live release included. Public traffic never reaches the
server, so there are no webhooks. A push during a deploy is deployed
once that deploy ends.

A tip whose deploy fails is not tried again: the site keeps serving the
last release that worked, as after any failed deploy, until the branch
moves on or the owner deploys it by hand, and `site show` names the tip
it is not retrying. That matters most with a volume,
where each attempt takes the site down for the handoff. A failure after the
handoff leaves the old release replaced at its own commit, against what
the migration left (see "Migrations").

**Whoever may push the branch publishes the site.** That includes the
project's agents, which push with its credential, and on a hosted project
every workspace of it and of every share of it, since a push fans out to
each. yaac does not stop them: the branch's protection is the remote's to
set. A hosted remote has none beyond the default-branch guard, and agents
land work by pushing to the default branch (docs/hosted-projects.md), so
follow a branch there only if an agent publishing is acceptable.

The branch must exist on origin when it is named, by its own name: one
that reads as a ref (`origin/main`, `refs/heads/main`) would follow a
branch so named, which anyone who may push could create, and `agent/*`
branches are each one workspace's, so all three are refused.

A following site deploys only the branch's tip: `site deploy` without
`--ref` deploys it, and a deploy of any other ref is a `CONFLICT`, since
the next pass would deploy the tip over it. To roll back, stop following
(`--no-follow`), then deploy the commit. Stopping following publishes
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
  `/stop`, `/delete` (the project's owner, or any admin).
- **CLI**: `yaac site create|edit|list|show|deploy|stop|start|delete`, the
  project first, and `yaac cluster install` for the tunnel (docs/cli.md).
- **Webapp**: a Sites section in project settings, with the tunnel's state
  at its top; a release's workspace view is
  read-only, with "release of `<site>`" on its header.
- **Modules**: `#domain/sites` (settings, deploys, supervision),
  `cluster/site-edge.ts` (every edge object), the `sites` reconcile step.

## Not yet

- **One-time hostname setup.** Each site's hostname is added to the tunnel
  by hand. A wildcard (`*.example.com`) would cover them all, if a
  remotely-managed tunnel takes one (Cloudflare's docs do not say), but
  it would also let every admin of the install publish any name under the
  zone.
- **A release's own egress allowlist.** A release uses its project's.
- **A stateful deploy with no gap**, which needs the state in a long-lived
  workspace that releases reach over the network.
