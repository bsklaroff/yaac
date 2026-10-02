# The server in the cluster

Under the `k8s` driver the yaac server is a single-replica Deployment inside
the cluster it manages. `yaac cluster install` applies it, and clients reach
it at a fixed origin: loopback on kind, or a tailnet name.

It runs as a pod so that the server and workspace pods can mount the same
storage. A host process can share files with pods only through hostPath and
the assumption that the node is the host. A pod can mount a claim, and this
one mounts two (see "Storage is two claims").

## What install deploys

`yaac cluster install` ends with these steps, in this order:

1. **Stop the running server pod**, if there is one, and build and push the
   server image.
2. **The two storage claims** and, on kind, the static volumes behind them
   (see "Storage is two claims"). On byo, the binder pod that binds them
   runs the server image, which is why the image comes first.
3. **A ServiceAccount** (`yaac-server`) and a **ClusterRole** bound to it.
   The role is cluster-scoped because the server creates per-project
   registry namespaces at runtime and applies the cluster-scoped
   builder-role admission guard. It has full verbs on what the server owns
   and read-only access to what it only observes (nodes, events, storage
   classes).
4. **The two ingress NetworkPolicies**, before the Service, so the server's
   port is never reachable from pods before the policy exists (see "The
   ingress policy is the wall").
5. **The Service** (ClusterIP) and its **fronting**, meaning how the Service
   is reached from outside the cluster: a forwarder on kind, the Tailscale
   operator's Ingress under `--tailnet` (see "Reachability"). Objects of the
   other fronting are deleted first. The fronting comes before the
   Deployment because the origin it publishes goes into the Deployment's
   environment.
6. **The Deployment**: `replicas: 1`, `strategy: Recreate`, `yaac-infra`
   priority, plain runc, `runAsUser` set to the install uid (see "The uid
   everything runs as"), three mounts (the two claims and the node's
   node-local directory), and `YAAC_ALLOWED_HOSTS` set to the fronting's
   hostname plus whatever the install shell had.

Install then waits for the published origin to report ready and registers
the server: `server.json` gets that origin and the driver `k8s`. This is the
same `registerServer` call `yaac server start` makes for a host process,
because clients reach either kind of server the same way
(docs/server-selection.md). Finally it calls `/whoami` and warns if the
server will not identify this machine (under the tailnet fronting there is
no loopback path, and a tagged device has no tailnet user).

Install refuses to run in two cases:

- **A host server still holds the data dir.** The upgrade path is
  `npm update` then install, usually on a running install. Deploying then
  would put two writers on one database, and the published-origin check
  could be answered by the old server itself.
- **The data dir is a containerless install.** One data dir is one install.

## The server image

`dockerfiles/Dockerfile.server`, built with `podman build` on the machine
running the CLI and pushed to the in-cluster registry like every other
yaac-shipped image (docs/trust-split-builds.md). The server builds none of
its own images.

The **build context is `dist/`**, the bundle and the only directory the npm
tarball ships. So the same Dockerfile works from a source checkout and from
`npm i -g @bsklaroff/yaac`. The tag is the content hash of `dist/`: a
rebuilt bundle is a new image that the Deployment rolls onto, and an
unchanged one costs one registry HEAD request.

`dist/cli.js` leaves npm dependencies external, so the image runs `npm
install` from `dist/package.json`. `scripts/write-dist-manifest.ts` writes
that file at build time from the root manifest, resolving the `catalog:`
pins (the build machine may not have pnpm's catalog). The root manifest is
the dependency list, already checked by `scripts/check-cli-externals.ts`.

The image includes node, `kubectl`, `git`, and the pinned llama.cpp release
at the path `llamaCppDir()` resolves under the pod's `$HOME`, so auto-titles
need no download at runtime. `catatonit` is PID 1, because node would not
reap the orphans of the processes the server spawns.

## Reachability

The server binds `0.0.0.0` (`YAAC_BIND_ADDR`), since a Service cannot reach a
server bound to the pod's loopback. How that Service is reached from outside
the cluster is the only part of the deployment that differs per backend. It
is a **fronting** (`install/server-fronting.ts`), a set of manifests install
renders. A fronting states: the objects to apply, which peers the ingress
policy must admit, the origin it published, and what the Deployment's
environment must say about that origin.

### On kind: a forwarder

A ClusterIP Service plus a *forwarder*: a one-replica `yaac-server-front`
Deployment running stock Envoy (the same mirrored image netd uses) with
`hostNetwork` on the control-plane node. It listens on port 30787 and
TCP-proxies to `yaac-server.<ns>.svc.cluster.local.`. It uses `dnsPolicy:
ClusterFirstWithHostNet` so a host-networked process can resolve a cluster
name. The trailing dot makes the name absolute, so it is not first tried
against the node's own search domains, which CoreDNS forwards to a host
resolver that may hang.

The kind `extraPortMapping` delivers `127.0.0.1:<server port>` on the host
to that node port. kind writes port mappings only when a cluster is
created, so the port is read back from the control-plane node's mapping
(`podman port`) whenever install or `yaac server start|restart` needs the
origin, unless `YAAC_SERVER_PORT` names it. There is no fallback port:
whatever answers a guessed port is not this cluster. A node without the
mapping is refused with the fix: `yaac cluster delete`, then `yaac cluster
install`. That loses running workspaces and nothing else, because the data
dir is on the host and the pod mounts it at the same absolute path.

Why a forwarder and not a NodePort: Calico evaluates policy before
kube-proxy's masquerade, so a NodePort connection would reach the pod with
its original source address. For a kind port mapping that is the podman
bridge gateway on Linux, or gvproxy's address inside the VM on macOS, and
neither is a node address. The forwarder dials the ClusterIP from the node's
own network namespace, so the pod sees the node's InternalIP (or its Calico
tunnel address, from a worker). That is exactly the set the ingress policy
admits, on every platform, and the API is published on no node address.

### Under `--tailnet`: the Tailscale operator's Ingress

The same ClusterIP Service behind the Tailscale Kubernetes operator's
Ingress: `ingressClassName: tailscale`, named `yaac-server`, with the Service
as its default backend and TLS host `yaac`. This gives the server a
tailnet-only MagicDNS name with a certificate, and nothing else: no public
LoadBalancer, no NodePort, no DNS to manage.

Install waits for the operator to publish the name in the Ingress status,
passes it to the Deployment as `YAAC_ALLOWED_HOSTS`, and registers
`https://<name>.<tailnet>.ts.net`. Every request to that name must carry the
identity the Ingress proxy adds; the tailnet, not this machine's loopback,
is the trust boundary. The device name is `yaac`; a second install on the
same tailnet gets a suffixed name from the operator, which install reads back
from the status.

The first HTTPS request to a new name makes the operator's proxy fetch its
certificate, so install waits longer here. If it times out, it lists the
likely causes: the tailnet's HTTPS certificates setting, MagicDNS, then the
ACLs.

An Ingress, not the operator's L4 LoadBalancer Service, because the Ingress
proxy is `tailscale serve`. It terminates TLS, so the origin is a secure
context (the webapp needs one for clipboard writes and file pickers). It
also strips client-supplied identity and forwarding headers and adds its
own, which is what the server's identity check reads (docs/remote-hosting.md).
An L4 exposure would pass through whatever headers a tailnet device sent,
including `Host: 127.0.0.1`, making every tailnet device the owner.

The operator is the cluster owner's to install. `--tailnet` refuses up front
without it (its CRD, Deployment and IngressClass), printing the helm
command, and reports a cluster it cannot query as *unevaluated* rather than
missing. `--byo` (docs/cluster-setup.md "Bring your own cluster") always uses
this fronting, since a cloud cluster has no loopback to publish on.

### Which fronting is installed

Only the live Ingress records this; nothing on disk does. `yaac server
start|restart` read it back (`frontingOfIngress`), wait on the origin it
implies, and print it. A `tailscale`-class `yaac-server` Ingress means the
tailnet fronting. No such Ingress (every kind install, and the e2e harness)
means the kind fronting.

### The ingress policy is the wall

The server identifies callers the same way a host server does
(docs/remote-hosting.md): a request that did not come through `tailscale
serve` and names a loopback `Host` is the owner. On kind the forwarder is
plain TCP, so the pod sees exactly what a host process sent. That makes the
ingress policy part of authentication, not just reachability: a workspace
pod that reached the server could send `Host: 127.0.0.1` and be the owner.
So every path to the server must come from a node or from the fronting.

The server pod's ingress is an explicit allow in two NetworkPolicies (which
Kubernetes unions):

- `yaac-server-ingress`, the **node half**: one `ipBlock` per node address,
  meaning every node's InternalIP plus its Calico tunnel address
  (`nodeIpBlocks()`, which the proxy's ingress policy uses too). Two flows
  arrive this way: the kubelet's readiness probe, and on kind the
  forwarder. Install applies it, and **the server re-applies it on every
  start** from the live node list, since nodes can be added to a running
  install and a pod rescheduled onto a new node must admit that node's
  kubelet or it never becomes Ready. This is the only policy the server
  renders for itself; it never changes its own Deployment.
- `yaac-server-ingress-front`, the **fronting half**: the fronting's peers.
  Under `--tailnet` that is the operator's proxy pod, selected by its
  namespace and its `tailscale.com/parent-resource*` labels. On kind it is
  empty, because the host-networked forwarder is already covered by the
  node half. It is applied even when empty, so switching fronting replaces
  the old peer. Only install writes it.

No pod in the install namespace and no pod CIDR is admitted to the API. A
workspace pod dialing the Service or the pod IP presents its own address
(Calico enforces a workload's source) and matches nothing.

The node half has one more rule: the egress proxy may reach the server's
second listener (`SERVER_MAMA_PORT`, behind the `yaac-server-mama` Service
the proxy deploys with itself), which serves only the `yaac-mama` calls the
proxy relays and authenticates the proxy's secret itself. The proxy is never
admitted to the API port, because it forwards workspace traffic to whatever
a workspace's allowlist names: a workspace could otherwise reach the API
through it with a loopback `Host`.

The node half has one gap. On kind the forwarder is a hostNetwork listener
on a node port, which no pod policy covers, and its dial into the server
comes from the node. A pod that reached `<node>:<that port>` would therefore
reach the server as the node and, with a loopback `Host`, be its owner.
Workspace pods cannot: their egress reaches node addresses only on the netd
listener range. The two kinds of pod that may dial node addresses carry
egress policies that allow every node port except that one
(`egressAllButServerFront`):

- builder pods, which run `RUN` steps from agent-editable Dockerfiles, get
  it with each build;
- the egress proxy, whose upstream is whatever a workspace's allowlist names,
  gets it with the proxy and again on every server start (a proxy that is
  already current is never redeployed).

Every other pod in the namespace is under the world-egress default-deny.

Together with the workspace egress default-deny, this is what keeps
untrusted code from becoming the server's owner. `yaac cluster check`'s
`egress` gate verifies it on every install: it fails when a deployed proxy
lacks the policy above, and a workspace-labelled probe pod must fail to dial
the server. The `server` e2e suite checks the same.

The Host check has one side effect: the kubelet dials the pod IP, so its
readiness probe would send `Host: <pod ip>` and get a 403 from the
DNS-rebind check. The probe therefore sends `Host: 127.0.0.1` explicitly,
standing in for a client of the published origin.

Egress is the reverse: the server pod is **excluded** from the install
namespace's world-egress default-deny. It clones and fetches git remotes
directly. It does not route its own traffic through the egress proxy, which
exists to mediate untrusted code. The kind forwarder, being host-networked,
is selected by no policy (like netd); it only dials one ClusterIP.

## In-cluster dials go by Service

The server talks to three things in the cluster: the image registry, the
proxy's stream relay and the proxy's control API. It reaches each by its
Service DNS name over the pod network, with no tunnel, `kubectl
port-forward` or `kubectl exec` relay.

- **The registry** answers at the Service name every image ref already
  carries. Its ingress policy admits the server's pod selector. (The CLI,
  which runs outside the cluster, uses a `kubectl port-forward` for the
  pushes `yaac cluster install` does.)
- **The stream relay** is the proxy Service's relay port
  (docs/stream-relay.md).
- **The proxy control API** is another port on the same Service. The
  proxy's ingress policy admits both ports from the server's pods and no
  other pods, so a workspace can reach neither.

The e2e harness drives these modules from the host, where a ClusterIP is
unreachable. It supplies its own route instead of the driver having a mode
for it: `ProxyClientConfig.controlOrigin` takes a loopback origin the
harness forwards. Nothing in production sets it.

## The lock is a lease

A pid check or a `127.0.0.1` health probe only answers about the local
machine, and the lock is read from both sides of a container boundary where
every pod reuses the same low pids. So the lock also records an `instance`
id minted per boot (used for compare-and-delete, since a pid does not
identify a server), the writer's `host`, and a `heartbeatAt` that the
running server renews every 5s. A
reader on the writer's host checks the pid as usual. A reader elsewhere
checks whether the heartbeat is younger than 20s. A server that finds it has
lost the lease exits rather than keep writing a database another server now
owns. On hostPath storage nothing prevents two mounts, so this lease is
PGlite's only single-writer guard.

## The uid everything runs as

gVisor has no user namespace, so a file on a claim appears with its real
uid, and every writer of a shared path must use the same uid. There is one
uid for the whole install: the server pod, every workspace pod, the proxy
and the check's probe pods all run as **the install uid**.
`installSecurityContext` renders it directly into manifests; no image build
arg carries it and no image bakes it in.

Install picks the uid, and the server Deployment's `runAsUser` records it:

- **On kind**, it is the uid of the user who ran `yaac cluster install`.
  On macOS nothing else works: the data dir reaches the node over virtiofs,
  whose host side does every read and write as the user running the VM. A
  hostPath file is writable from a pod only if that user can write it. (On
  Linux, where the first user is usually 1000, this is invisible; on macOS
  the first login uid is 501.)
- **On byo**, it is always 1000. An NFS server passes uids through
  unchanged, so the machine running install is irrelevant, and a constant
  keeps ownership stable whichever machine re-installs. The storage binder
  makes each volume root owned by that uid (see "Storage is two claims").

On kind, chowning to another uid does not get around this: a `chown` inside
the node changes nothing on the host, and a `chown` on the host leaves the
file writable by nobody, not even root in the node.

In the cluster, everything derives the uid from the server's own
`process.getuid()`, which is the install uid because the pod runs as that.
So every path the server pre-creates for a workspace is owned by the uid the
workspace pod runs as. Host-side callers that are not install (`cluster
check`'s probe pods) read it from the live Deployment
(`deployedInstallIdentity`). With no Deployment they use what install would
have chosen (1000 on byo, their own uid on kind). A failed read is reported
as a failure, never guessed past.

The images bake in no uid and work at any runtime uid, so one image set
serves every install (docs/arbitrary-uid-images.md). The pods'
supplementary group 0, the other half of that contract, comes from the same
helper. `proxyRunAsSecurityContext` runs the proxy as the install uid too,
through the same shared helper.

## Lifecycle

`yaac cluster install` is the one command that converges an install, and it
is how you upgrade: `npm update`, then install. A new bundle means a new
image tag, which means a `Recreate` rollout.
The egress proxy follows: a server that starts beside a proxy from another
build redeploys it (`rollIfStale`), so running workspaces get the new proxy
without waiting for a launch. Where no proxy exists yet, the first launch
deploys it.

`yaac server start|stop|restart` act on the Deployment (scale to 1 and
wait, scale to 0, `rollout restart`) instead of running a host process,
which would put two servers on one data dir. The `k8s` driver recorded in
`server.json` sends them there; if the cluster cannot be reached they fail
rather than fall back to a host process. `stop` scales to zero rather than
deleting, so `start` can undo it without a full install. It waits for the
pod to disappear, not for a replica count: a Deployment at zero omits
`status.replicas`, so waiting for `0` would wait forever.

There is no host-process form of this driver. A server detects that it is
in the cluster from `YAAC_IN_CLUSTER`, which only this Deployment sets. A
host `yaac server start` on a data dir recorded as `k8s` is refused and
points at `yaac cluster install`; `yaac cluster install` refuses a
containerless data dir. The two never share a data dir.

`yaac server logs` reads `server.log` on the server-local claim, passing
`-n` and `-F` to `tail`:

- On kind the claim is this machine's disk, so the CLI reads the file
  directly, whatever state the pod is in. That matters because a
  crash-looping or stopped server is when you want the log.
- On byo the CLI cannot see the volume. It runs `kubectl exec … tail` in the
  server pod when its container is running. Otherwise it starts
  `yaac-server-log-reader`, a short-lived pod with the server's image and
  identity that mounts the claim read-only (on the server pod's node, if
  there is one, since an attach-once volume is already there), and deletes
  it when the command ends. `server start|restart` also delete any leftover
  reader first, so it cannot hold an attach-once volume on the wrong node.

There is no hot-reload loop in the cluster: `pnpm watch` is the
containerless workflow, and a cluster change means build, push and roll.

## The e2e tiers run against this

The k8s test tiers deploy the real Deployment, once per test file.
`spawnYaacServer` applies it into the file's own `yaac-test-<run-id>`
namespace, forwards a local port to it, and returns the same `{ lock, stop }`
a containerless spawn returns, so test files do not know which they got.
The harness provides what a pod cannot provide for itself:

- a reachable origin: the forward's local port, which is what the returned
  lock reports (never the port inside the pod), and what goes in
  `server.json`;
- RBAC in that namespace;
- the node half of the ingress policy (a port-forward bypasses
  NetworkPolicy, so there is no fronting or fronting half);
- the claim pair, with static volumes into the file's own data dir;
- one extra mount: the file's scratch base at its own absolute path, because
  the source repos and mock-remote stores tests use sit beside the data dir,
  not inside a tier.

Things to know when reading a failure there:

- The image is `<prefix>-server:<contextHash(dist-test)>`, built once per
  run by `test/global-setup.ts` from the suite's frozen copy of the bundle.
  The fixture passes `requirePrebuilt`, so a worker never builds.
- The forward binds the file's own `YAAC_SERVER_PORT`, because that is the
  origin `yaac server start|restart` wait on.
- The server's ClusterRole and ClusterRoleBinding are named
  `yaac-server-<namespace>`, and the two PersistentVolumes are named by the
  file's data-dir hash, so every concurrent file has its own. None of these
  are deleted with a namespace, so per-file teardown and the global sweep
  delete them by their install-namespace label. The volumes are `Retain`,
  so no data is touched.
- A test queries pods with `kubectl exec`, never through the stream relay or
  the proxy's control API, since those are Service dials that only work from
  inside the install namespace. A file that needs the control API hands
  `ProxyClient` a forwarded origin.
- The same files run against kind-byo (docs/cluster-setup.md "Running byo
  locally: kind-byo") as the `e2e-byo` project (`YAAC_TEST_BACKEND=byo`,
  kind-byo's kubeconfig and data dir, so all scratch is inside the NFS
  export). Only storage differs: each file gets its own pair of storage
  classes pointing at its own `global/` and `server-local/`, and its claims
  go through the same class path as an install. The harness writes the
  `.yaac-install` marker itself, since the file writes to those roots before
  its binder runs. The global setup refuses to run without kind-byo, with a
  stale ganesha image, or on a host whose uid is not 1000.
- `e2e-byo-install` has one file, `byo-install-suite`, which tests the
  installed kind-byo server itself, including re-adoption after a namespace
  delete. That delete removes the registry, so the project runs alone and
  pushes no prebuilt images.

## Storage is two claims

The data dir has three tier folders on every driver: `global/`,
`server-local/` and `node-local/` (see the legend in
`packages/shared/src/paths.ts`). The pod sees them as three mounts at fixed
paths, which the Deployment names in three variables:

| Tier | Pod mount | Variable | Backing on kind | Backing on byo |
|---|---|---|---|---|
| GLOBAL | `/yaac/global` | `YAAC_GLOBAL_ROOT` | PVC `yaac-global` (RWX) → PV `yaac-global-<hash>` → hostPath `<dataDir>/global` | PVC `yaac-global` (RWX) from the NFS-family class given to install |
| SERVER-LOCAL | `/yaac/server-local` | `YAAC_SERVER_LOCAL_ROOT` | PVC `yaac-server-local` (RWO) → PV `yaac-server-local-<hash>` → hostPath `<dataDir>/server-local` | PVC `yaac-server-local` (RWO) from the RWO class |
| NODE-LOCAL | `/yaac/node-local` | `YAAC_NODE_LOCAL_ROOT` | hostPath `/var/lib/yaac/node/<hash>` on the node, which a kind extraMount binds to `<dataDir>/node-local` | the same hostPath, on the node's own disk |

Inside the pod, `YAAC_DATA_DIR` still names the host's data dir. There it is
only an identity string: `dataDirHash()`, every label and the registry claim
name hash it, so none of them change across the storage boundary. The path
helpers resolve into the three roots, which the Deployment sets. A host
process never sets these variables, so under containerless the tiers are
just three folders of one directory.

NODE-LOCAL holds nothing durable: per project, the pnpm store and the
per-workspace module dirs, the image-store generations
(docs/nested-containers.md), and each opencode workspace's working copy
(docs/workspace-storage.md "opencode"). On a multi-node cluster those bytes
are on whichever node the workspace ran on, so the server never touches them
through its own filesystem. A pod's init container creates and chowns what
the pod mounts, a node-side writer pod fills the image store, and
`reapNodeLocal` runs one root pod per node to remove what no live workspace
owns.

The claims have **fixed names** and the volumes have **hashed names**. A
claim is namespaced and belongs to one install, so every install namespace
uses `yaac-global`. A PersistentVolume is cluster-scoped, and one cluster can
host several installs (the real one and every e2e namespace), so its name
includes the install hash and its `claimRef` pins it to its own namespace's
claim. On kind both volumes are `Retain` with an empty storage class: no
provisioner, and deleting a claim or namespace never touches the hostPath.
`kind delete` removes the objects with the cluster and leaves the bytes
under `~/.yaac`, so `yaac cluster delete` touches no data. Kubernetes
enforces no access mode on a hostPath, so the same claim spec works with a
real RWX class on a cloud cluster.

Workspace pods mount **subPaths** of `yaac-global`, never the whole claim,
and never the server's claim. The k8s driver maps each declared mount by
the tier its path is under (`resolveMountSource`): a GLOBAL path becomes a
claim subPath, a NODE-LOCAL path the matching path under the node's
directory, and a SERVER-LOCAL path is an error. A `File` mount is a subPath
to that file, so every global file a pod mounts must exist before its Job
is applied; kubelet would otherwise create it as a root-owned directory.
The node-local directories a pod mounts are chowned to the pod's uid by its
own init container, running as root, because hostPath ignores `fsGroup` and
kubelet creates each one root-owned before the init container runs.

### Claims on byo

Install applies the claims after stopping the running server, through one
of two storage shapes (`ensureStorageClaims`): kind's static pair above, or
on byo, claims provisioned from named StorageClasses. The class path makes
each provisioned volume belong to this install, in three steps:

1. **Re-adopt first.** `Retain` only helps if a later install can find the
   data again. A namespace delete leaves both volumes `Released`, so before
   applying a claim install looks for a volume labelled with this install's
   id (`yaac.install-id`, the random `installId` the first run recorded in
   `server.json`), namespace, and claim name (`yaac.claim`). It clears that
   volume's stale `claimRef` and pre-binds the new claim to it by
   `volumeName`, instead of provisioning two empty volumes. The match uses
   the install id, not the data-dir hash, because the hash is of a path and
   `/root/.yaac` on two machines is two installs. A volume that matches the
   hash but not the id is refused, with the one-line relabel that adopts it
   deliberately. This install's own volume under a different class is
   refused too.
2. **Bind with a binder pod.** A `WaitForFirstConsumer` class (the usual
   block class, and local-path) binds nothing until a pod is scheduled, so
   install runs one: `yaac-storage-bind`, runc, root, with both claims
   mounted. It marks each volume root with a `.yaac-install` file holding
   the install id, and refuses a root that belongs to another install (a
   marker with another id, or content with no marker). This matters because
   a class with a fixed `subDir` or base path gives every claim the same
   directory, and every byo install runs as the same uid. It then sets the
   root's owner to the install uid (`chown`, `chmod 2775`) if needed;
   the server creates everything below it at that uid. This replaces
   `fsGroup`, which would have kubelet do the same chown on every mount.
   Root squash breaks both approaches, but the binder fails once, clearly,
   naming the fix (an export without root squash, or the class's
   `mountPermissions`).
3. **Pin each volume.** Set `Retain` regardless of the class, add the
   install's labels, and on the RWX volume merge `actimeo=1` into
   `mountOptions`. That bounds attribute caching, which every cross-pod
   handoff on the shared tier assumes. It is set on the volume yaac owns
   rather than required of the operator's class. The class's other options
   (`soft` or `hard` included) stay. A PV's options are read at each mount,
   and the binder has unmounted before any real pod mounts.

A claim's class cannot be changed, so a re-install naming a different class
is refused. The RWX class must be NFS-family (csi-driver-nfs, EFS, or Azure
Files over NFS), because that is what was measured. `cluster check`'s
`storage` gate checks all of the above on every run. Its `egress` gate adds
one check on such a volume: a workspace-labelled pod must fail to reach the
volume's NFS server. That server uses AUTH_SYS and trusts whatever uid a
client claims, so a sandbox that reached it could read and write every
project as anyone. The workspace network policy is what prevents that, and
the probe proves it on the cluster at hand.

The proxy mounts no storage. It is given what it needs as Kubernetes
objects (docs/workspace-egress.md "What the proxy is told, and how"), so
`.credentials/` is readable only by the server.

## Client state lives beside the data dir

The pod mounts the tiers, so anything inside them is visible to the pod and
owned by its uid. Some files belong to the user's machine, not the server:
`server.json` (the origin this machine's clients dial, and the driver),
the auth daemon's lock and its `login-*` scratch, and the installer's caches
(the Calico manifest, the podman-pid file). Only processes on the user's
machine read and write them: the CLI, the auth daemon, the desktop app, and
`yaac cluster install`.

These form the CLIENT-LOCAL tier (`clientLocalRoot` in `shared/paths.ts`),
at `<dataDir>-client` (`~/.yaac` pairs with `~/.yaac-client`). It is a
sibling, not a subdirectory, because the pod mounts the data dir's contents.
It is derived from the data dir, so `YAAC_DATA_DIR` isolation carries over.

Two consequences:

- **No server process records the driver.** `resolveDriverKind` writes
  nothing. The command that stands the server up records it, and `yaac
  cluster install` writes `k8s` alongside the origin.
- **`resolveServerTarget` reads only the origin in `server.json`**
  (docs/server-selection.md), never the lock. The lock is the server's own
  file; under this driver a client may be unable to read it, and its port
  is the one bound inside the pod.

`.server.lock` stays in SERVER-LOCAL, on the same volume as the database it
guards.

## The credential sweep does not run here

Credential convergence (docs/containerless-driver.md) copies a token a
workspace's agent refreshed back to the host store. It exists for workspaces
that hold the real credential. Under this driver the proxy always holds it,
so the sweep is not used:

- The reconcile step list schedules the periodic sweep only under
  `containerless`.
- Seeding a new workspace takes the proxied branch, which writes placeholder
  credentials and returns early. Harvesting on workspace stop returns at
  once, because a pod-writable tool home must never be trusted as a source
  of credentials for the whole install.
- The macOS Keychain part never applies: this server is a Linux pod.

Instead, a refresh a workspace makes passes through the proxy, which saves
the rotated credential into the `yaac-proxy-refreshed` object, and the
`credential-adopt` reconcile step adopts it from the server's watch of that
object (newest wins).

## What a cluster install cannot do for you

- **Port forwarding needs a client running.** A port bound by the server
  would be on the pod's loopback, so it binds none. It declares each mapping
  and serves the server end of each connection; `yaac forward` or the
  desktop app holds the listener (docs/port-forward-tunnel.md). With neither
  running, the webapp's `127.0.0.1:<port>` links refuse to connect.
- **The git identity is a server setting.** Workspaces commit under an
  identity stored in the database, not one copied from whichever machine ran
  install. The auth server seeds it from your machine's git config when it
  starts (under the desktop app, `yaac auth server start`, or a Claude/Codex
  browser sign-in; `yaac cluster install` does not start it). Edit it in
  Settings → General or with `yaac config git-identity`; no re-install
  needed. A server without one refuses to create workspaces and says where
  to set it. A prewarmed spare has its identity baked in when warmed, so
  claiming it re-applies the current identity.
- **The time zone is a server setting.** A pod runs in UTC, so every
  workspace launches with `TZ` set to a zone the clients report: the web app
  on load, the auth server on start, and `yaac workspace create`. Picking a
  zone in Settings → General pins it, and reports then leave it alone. A
  project's own `TZ` wins, and a workspace keeps the zone it launched with.
  A prewarmed spare records its zone, and one warmed in another zone than
  the current one is never claimed but re-warmed.
- **`YAAC_USE_TOR`** points at a listener on the host, and a pod's loopback
  is its own. Install rewrites loopback addresses in
  `YAAC_HOST_TOR_SOCKS_URL` to the host's address on the kind network, so
  Tor must listen on that interface, not only on `127.0.0.1`. Install warns
  when it cannot determine the address.
