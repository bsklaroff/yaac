# The server in the cluster

Current-state reference for how the yaac server runs under the `k8s`
driver: a single-replica in-cluster Deployment, applied by `yaac cluster
install`, reached from the host at a fixed loopback origin.

The move exists so that server and worktree pods can be given the *same*
storage. A host process beside the cluster can only ever share a
filesystem with its pods by way of hostPath and the node==host assumption;
a pod can mount a claim. Everything below is the process, network and
lifecycle half of that — storage is deliberately untouched here (see
"Storage is still hostPath").

## What is deployed

`yaac cluster install` finishes by applying, in this order:

1. **A ServiceAccount** (`yaac-server`) and a **ClusterRole** bound to it.
   Cluster-scoped rather than namespaced, because the server creates
   per-project registry namespaces at runtime and applies cluster-scoped
   objects at every start (PriorityClasses, RuntimeClasses, the
   builder-role admission guard) — a binding into the namespaces that
   exist today could not cover either. Verbs are full on what the server
   owns and read-only on what it only observes (nodes, events, storage
   classes).
2. **The ingress NetworkPolicy** — before the Service, so the port is
   never published to pods before the wall exists.
3. **The Deployment**: `replicas: 1`, `strategy: Recreate`, `yaac-infra`
   priority, plain runc, `runAsUser` = the installing host's uid.
4. **The Service**: NodePort `30787`, fronted by a kind
   `extraPortMapping` to `127.0.0.1:<server port>` on the host.

Then it registers the server: `server.json` gets the published origin, a
durable token minted with the lock secret, and `k8s` as what this data dir
runs. That registration is not install's own — it is the same
`registerServer` `yaac server start` calls for a host process, because a
client reaches either server the same way (docs/server-selection.md).

Two things it refuses rather than doing. It will not deploy while a **host**
server still holds the data dir: the documented upgrade is `npm update` then
install, ordinarily run on a live install, and deploying into that is two
writers on one database. The check is on the host because that is where it
still works — inside the pod a pre-lease lock reads as same-host and is
judged by a pid in the wrong namespace (docs/legacy-compat-shims.md). And it
does not deploy the server under `--adopt-cni` at all, where there is no port
mapping to publish it through (docs/cluster-setup.md).

## The server image

`dockerfiles/Dockerfile.server`, built by `podman build` on the machine
running the CLI and pushed to the in-cluster registry like every other
yaac-shipped image (docs/trust-split-builds.md). The server builds none of
its own images.

Its **build context is `dist/`** — the bundle, the one directory the npm
tarball ships. That is what makes the same Dockerfile work from a source
checkout and from `npm i -g @bsklaroff/yaac`: both have a `dist/`, and
neither needs the source tree. The tag is `contextHash(dist)`, so a
rebuilt bundle is a different image and the Deployment rolls onto it,
while an unchanged one costs a registry HEAD.

`dist/cli.js` leaves npm dependencies external, so the image `npm
install`s them from `dist/package.json` — written at build time by
`scripts/write-dist-manifest.ts` from the root manifest with the
`catalog:` pins resolved, because pnpm's catalog does not exist on the
machine doing the build. No hand-kept dependency list: the contract is the
root manifest, already enforced by `scripts/check-cli-externals.ts`.

Baked in: node, `kubectl`, `git`, and the pinned llama.cpp release at
exactly the path `llamaCppDir()` resolves under the pod's `$HOME`, so
auto-titles work with no runtime download and no download surviving a
roll. `catatonit` is PID 1, because node would never reap the orphans of
the processes the server spawns.

## Reachability

The server binds `0.0.0.0` (`YAAC_BIND_ADDR`) — a pod's loopback has no
reachable backend, so a Service in front of a loopback-bound server would
have no working endpoint. The path clients take is
NodePort → kind `extraPortMapping` → `127.0.0.1:<port>` on the host, and
the browser, the CLI, the desktop app and the auth daemon all resolve that
origin through `server.json`, which is the only thing `resolveServerTarget`
reads (docs/server-selection.md).

That loopback origin is a convenience, **not** a confinement: a NodePort
answers on every address the node has, so the same Service answers on the
node's own podman-bridge address too, and a host can reach it there. What
actually keeps it shut is two other things — the bridge subnet is RFC1918
and advertised nowhere, so nothing off this machine has a route to it, and
the ingress NetworkPolicy below denies the one class of client that does
(pods). Reading the loopback mapping as the wall would be reading the
wrong mechanism.

The port mapping is written when the cluster is **created**; kind cannot
add one to a running cluster. So a cluster made before this existed cannot
be converged into publishing the server, and install says so by name
rather than hanging: `yaac cluster delete`, then `yaac cluster install`.
That loses running worktrees (as any cluster delete does) and nothing
else — the data dir is on the host, and the pod mounts it at the identical
absolute path, so `dataDirHash()`, every label and the database carry over.

### The ingress policy is the wall, not hardening

Auth keeps today's rules: `isCredentialOptional` keys on **configuration**
(`YAAC_ALLOWED_HOSTS` / `YAAC_TRUST_PROXY`), not on the bind address, so a
local install stays credential-optional exactly as the host process was,
and the Host/Origin checks still force loopback-shaped requests. Install
mints a durable token regardless, because an install that *does* set those
(deliberately, or by inheriting them from the shell that ran it) would
otherwise lock this machine's own CLI out of the server it just deployed —
and it says so in its output when that happens.

What replaces the loopback bind is the server pod's ingress
NetworkPolicy, and its rule is `0.0.0.0/0` **except the pod CIDRs**: what
must never reach the server is a POD, and Calico enforces a workload's
source address, so a pod cannot present anything else. The node-address
form every other yaac policy uses would be wrong here — kube-proxy's DNAT
delivers a NodePort request, but its masquerade to a node address happens
in POSTROUTING, *after* the filter hook where policy is evaluated, so what
the policy sees is the original off-cluster source. Nothing in-cluster
wants this port anyway: a worktree's own `yaac-mama` calls go to the
egress proxy's queue, which the server drains.

Together with the worktree egress default-deny, that is the whole of what
keeps untrusted code off an unauthenticated control plane — so `yaac
cluster check`'s `egress` gate proves it on every install, with a
worktree-labelled probe pod that must fail to dial the server, alongside
the apiserver, registry and forgery-lock denials it already proved.

The Host guard has one consequence worth knowing: the kubelet dials the
POD IP, so its readiness probe would present `Host: <pod ip>` and be
answered 403 by the DNS-rebind check. The probe therefore states
`Host: 127.0.0.1` explicitly, which keeps the guard exactly as strict
while letting the probe stand in for the client it represents — one
dialing the published loopback origin.

Egress is the other way round: the server pod is **excluded** from the
install namespace's world-egress default-deny. It clones and fetches git
remotes directly, as the host process did. Routing the server's own
traffic through the egress proxy is not planned — the proxy mediates
untrusted code, and the server is the thing doing the mediating.

## Everything it dials, it dials by Service

Three things the server talks to live in the cluster with it — the image
registry, the proxy's stream relay, and the proxy's control API — and it
reaches all three the way any pod reaches any Service: by DNS name, over the
pod network. There is no tunnel, no `kubectl port-forward` child and no
`kubectl exec` relay anywhere on those paths, because a pod of the same
namespace needs none.

- **The registry** answers at the Service DNS name every image ref already
  carries, and its ingress policy admits the server's pod selector — a
  pod-sourced dial matches no node CIDR. (The CLI is the one client that
  genuinely is outside, so it keeps a `kubectl port-forward` for the pushes
  `yaac cluster install` does.)
- **The stream relay** is the proxy Service's relay port
  (docs/stream-relay.md). The Deployment states the address as
  `YAAC_RELAY_ADDR`; unset resolves to the same Service by name, so the
  variable is for an install that puts the proxy elsewhere, not for a
  placement this driver has.
- **The proxy control API** is the same Service's control port. The proxy's
  ingress policy admits both ports from the server's pod selector and from
  nothing else pod-shaped, so a worktree can reach neither.

One caller of these modules is not a pod: the **e2e harness**, which drives
them from the host against a real cluster, where a ClusterIP names nothing.
It supplies its own reachability rather than the driver carrying a mode for
it — `ProxyClientConfig.controlOrigin` takes a loopback origin the harness
forwards for itself. Nothing in production sets it.

## The lock is a lease

`process.kill(pid, 0)` and a `127.0.0.1:<port>` `/health` probe both
answer about *this* machine, and a lock file on a shared data dir now has
readers on both sides of a container boundary — where every pod's pid
namespace hands out the same low pids, so "is pid 1 alive?" answers about
the wrong process entirely.

So the lock records three more things: an `instance` minted per boot (the
identity compare-and-delete uses, since a pid no longer identifies a
server), the writer's `host`, and a `heartbeatAt` the running server
renews every 5s. A reader that shares the writer's host judges it exactly
as before; a reader that does not asks whether the lease is younger than
20s. A server that discovers it has lost the lease exits rather than keep
writing a database another server now owns — on hostPath storage there is
no attach exclusivity, so the lease IS the single-writer guard PGlite gets.

Locks written before the lease parse and behave as they always did; see
docs/legacy-compat-shims.md.

## The uid everything runs as

Under gVisor there is no user namespace, so a hostPath file is presented at
its real node-side uid and every writer of a shared path has to name the
same number. Here that is one number for the whole install: the server pod,
every worktree pod, the proxy and the check's probe pods all run as **the
uid of the machine that ran `yaac cluster install`**. `hostUidSecurityContext`
is the one place that answers it, and it renders straight into a manifest —
no image build arg, and nothing baked (see below).

It is the host's uid rather than a pinned constant because on macOS nothing
else can work. The data dir reaches the node over virtiofs, and the host end
of that performs every read and write with the credentials of the user
running the VM. So a hostPath file is writable from a pod only if it is
writable by THAT user, which makes the host uid a ceiling nothing in the
cluster can raise. On a Linux host whose first user is 1000 the pinned and
discovered values coincide and none of this is visible; on macOS, where the
first login uid is 501, only the discovered one exists.

Chowning the tree to some other uid does not escape the ceiling, in either
direction. A `chown` issued inside the node is cosmetic: it reports success
and `stat` shows the new owner, while the host inode is unchanged and the
write is still refused. A `chown` issued on the HOST does propagate — the
node then sees the new owner — but the file becomes writable by nobody at
all: not a pod, not the host user, and not even root inside the node,
because root in the guest is not root on the other side of the gofer. That
last one is the proof that the check is not the guest's to make.

The install is where the number is discovered because it is the only party
that can: it runs on the machine that owns the data dir, while the pod it
configures does not. Inside the server pod it stays true without
special-casing, since the pod runs as the uid its install stamped — so
`process.getuid()` there IS the host's, and every path the server
pre-creates for a worktree lands owned by the number that worktree's pod
runs as.

The images, by contrast, know nothing about it: they bake a fixed `yaac`
user and work at any runtime uid, which is what lets one image set serve
every host (docs/arbitrary-uid-images.md). The pods' supplementary group 0
is the other half of that contract, and it comes from the same helper.

None of this is new to the server: `proxyRunAsSecurityContext` has always
run the proxy as the host's uid, for the same reason and against the same
wall. The two share one helper so the decision cannot drift between them.

## Lifecycle

`yaac cluster install` is still the one converge verb, and it is what an
upgrade runs: `npm update`, then install. A new bundle is a new image tag
is a `Recreate` rollout.

`yaac server start|stop|restart` act on the Deployment — scale to 1 and
wait, scale to 0, `rollout restart` — rather than spawning or signalling a
host process, which would put two servers on one data dir. What routes them
there is the recorded driver beside the lock: `k8s` means "ask the cluster",
and being unable to ask is a refusal rather than a fallback to the host
path. `stop` scales rather than deletes: deleting would take the RBAC and
Service with it, and then the thing that undid a stop would be a full
install rather than a start. It waits on the POD going away, not on a
replica count — a Deployment at zero omits `status.replicas` entirely, so
waiting for it to read `0` waits forever.

There is no host-process form of this driver, so there is nothing to
choose between and no flag to choose it with. Placement IS the driver: a
start notices which of the two it is (`YAAC_IN_CLUSTER`, set by this
Deployment and by nothing else) and records it. A host `yaac server start`
on a data dir recorded `k8s` is refused outright, naming `yaac cluster
install` — and `yaac cluster install` refuses to run against a
containerless install, so the two kinds never meet on one data dir.

`yaac server logs` needs no cluster awareness at all — the server writes
`server.log` into the data dir, which is the host's.

There is deliberately **no hot-reload dev loop**. `pnpm watch` remains the
containerless workflow; iterating on the in-cluster server is build, push,
roll — tens of seconds, not sub-second.

## The e2e tiers run against this

The k8s test tiers deploy the real thing, per test file: `spawnYaacServer`
applies this Deployment into the file's own `yaac-test-<run-id>` namespace
and forwards a local port to it, handing back the `{ lock, stop }` shape a
containerless spawn also answers — so no test file knows which it got. What the harness
supplies is what a pod cannot read for itself — a reachable origin (the
forward's local port is what the returned lock reports, never the port the
pod binds), a durable token in `server.json`, RBAC in that namespace, and a
mount wide enough to cover the file's scratch tree.

Three consequences worth knowing when reading a failure there:

- The image is `<prefix>-server:<contextHash(dist-test)>`, built once per
  run by `test/global-setup.ts` from the suite's frozen copy of the bundle,
  and `requirePrebuilt` in the fixture — a worker never builds.
- The forward binds the file's own `YAAC_SERVER_PORT`, because that is the
  origin `yaac server start|restart` waits on. Without that, those verbs
  could not be exercised at all.
- The server's ClusterRole and ClusterRoleBinding are namespace-suffixed
  (`yaac-server-<namespace>`), like netd's, so the real install and every
  concurrent test file own their own. They do not cascade when a namespace
  is deleted, so the suite sweeps them by their install-namespace label.
- A test asks a POD things with `kubectl exec`, never through the stream
  relay or the proxy's control API — both of those are Service dials that
  answer for a pod of the install namespace and for nothing on the host. A
  file that needs the proxy's control API (four of `test/e2e` do) hands
  `ProxyClient` a forwarded origin instead; one that needs a fact from
  inside a workspace runs the command there.

## Storage is still hostPath

The pod mounts the real data dir, by hostPath, at its own absolute path.
kind binds `$HOME` into every node, so this resolves to the same bytes the
host process wrote, and `dataDirHash()`, every existing hostPath mount and
the worktree-pod view of the world are byte-identical either side of the
move. Splitting the tiers onto claims is docs/plans/cloud-k8s.md; nothing
above the driver learns anything either way.

## Client state lives beside the data dir, not in it

The pod mounts the data dir, so anything inside it is something the pod can
see and the pod's uid owns. Several files there were never the server's:
`server.json` (which origin this machine's clients dial, and which kind of
install this is), the auth daemon's lock and its `login-*` scratch, and the
installer's own caches — the Calico manifest and the podman-pid file. Each is written and
read only by processes on the USER's machine: the CLI, the auth daemon that
needs a browser and the vendors' localhost OAuth callbacks, the desktop
shell, and `yaac cluster install` acting as installer.

They are the CLIENT-LOCAL tier (`clientLocalRoot` in `shared/paths.ts`),
rooted at `<dataDir>-client` — `~/.yaac` pairs with `~/.yaac-client`. A
sibling rather than a subdirectory, because a subdirectory of the data dir is
by definition inside what the pod mounts; derived from the data dir rather
than a fixed per-user path, so `YAAC_DATA_DIR` isolation carries for free and
one install's clients never read another's remote.

Two consequences worth stating:

- **No server process records the driver.** `resolveDriverKind` writes
  nothing; the COMMAND that stands the server up records it, and `yaac
  cluster install` writes `k8s` alongside the origin and token. There is
  nothing for the pod to add and nowhere to put it.
- **`resolveServerTarget` reads neither the record nor the lock.** It reads
  the origin and token in `server.json` and nothing else
  (docs/server-selection.md). The lock is the server's own file — under this
  driver it belongs to the pod, a client may not be able to read it at all,
  and the port in it is the one bound inside the pod.

`.server.lock` itself stays SERVER-LOCAL: it is the single-writer guard for
PGlite and belongs on the same volume as the database.

## The credential sweep is inert in here

Credential convergence (docs/containerless-driver.md) carries a token a
worktree's agent refreshed in place back up to the host store, and pushes it
down to projects left behind. All of that is about an UNMEDIATED worktree —
one holding the real bundle because there is no proxy to swap it. Under this
driver there always is one, so the sweep has nothing to carry, and it is
inert here for reasons rather than by luck:

- The standing sweep is never scheduled: the reconcile step list adds it only
  when the driver is `containerless`.
- The two call sites that are not driver-gated stop on their own. Seeding a
  create takes the mediated branch, which writes sentinels and returns before
  either half runs; the harvest on worktree stop reads project tool homes
  that hold sentinels, and a sentinel is explicitly not a credential to adopt.
- The Keychain half never applies. It is `darwin`-only, and this server is a
  Linux pod — there is no `security` to spawn and no host tool home to read.

Worth stating because the pod inverts the assumptions that code was written
against: a host with a login keychain and the user's own tool directories. It
has neither, and the answer is that it never asks for them.

## What a cluster install cannot do for you

- **Worktree port-forwarding needs a client running.** A port the server
  bound would be on the pod's loopback, so it binds none: it declares the
  mapping and serves the near end of each connection, and the listener is
  held by `yaac forward` or the desktop app (docs/port-forward-tunnel.md).
  With neither running the webapp's `127.0.0.1:<port>` links refuse to
  connect — which is the honest state, and the one thing a pod-side bind
  would have hidden.
- **The git identity is a server setting, not a host's.** Worktrees commit
  under an identity kept in the database — which the pod already mounts —
  rather than one install snapshots off whichever machine it ran on. The
  `yaac` CLI and the auth server seed it from your own machine's git config
  the first time either talks to the server, and Settings → General edits
  it, so changing your name needs no re-install and no shell on the host. A
  server that has none refuses to create a worktree and says where to set
  one. A prewarmed spare bakes its identity in at warm time, so a claim
  re-keys the checkout it hands over; the pool is never left committing
  under an identity that has since been changed.
- **`YAAC_USE_TOR`** names a listener on the host, and a pod's loopback is
  its own. Install rewrites the loopback halves of
  `YAAC_HOST_TOR_SOCKS_URL` into the host's address on the kind network —
  so Tor has to be listening on that interface, not only on `127.0.0.1`,
  and install says so when it cannot work the address out.
