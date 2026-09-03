# Cloud k8s, step 4: server publication and the ingress wall

Implementation plan for step 4 of docs/plans/cloud-k8s.md, and nothing
else: how the server's Service is fronted becomes a per-backend manifest
install renders, how install learns the published origin and registers it,
and how the server pod's ingress NetworkPolicy becomes an explicit allow.
`--byo` is step 6; this step leaves the seam shaped so that step 6 selects
the tailnet fronting by passing one value, with no change to the driver or
to `server-deploy.ts`.

Two things in here differ from the one-paragraph description in the parent
plan, and each is argued where it comes up:

- On kind the fronting is a **hostNetwork forwarder pod plus the port
  mapping**, not a NodePort. A NodePort cannot satisfy "an explicit allow of
  node CIDRs": policy is evaluated before kube-proxy's masquerade, so what
  the server pod's policy sees for a port-mapped connection is the HOST's
  address, which differs by platform. A forwarder in the node's network
  namespace turns that into a node source on every platform.
- A `--tailnet` install option exists **in this step**, so the parent plan's
  gate ("`yaac remote set` from a second device reaches a tailnet-fronted
  kind cluster") is runnable before `--byo` exists. Step 6 makes it implied
  by `--byo`.

## Where this starts from

- `deployServerWorkload` (`packages/server/src/drivers/k8s/install/server-deploy.ts`)
  applies SA → ClusterRole → binding → ingress NP → Deployment → Service, waits
  for `http://127.0.0.1:<resolveServerPort()>/health` to report ready, and
  calls `registerServer`. The Service is `NodePort` pinned to
  `SERVER_NODE_PORT` (30787); `renderKindConfig` in `install.ts` writes the
  kind `extraPortMapping` from that constant at cluster-create time.
- `buildServerIngressNpManifest(podCidrs)` (`cluster/policy-manifests.ts`)
  renders one rule: `ipBlock 0.0.0.0/0 except <pod CIDRs>`, rendered from
  `clusterPodCidrs()`. It is applied by install and by the e2e harness
  (`packages/test-utils/src/deployed-server.ts`), never by the server.
- `buildServerEnv` passes `YAAC_ALLOWED_HOSTS` / `YAAC_TRUST_PROXY` through
  from the shell that runs install; `isLoopbackOnlyInstall` decides whether
  the token mint must succeed; `mintLocalClientToken`
  (`packages/shared/src/server-config.ts`) reads the lock off the HOST data
  dir to authenticate the mint.
- `startClusterServer` / `restartClusterServer` wait on
  `serverPublishedOrigin()`, a sync loopback origin; the CLI prints it
  (`packages/cli/src/cli.ts`, `runDeployedServerVerb`).
- `cluster check`'s `egress` gate (`install/check.ts`,
  `runNetworkPolicyProbe`) already `nc`s the server Service's ClusterIP from a
  worktree-labelled gVisor pod and fails on `NP_SERVER_OPEN`. That probe is
  unchanged by this step; only its fix text is.
- `--adopt-cni` deploys no server and says so (`install.ts`). That stays
  true through this step; step 6 is what changes it.

## Design

### The fronting is a manifest set, and the live Service is its record

A new install-internal module,
`packages/server/src/drivers/k8s/install/server-fronting.ts`, defines what
install needs to know about "what sits in front of the server's Service":

```ts
interface ServerFronting {
  kind: 'kind' | 'tailnet'
  /** The Service, in the shape this fronting needs. */
  serviceManifest(): Record<string, unknown>
  /** Anything else that has to exist for the origin to answer (the kind
   *  forwarder's ConfigMap + Deployment; nothing on the tailnet). Applied
   *  after the Service, rolled out before the origin is probed. */
  extraManifests(): Record<string, unknown>[]
  /** NetworkPolicy `from` peers that deliver fronted traffic to the pod.
   *  The node addresses are NOT listed here — they are admitted
   *  unconditionally (see "The wall, in two objects"). */
  ingressPeers(): Record<string, unknown>[]
  /** The origin clients dial, once the fronting has published one. Polls
   *  the fronting's own object (the Service status) up to `timeoutMs` and
   *  throws a ClusterInstallError naming the fix when it never appears. */
  resolveOrigin(timeoutMs?: number): Promise<string>
  /** What the Deployment's env must state for that origin. */
  remoteHosting(origin: string): { allowedHosts: string[]; trustProxy: boolean }
  /** Diagnosis for "rolled out, but the origin never answered". */
  unreachableDiagnosis(origin: string): string
}
```

Two builders: `kindFronting()` and `tailnetFronting({ hostname })`. Plus
`frontingOfService(svc | null): ServerFronting`, which reads a live Service
and answers which fronting installed it: `spec.loadBalancerClass ===
'tailscale'` is the tailnet fronting (its hostname read back off the
`tailscale.com/hostname` annotation); anything else — a ClusterIP Service,
a NodePort Service from an install that has not been re-converged, or no
Service at all (the e2e harness) — is the kind fronting. That rule is what
lets `yaac server start|restart` wait on the right origin with no new state
on disk, and what lets step 6 add a selection at install time only.

`deployServerWorkload(opts)` gains `fronting: ServerFronting` as a required
option. `install.ts` is the only caller that chooses one.

### kind: a forwarder pod in the node's network namespace

Why not the NodePort the parent plan names. Calico evaluates a workload's
ingress policy in the filter hook; kube-proxy's masquerade of NodePort
traffic to a node address happens in `nat POSTROUTING`, after it. So the
server pod's policy sees the connection's ORIGINAL source — which for a
kind port mapping is whatever the node container's host stack presents:

| host | what the node sees as the source of a `127.0.0.1:<port>` connection |
|---|---|
| Linux, rootful podman + netavark | the bridge gateway on the `kind` podman network (netavark masquerades loopback-originated port-forwards) |
| macOS, podman machine (libkrun/gvproxy) | gvproxy's address inside the VM (`192.168.127.1`), which netavark does not masquerade — not on the podman bridge at all |

Neither is a node address, and "node CIDRs" as `nodeIpBlocks()` resolves
them (InternalIPs plus Calico tunnel addresses) admits neither. Keeping a
NodePort means the kind fronting has to declare a host-side source address
per platform, and the macOS value cannot be verified from a Linux CI. That is
a guess in a load-bearing allow rule.

The forwarder makes the question go away. The kind fronting is:

- **A ClusterIP Service** `yaac-server` (no `nodePort`, no `type: NodePort`).
  A side effect worth having: the API is no longer published on every
  address the nodes have, which docs/server-in-cluster.md today has to
  explain away as "not a confinement".
- **A hostNetwork Envoy forwarder**, Deployment `yaac-server-front` in the
  install namespace: one replica, `hostNetwork: true`,
  `dnsPolicy: ClusterFirstWithHostNet`, pinned to the control-plane node
  (`nodeSelector: {node-role.kubernetes.io/control-plane: ""}` plus the
  matching `NoSchedule` toleration — kind keeps that taint once there are
  workers, and the port mapping lives on that node), `yaac-infra` priority,
  plain runc, all capabilities dropped, `runAsNonRoot`. Its image is the
  Envoy mirror install already pushes for netd (`registryRef(ENVOY_MIRROR_TAG)`
  — no new image, no barrel widening). A ConfigMap `yaac-server-front`
  carries a static bootstrap: one TCP-proxy listener on `0.0.0.0:30787`,
  one `STRICT_DNS` cluster at `yaac-server.<ns>.svc.cluster.local:8787`.
  Started with `--use-dynamic-base-id` for the same reason netd's Envoy is
  (several hostNetwork Envoys share a node). Readiness is a `tcpSocket`
  probe on the listener.
- **The kind `extraPortMapping`**, unchanged: host `127.0.0.1:<port>` →
  control-plane `containerPort: 30787`. The constant is renamed
  `SERVER_NODE_PORT` → `SERVER_FRONT_PORT` and keeps its value, because the
  mapping is written into every existing cluster at create time and this
  step converges those clusters rather than recreating them.

Traffic path: host → port mapping → forwarder (host netns of the
control-plane node) → ClusterIP → kube-proxy DNAT → server pod. The dial
into the pod is host-originated on the node that runs the forwarder, so its
source is that node's InternalIP (same node) or its Calico tunnel address
(pod on a worker) — exactly the set `nodeIpBlocks()` renders, and exactly
the flow the proxy's ingress policy already admits for netd's Envoy today.
Multi-node kind gets a correctness fix for free here: with the server pod
on a worker, the masqueraded source is the control plane's tunnel address,
which lies INSIDE the pod CIDR and is therefore excluded by the current
`except` rule. The explicit allow names it.

The forwarder is a hostNetwork pod, so no NetworkPolicy selects it — the
install-wide world-egress default-deny does not apply to it, the way it
does not apply to netd. Its own reach is one ClusterIP.

`ingressPeers()` on kind is empty: the node addresses cover it.
`resolveOrigin()` answers `http://127.0.0.1:<resolveServerPort()>` at once.
`remoteHosting()` answers nothing (the shell passthrough below still
applies, so docs/remote-hosting.md's `tailscale serve` on a kind host keeps
working). `unreachableDiagnosis()` is the existing "cluster created before
the port mapping" text, plus one new line naming the forwarder
(`kubectl -n <ns> get deploy yaac-server-front`).

The rejected alternative, for the record: keep the NodePort and have the
kind fronting admit `podman network inspect kind`'s gateway (Linux) and the
podman machine's default gateway (macOS) as `/32` ipBlocks. Fewer objects,
one platform-specific discovery per host type, and an allow rule whose
correctness on macOS this repo cannot test. If the forwarder proves
unwanted, that is the fallback, and the seam absorbs it as a different
`kindFronting()` body.

### tailnet: the operator's LoadBalancer Service

`tailnetFronting({ hostname })` renders the Service the parent plan names:

```yaml
spec:
  type: LoadBalancer
  loadBalancerClass: tailscale
  allocateLoadBalancerNodePorts: false   # no NodePort on the side
  selector: {app: yaac-server}
  ports: [{name: api, port: 8787, targetPort: 8787}]
metadata:
  annotations: {tailscale.com/hostname: <hostname>}
```

`allocateLoadBalancerNodePorts: false` matters: a LoadBalancer Service
allocates a NodePort by default, which would publish the API on every node
address of a cloud pool behind nothing but the policy.

`extraManifests()` is empty. `ingressPeers()` selects the operator's proxy
pod for this Service:

```yaml
- namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: tailscale}}
  podSelector:
    matchLabels:
      tailscale.com/parent-resource: yaac-server
      tailscale.com/parent-resource-ns: <install namespace>
```

The label names come from the operator's `sts.go` (`LabelParentName`,
`LabelParentNamespace`; `LabelParentType` is added once its Service value
is read off a live proxy pod — see open questions). The operator namespace
is a constant, `TAILSCALE_OPERATOR_NAMESPACE = 'tailscale'`, the chart's
default and what the documented helm command installs into. The proxy
SNATs cluster-bound traffic to its own pod IP by default (`TS_ENABLE_SNAT`),
which is what makes a pod selector the right peer; a ProxyClass that turns
SNAT off presents the tailnet source instead and fails the origin wait
loudly (see risks).

`resolveOrigin()` polls the Service until `status.loadBalancer.ingress[]`
carries a `hostname` (the MagicDNS FQDN), then answers
`http://<hostname>`. Two minutes, then a `ClusterInstallError` naming the
operator: check its Deployment, the ACL tags, and the proxy pod's events.
`remoteHosting(origin)` answers `{ allowedHosts: [hostname], trustProxy:
true }`, so the deployed server REQUIRES a credential and admits its
tailnet name. `unreachableDiagnosis()` says the operator published a
hostname but this machine could not reach it: it is not on the tailnet, or
the tailnet's ACLs do not admit it.

The `http://` is deliberate and is the top open question below: an L4
`loadBalancerClass: tailscale` Service is raw TCP over WireGuard, not TLS,
so the browser origin is `http://yaac.<tailnet>.ts.net` and the session
cookie is not `Secure`. The operator's Ingress class is what terminates
TLS. The seam is shape-agnostic on purpose: an Ingress-based tailnet
fronting is a different `serviceManifest()` (ClusterIP), a non-empty
`extraManifests()` (the Ingress), a peer selecting the Ingress proxy, a
`resolveOrigin()` reading the Ingress status, and `https://`.

### The wall, in two objects

`buildServerIngressNpManifest` is replaced by two builders in
`policy-manifests.ts`, each rendering one NetworkPolicy over the server's
pod selector; NetworkPolicy unions allow rules across objects, so the two
compose:

- **`yaac-server-ingress`** (name unchanged, `SERVER_INGRESS_NP_NAME`):
  `buildServerIngressNpManifest(nodeCidrs)` — `ipBlock` per node address
  from `nodeIpBlocks()`, TCP 8787. Admits the kubelet's readiness probe and,
  on kind, the forwarder's dial. Applied by install AND re-applied by the
  server at k8s driver attach (`lifecycle.ts`, `attachNow`, beside
  `ensurePriorityClasses`), the way the proxy's ingress policy is re-rendered
  from the same node list. That is what keeps the node half from going
  stale on a pool whose nodes are replaced: a server pod rescheduled onto a
  new node re-admits that node's kubelet as soon as it boots, inside the
  readiness probe's failure window. Nothing is snapshotted at install time
  that a growing cluster invalidates, which retires the pod-CIDR snapshot
  the parent plan calls out.
- **`yaac-server-ingress-front`** (`SERVER_FRONT_INGRESS_NP_NAME`, new in
  `proxy-constants.ts`): `buildServerFrontIngressNpManifest(peers)` — the
  fronting's `ingressPeers()`, TCP 8787. Applied by install only; the server
  knows nothing about frontings. With empty peers (kind) the builder renders
  a policy with an empty `ingress` list, which admits nothing and is applied
  anyway so a switch of fronting on re-install overwrites rather than
  leaves a stale peer behind.

`nodeIpBlocks()` already throws on an empty node list, so the node half can
never be rendered as "admit nothing" by accident. The pod CIDRs stop being
an input to this policy; `clusterPodCidrs()` keeps its other caller (netd's
RETURNs).

What must never reach the server is a pod, and the explicit form says so
by omission: no `podSelector` in the install namespace, no pod CIDR. The
`egress` gate's `NP_SERVER_OPEN` leg proves it unchanged.

### Remote-hosting variables, the token, and registration

`buildServerEnv(opts)` takes `remoteHosting` and states
`YAAC_ALLOWED_HOSTS` as the union of the fronting's hosts and
`env.allowedHosts`, and `YAAC_TRUST_PROXY` when either side says so. The
shell passthrough stays because it is how a kind install is fronted by a
host-side `tailscale serve` today. `isLoopbackOnlyInstall()` asks the same
merged answer, so the "this server will REQUIRE a credential" note and the
`credentialRequired` flag to `registerServer` follow the fronting.

The token mint stops reading the host's lock. `mintLocalClientToken(origin,
readLock = readLock)` in `packages/shared/src/server-config.ts` takes its
lock reader as a parameter; install passes one that reads the lock the POD
holds — `kubectl exec deployment/yaac-server -- sh -c 'cat
"${YAAC_SERVER_LOCAL_ROOT:-$YAAC_DATA_DIR}/.server.lock"'`, parsed with
`parseServerLock`. On kind the host could still read it; on a cloud cluster
the data dir is not on this machine at all, and a mint that silently fails
there is a lockout on an install that requires a credential. One code path
for both is the point. `registerServer` itself is unchanged; the e2e
harness keeps calling it with the default reader (its scratch is a hostPath
this machine owns).

### The install sequence

`deployServerWorkload({ fronting, log, torHostAddr })`:

1. `refuseIfHostServerRunning()` — unchanged.
2. `ensureServerImage()` — unchanged.
3. Apply the ServiceAccount, ClusterRole and ClusterRoleBinding.
4. Apply `yaac-server-ingress` (from `nodeIpBlocks()`) and
   `yaac-server-ingress-front` (from `fronting.ingressPeers()`). Both before
   anything publishes the port, as today.
5. Apply `fronting.serviceManifest()`. On an existing kind install this is
   the NodePort → ClusterIP change; applying it first releases 30787 on the
   node before the forwarder binds it.
6. `origin = await fronting.resolveOrigin()`. Immediate on kind; a status
   wait on the tailnet. The Deployment needs the origin before it can be
   rendered, which is why the Service precedes it.
7. Apply the Deployment with `buildServerEnv({ remoteHosting:
   fronting.remoteHosting(origin), torHostAddr })`.
8. Apply `fronting.extraManifests()` and wait for each Deployment among
   them to roll out; then `rollout status` on the server, as today.
9. `waitForPublishedServer(origin, fronting.unreachableDiagnosis(origin))`.
10. Log the credential note when `!isLoopbackOnlyInstall(remoteHosting)`;
    `registerServer(origin, 'k8s', { credentialRequired, mint })` with the
    pod-lock mint. Return `origin`.

`install.ts`'s `deployServer(deps)` builds the fronting: `opts.tailnet ?
tailnetFronting({ hostname: 'yaac' }) : kindFronting()`, and hands it to
`deps.deployServer`. The Tor address plumbing is untouched.

`startClusterServer()` and `restartClusterServer()` become
`Promise<string>`: they read the live Service (`kubectlGetJson`), derive the
fronting with `frontingOfService`, wait on `resolveOrigin()` then
`waitForPublishedServer`, and return the origin, which the CLI prints in
place of `serverPublishedOrigin()`. `serverPublishedOrigin` and
`waitForPublishedServer` leave the install barrel; nothing outside the
folder needs either once start/restart return the origin.

### `--tailnet`

`yaac cluster install --tailnet` selects the tailnet fronting on the cluster
install is converging — kind included, which is the parent plan's gate for
this step. It is refused up front, before any layer is applied, when the
Tailscale operator is not there: `verifyTailnetOperator(deps)` runs right
after the cluster phase (after `kindNodes` / `createKindCluster`, before
`installPriorityClasses`) and asks for the CRD `proxyclasses.tailscale.com`
and an available Deployment `operator` in the `tailscale` namespace. A read
that fails for a reason other than absence is reported as "could not
evaluate", never as absence — the same rule the adoption gate keeps. The
refusal prints the helm command:

```sh
helm repo add tailscale https://pkgs.tailscale.com/helmcharts
helm upgrade --install tailscale-operator tailscale/tailscale-operator \
  --namespace=tailscale --create-namespace \
  --set-string oauth.clientId=<id> --set-string oauth.clientSecret=<secret> \
  --wait
```

`--tailnet` with `--adopt-cni` is accepted (the probe runs before the CNI
gate) but adoption still deploys no server in this step, and the note it
prints says so; the combination becomes meaningful in step 6. The flag
takes no hostname: the device name is `yaac`, and a second yaac on one
tailnet is out of scope until multi-install naming is.

Step 6 folds this into `--byo` (implied, not optional — the parent plan's
"no option to add" anything else) and deletes the standalone flag if a
tailnet-fronted kind install has no users of its own by then; keeping it is
also fine, since it is the supported replacement for a hand-run
`tailscale serve` on a k8s host.

## Modules to change or add

### `packages/server/src/drivers/k8s/substrate/proxy-constants.ts`

- Rename `SERVER_NODE_PORT` → `SERVER_FRONT_PORT` (value 30787 unchanged);
  reword its doc: the node port the kind port mapping targets, bound by the
  forwarder rather than published by kube-proxy.
- Add `SERVER_FRONT_APP_NAME = 'yaac-server-front'` and
  `SERVER_FRONT_INGRESS_NP_NAME = 'yaac-server-ingress-front'`.
- Add `TAILSCALE_OPERATOR_NAMESPACE = 'tailscale'` and the two operator
  label keys as constants, so the peer selector and the step-6 probe spell
  them once.
- Re-export through `substrate/index.ts` as the existing names are.

### `packages/server/src/drivers/k8s/cluster/policy-manifests.ts`

- `buildServerIngressNpManifest(nodeCidrs: string[])`: node `ipBlock`s only.
  Rewrite the doc comment: explicit allow, the kubelet probe and the kind
  forwarder as the two flows, the two-object composition, why a pod CIDR is
  no longer an input.
- Add `buildServerFrontIngressNpManifest(peers: Record<string, unknown>[])`.
- Export the new builder from `cluster/index.ts`.

### `packages/server/src/drivers/k8s/lifecycle.ts`

- In `attachNow`, after `ensurePriorityClasses()`: `await
  kubectlApply(buildServerIngressNpManifest(await nodeIpBlocks()))`, wrapped
  so a failure logs and does not block attach (an in-cluster server whose
  policy apply fails is still reachable through the policy install left;
  the containerless driver never enters this file). A short comment says
  why the server re-renders this one policy and not its Deployment.

### `packages/server/src/drivers/k8s/install/server-fronting.ts` (new)

- `ServerFronting`, `kindFronting()`, `tailnetFronting({ hostname })`,
  `frontingOfService(svc)`, and the two manifest renderers the kind
  fronting needs (`buildServerFrontConfigMapManifest`,
  `buildServerFrontDeploymentManifest(imageRef)`), plus the Envoy bootstrap
  as a template literal. Install-internal; not on the barrel.

### `packages/server/src/drivers/k8s/install/server-deploy.ts`

- `ServerEnvOptions` gains `remoteHosting`; `buildServerEnv` merges it with
  the shell passthrough.
- `buildServerServiceManifest` moves into the frontings; delete it here.
- `ensureServerDeployment` takes the fronting and follows the sequence
  above; `deployServerWorkload` requires `fronting`.
- `isLoopbackOnlyInstall(remoteHosting)` takes the merged answer.
- `writeServerRemote(origin, credentialRequired, log)` passes the pod-lock
  `mint`; add `readPodLock()` (kubectl exec + `parseServerLock`).
- `waitForPublishedServer(origin, diagnosis, timeoutMs)`; internal.
- `startClusterServer` / `restartClusterServer` return the origin via
  `frontingOfService`. `stopClusterServer` unchanged.
- Delete `serverPublishedOrigin`. Update the module header (the storage
  paragraph stays; the Service paragraph goes).

### `packages/server/src/drivers/k8s/install/install.ts`

- `ClusterInstallOptions.tailnet?: boolean`.
- `verifyTailnetOperator(deps)` after the cluster phase, before the layers.
- `deployServer(deps, opts)` picks the fronting.
- `renderKindConfig` uses `SERVER_FRONT_PORT`; comment updated.
- The `--adopt-cni` "no server was deployed" note: keep, drop the sentence
  about a kind port mapping being the only fronting (it no longer is), and
  point at `--byo` (step 6) as before.

### `packages/server/src/drivers/k8s/install/index.ts`

- Remove `serverPublishedOrigin` and `waitForPublishedServer`; keep the rest.

### `packages/server/src/drivers/k8s/install/check.ts`

- The `NP_SERVER_OPEN` fix text: the two policies by name, the explicit
  allow, and "re-run `yaac cluster install`, or restart the server for the
  node half". The `except the pod CIDRs` sentences in the comment go.

### `packages/server/src/drivers/k8s/install/arg-guards.ts`

- `ClusterInstallArgs.tailnet?: boolean`. No flag-only guard is needed
  (`--tailnet` combines with everything), so `clusterArgError` is unchanged;
  the field exists so the CLI's option type and the install's agree.

### `packages/shared/src/server-config.ts`

- `mintLocalClientToken(origin, readLockFn = readLock)`.

### `packages/shared/src/env.ts`

- The `bindAddr` doc comment: the policy admits the node addresses and the
  fronting, not "everything except the pod CIDRs".

### `packages/cli/src/cli.ts` and `packages/cli/src/commands/cluster-install.ts`

- `.option('--tailnet', 'Publish the server on your Tailscale tailnet through the Tailscale Kubernetes operator (which must already be installed) instead of at 127.0.0.1')`.
- `ClusterInstallCliOptions.tailnet`; passed through as-is.
- `runDeployedServerVerb` prints the origin `startClusterServer` /
  `restartClusterServer` return.

### `packages/test-utils/src/deployed-server.ts`

- Apply `buildServerIngressNpManifest(await nodeIpBlocks())` (node half
  only; the file's `kubectl port-forward` is a CRI-side dial that never
  traverses policy, and nothing else fronts a test server). Drop the
  `clusterPodCidrs` import.

### `k8s/kind-config.yaml`

- Header comment: the port mapping targets the forwarder's node port, not a
  NodePort. No structural change.

## Manifests, environment variables, CLI flags

| Object | kind fronting | tailnet fronting |
|---|---|---|
| Service `yaac-server` | `ClusterIP`, port 8787 | `LoadBalancer`, `loadBalancerClass: tailscale`, `allocateLoadBalancerNodePorts: false`, `tailscale.com/hostname: yaac` |
| Deployment `yaac-server-front` + ConfigMap | hostNetwork Envoy on the control plane, listener 30787 → Service DNS 8787 | none |
| NetworkPolicy `yaac-server-ingress` | node `ipBlock`s (install + server attach) | same |
| NetworkPolicy `yaac-server-ingress-front` | empty ingress | operator proxy pod selector in `tailscale` |
| kind `extraPortMapping` | `127.0.0.1:<port>` → `30787` on the control plane | n/a |
| published origin | `http://127.0.0.1:<port>` | `http://<hostname>.<tailnet>.ts.net` from the Service status |

Environment the Deployment states, beyond today's: `YAAC_ALLOWED_HOSTS` and
`YAAC_TRUST_PROXY` from the fronting, unioned with the install shell's. No
new variable; no server-side read changes.

CLI: `yaac cluster install --tailnet`. Nothing else gains a flag;
`yaac server start|restart` change only what they print.

## Migration and legacy-compat shims

**No shim is required, and none should be added.** Every object this step
changes is converged in place by `kubectl apply` on the next
`yaac cluster install`, which is already the documented upgrade:

- The Service changes type `NodePort` → `ClusterIP`; apply handles a type
  change when the manifest carries no `nodePort`. Install applies the
  Service before the forwarder, so kube-proxy releases 30787 on the node
  before Envoy binds it.
- `yaac-server-ingress` keeps its name; apply replaces its rule set. The new
  `yaac-server-ingress-front` is created.
- The port mapping written into an existing cluster targets 30787, and the
  forwarder binds 30787, so no cluster has to be recreated. This is the one
  hard constraint the step inherits: `SERVER_FRONT_PORT` must keep the value
  `SERVER_NODE_PORT` had, and its doc comment says why.
- A cluster not yet re-converged (Service still `NodePort`) keeps answering
  at the loopback origin through the old path, and `frontingOfService`
  reads a NodePort Service as the kind fronting by the general rule
  ("anything that is not the tailnet class"), not by a special case. A new
  CLI against an old cluster therefore works before and after the
  re-install, with no read-time normalizer.
- `server.json` is unchanged on kind: same origin, same token, same driver.

The unit test for the converge path ("applies a ClusterIP Service with no
nodePort, and the forwarder after it") is what stands in for the migration
test; the manual gate below runs it against the rig's existing cluster
rather than a fresh one for the same reason.

If a reviewer wants an entry in docs/legacy-compat-shims.md anyway, the
only candidate is the `frontingOfService` rule reading a NodePort Service as
kind-fronted — and it should be declined: the rule is the same one that
answers for the e2e harness's Service-less deployment, so deleting "the
NodePort case" would delete nothing.

## Tests

### Unit (`pnpm vitest run --project unit:server`)

`packages/server/test/drivers/k8s/cluster/policy-manifests.test.ts`
(barrel functions defined in `policy-manifests.ts`; both are on the barrel,
so both get a `describe` here — today the server policy is asserted only
in the install suite, which the file's own comment calls out):

- `buildServerIngressNpManifest`: "admits exactly the node addresses it is
  given, on the server port, and nothing pod-shaped" — every `from` entry is
  an `ipBlock` from the input, no `podSelector`, no `except`, the pod
  selector is the server's, `policyTypes` is `['Ingress']`.
- `buildServerFrontIngressNpManifest`: "renders the fronting's peers, and an
  empty ingress for none" — the tailnet peer's namespace and pod selectors
  round-trip; an empty input renders `ingress: []`.

`packages/server/test/drivers/k8s/install/server-deploy.test.ts`
(process boundary mocks unchanged: kubectl, the registry, `fetch`; the
`kubectlGetJson` mock now also answers `get svc yaac-server` with whichever
Service the case installed, and `kubectlWithRetry` answers the lock `cat`
with a lock JSON):

- `deployServerWorkload` — replace "walls the API off from pods, on a
  NodePort the host maps" with "walls the API to the node addresses and the
  fronting, and publishes it through the kind forwarder": `yaac-server-ingress`
  carries the seeded node `/32`s and nothing else; `yaac-server-ingress-front`
  has an empty ingress; the Service is `ClusterIP` with no `nodePort`; the
  `yaac-server-front` Deployment is hostNetwork, control-plane-pinned,
  tolerates the taint, runs the Envoy mirror ref, drops all capabilities;
  the ConfigMap's bootstrap names port 30787 and the Service FQDN; the
  Service is applied before the forwarder; both policies before the
  Service.
- "publishes through the tailnet when told to": with
  `fronting: tailnetFronting({ hostname: 'yaac' })` and the Service mock
  returning `status.loadBalancer.ingress[0].hostname =
  'yaac.tail1234.ts.net'` on the second read, the Service is `LoadBalancer` /
  `loadBalancerClass: tailscale` / `allocateLoadBalancerNodePorts: false` with
  the hostname annotation; the front policy's peer selects the operator
  namespace and the parent-resource labels; the Deployment env states
  `YAAC_ALLOWED_HOSTS=yaac.tail1234.ts.net` and `YAAC_TRUST_PROXY=1`; the
  origin waited on and returned is `http://yaac.tail1234.ts.net`; the log
  carries the REQUIRE-a-credential note; `server.json` records that origin
  with a non-empty token.
- "refuses when the operator never publishes a hostname": Service status
  stays empty; rejects with a `ClusterInstallError` naming the operator,
  and the Deployment was not applied.
- "unions the fronting's hosts with the shell's": `YAAC_ALLOWED_HOSTS` set
  in the env plus the tailnet fronting → both names in the pod's variable.
- "mints the durable token with the lock the pod holds": the exec argv
  contains `deployment/yaac-server` and `.server.lock`; no host lock exists
  in the temp data dir, and the token in `server.json` is the one the
  mocked `/tokens` POST returned.
- Keep the existing env, Tor, RBAC and host-lock cases; update the
  "applies an identity, a wall and a workload" ordering case to count both
  policies and the forwarder.
- `startClusterServer` — "waits on the origin the live Service implies":
  a NodePort or ClusterIP Service (and no Service) → the loopback origin
  returned; a tailscale-class Service with a published hostname → that
  origin, and `fetch` was called against it.
- `restartClusterServer` — same derivation after the rollout restart.
- `waitForPublishedServer`'s two cases move under `startClusterServer`
  (the diagnosis text on a refusing origin; waiting out `ready: false`),
  since the function leaves the barrel.

`packages/server/test/drivers/k8s/install/install.test.ts`:

- "creates the cluster …": the create call still renders
  `containerPort: 30787`; `deployServer` was called with a fronting whose
  `kind` is `'kind'`.
- "`--tailnet` refuses before anything is applied when the operator is
  absent": `run` answers `kubectl get crd proxyclasses.tailscale.com` with
  a not-found; rejects naming `helm`, and neither `ensureRegistry` nor
  `deployServer` was called.
- "`--tailnet` reports a check it could not evaluate rather than absence":
  the CRD read fails with a connection error → the message says "could not
  evaluate", not "not installed".
- "`--tailnet` hands the tailnet fronting to the server deploy": both
  reads answer; `deployServer` was called with `fronting.kind === 'tailnet'`.
- The adopt case: `--adopt-cni --tailnet` still deploys no server; the
  note no longer mentions a port mapping.

`packages/server/test/drivers/k8s/install/check.test.ts`:

- "fails the egress check when a session pod reaches the server": probe
  logs `NP_BLOCKED\nNP_SERVER_OPEN` with a server Service present → `fail`,
  detail names the yaac server, fix names both policy objects.

`packages/server/test/drivers/k8s/lifecycle.test.ts`:

- The attach case asserts `yaac-server-ingress` is applied with the seeded
  node addresses, and that a failing apply logs and still attaches.

`packages/cli/test/cluster-install.test.ts`:

- The pass-through case includes `tailnet: true`.

`packages/shared/test/server-config.test.ts`: "authenticates the mint with
the lock reader it is handed" — a reader returning a lock with secret `s` produces
`Bearer s` on the revoke and create calls.

### API matrix

No route is added, removed or changed by this step, so
`test/api/route-matrix.ts` has no new row and `assertMatrixCoversEveryRoute`
stays green as is. Say so in the PR rather than leaving it implicit.

### e2e-containerless

Nothing: the fronting, the wall and `--tailnet` are k8s-only, and a
containerless install refuses every `yaac cluster` verb before loading it.
`test/e2e-containerless/remote-cli.test.ts` already covers `yaac remote set`
end to end against a loopback origin; the tailnet gate below exercises the
same command across a real network.

### k8s e2e

`test/e2e-cli/cluster-cli.test.ts` (every CLI option needs a case):

- "`--tailnet` refuses a cluster whose operator it cannot read, before
  anything is applied": `--adopt-cni --tailnet` with the bogus `KUBECONFIG`
  → exit 1, stderr matches the operator refusal and "could not evaluate",
  stdout shows no "Deploying the in-cluster image registry" and no
  "Creating kind cluster". Same skip condition as the adopt cases (Linux,
  podman on PATH).

`test/e2e-cli/server.test.ts` (the file already holds one deployed server):

- "a worktree-labelled pod cannot reach the server pod, and the kubelet
  can": run a `worktreeIdLabels`-labelled busybox pod on the gVisor class in
  the file's namespace that `nc -w 4 <server pod IP> 8787`; expect the
  blocked verdict. The second half is implicit and stated in the assertion
  message: the Deployment rolled out, so the readiness probe from the node
  was admitted by the same policy.
- The existing start/restart cases keep their `server (re)started at
  http://127.0.0.1:` assertions — that is `frontingOfService` answering
  "no Service → kind" for the harness's deployment.

The kind forwarder is not exercised by a vitest tier: the harness reaches
its per-namespace server by port-forward, and a second forwarder per
namespace would race the real install for the node port. It is covered by
the install gate below, single-node and `--nodes 3`.

## The gate, as a procedure

All of it on the test rig (its own cluster, data dir and kubeconfig — see
the `yaac-test-rig` memory), from a built worktree (`pnpm build` first).

1. `pnpm lint`, then `pnpm vitest run --project unit:server
   packages/server/test/drivers/k8s`, then `pnpm vitest run --project
   unit:cli --project unit:shared`. Green.
2. **Converge the existing single-node cluster** (the migration path):
   `yaac cluster install`. Watch for: the Service reported as configured
   (not recreated), `yaac-server-front` rolling out, the origin answering,
   "Cluster is ready". Then `kubectl -n yaac get svc yaac-server -o
   jsonpath='{.spec.type}'` prints `ClusterIP`; `kubectl -n yaac get
   networkpolicy` lists both `yaac-server-ingress` and
   `yaac-server-ingress-front`; `curl -s 127.0.0.1:8787/health` reports
   ready; `yaac worktree list` answers.
3. **The wall**: `yaac cluster check` — the `egress` line reads "cannot
   dial … the yaac server" and the whole check is green. Then `yaac server
   restart` (prints the loopback origin) and `yaac server stop` / `start`.
4. **Three nodes**: `yaac cluster delete`, `yaac cluster install --nodes 3`.
   `kubectl -n yaac get pod -l app=yaac-server -o wide` shows the server on
   a WORKER and `yaac-server-front` on the control plane; the origin answers;
   `yaac cluster check` green including `egress`. This is the case the
   `except` form is expected to have failed, so its passing is the
   multi-node half of the gate.
5. **E2e**: `pnpm vitest run --project e2e-cli` and `--project e2e` in the
   background, read from their output files. Green, including the new
   server.test.ts and cluster-cli.test.ts cases.
6. **Tailnet on kind**: on the rig, install the operator with the helm
   command above (an OAuth client with `tag:k8s-operator`, tailnet ACL
   granting it `tag:k8s`), then `yaac cluster install --tailnet`. Install
   prints the tailnet origin and the REQUIRE-a-credential note;
   `server.json` on the rig holds that origin and a token; `yaac worktree
   list` on the rig works through it. On a second tailnet device: `yaac
   auth token create laptop` on the rig, `yaac remote set
   http://yaac.<tailnet>.ts.net --token <t>` on the laptop, `yaac worktree
   list` answers, and the browser opens the printed `yaac open` URL. Then
   `yaac cluster check` on the rig is green with the wall proved, and
   `yaac cluster install` (no flag) puts the loopback fronting back.
7. Record in the PR what steps 2, 4 and 6 printed, verbatim for the origin
   lines and the `egress` line.

## Open questions and risks

- **TLS on the tailnet.** The parent plan says `loadBalancerClass:
  tailscale` and "real TLS", and the operator gives only one of those per
  object: an L4 LoadBalancer Service is raw TCP over WireGuard, and TLS
  (Let's Encrypt via `tailscale serve`, tailnet-only) comes from an Ingress
  with `ingressClassName: tailscale`. This step ships the Service form as
  written, at an `http://` origin, with `YAAC_TRUST_PROXY=1` doing nothing
  until something sets `X-Forwarded-Proto`. Decide before step 6: keep L4
  (the wire is encrypted; the cookie is not `Secure`) or switch the tailnet
  fronting to the Ingress form (the seam absorbs it; the parent plan's "no
  Ingress" then has to mean "no public Ingress"). The recommendation is the
  Ingress form, because `docs/remote-hosting.md`'s whole cookie posture
  assumes a TLS-terminating proxy that sets that header.
- **The operator's Service parent-type label value** is read off a live
  proxy pod during gate step 6 and added to the peer selector then;
  the first cut selects on `parent-resource` + `parent-resource-ns`, which
  is already exact for one Service name in one namespace.
- **SNAT off in a ProxyClass** presents the tailnet source (`100.x`) to the
  policy and is dropped. Fails loud at `waitForPublishedServer`, with a
  diagnosis that names it; step 6's operator probe can refuse it up front.
- **Node CIDR freshness on the node half** depends on the server re-applying
  at attach. A server pod rescheduled onto a node added AFTER its last
  attach boots into a policy that does not yet admit that node's kubelet;
  the container still starts, attach re-renders the policy, and the probe
  passes within its 120s window. If attach ever moves later than boot, this
  breaks silently — the lifecycle unit test pins the ordering.
- **The forwarder binds a node port cluster-wide.** Two installs sharing one
  kind cluster (a non-default `YAAC_K8S_NAMESPACE`) contend for 30787 on
  the control plane. The same was true of the pinned NodePort; not new, but
  now a scheduling failure (`Pending`, port in use) rather than an apply
  error. Install's rollout wait names the Deployment.
- **Envoy STRICT_DNS through `ClusterFirstWithHostNet`** relies on the host
  netns reaching CoreDNS's ClusterIP through kube-proxy, which the adoption
  gate already requires ("kube-proxy owning ClusterIP DNAT"). If a cluster
  ever breaks that, the forwarder's fallback is a `STATIC` cluster on the
  Service's ClusterIP read after the Service apply.
- **`kubectl exec` for the mint** needs the pod Ready and `sh` in the image
  (Ubuntu base: yes). Under the e2e tiers the harness keeps the host reader,
  so the exec path is covered by unit tests and the manual gate only; the
  gate's step 2 is the real run.
- **macOS is not on the rig.** The forwarder design is chosen precisely so
  no platform-specific source address is guessed, but the converge path
  (NodePort → ClusterIP, forwarder up, origin answering) should be run
  once on a Mac before release.

## Suggested commit order

Each lands green on `pnpm lint` and the unit projects; the k8s gate runs
after 4 and again after 7.

The order is forced by one dependency: the explicit-allow policy admits
the kind path only once the forwarder exists (a NodePort presents the
host's source, which the node addresses do not cover), while the forwarder
works fine behind today's `except` rule. So the forwarder lands first and
the policy second, never the other way round.

1. **The fronting seam and the kind forwarder**: `server-fronting.ts`
   (`ServerFronting`, `kindFronting`, `frontingOfService` with only the
   kind branch), `SERVER_NODE_PORT` → `SERVER_FRONT_PORT`, the ClusterIP
   Service, `deployServerWorkload` on the new sequence (still applying
   today's `except`-shaped policy through an unchanged
   `buildServerIngressNpManifest(podCidrs)`), `startClusterServer` /
   `restartClusterServer` returning the origin, `serverPublishedOrigin`
   deleted, the CLI printing what start returns, `install.ts` choosing
   `kindFronting()`, the `kind-config.yaml` comment, `server-deploy.test.ts`
   and `install.test.ts` updated. Run gate steps 2 and 4 here (the wall line
   of step 3 is still the old rule's).
2. **The wall, in two objects**: the two builders in `policy-manifests.ts`,
   the new constants, the cluster barrel export, `ingressPeers()` on the
   fronting, install and the harness applying node addresses plus the front
   policy, `policy-manifests.test.ts`, the wall assertions in
   `server-deploy.test.ts`, `check.ts`'s fix text and `check.test.ts`'s new
   case, the `env.ts` comment. Run gate steps 2–4 in full.
3. **The server re-applies the node half**: `lifecycle.ts` attach,
   `lifecycle.test.ts`.
4. **The pod-lock mint**: `mintLocalClientToken`'s reader parameter, the
   exec reader in `server-deploy.ts`, shared and install unit cases. Gate
   step 2 again (a re-install on the converged cluster).
5. **The tailnet fronting**: `tailnetFronting`, `frontingOfService`'s
   tailscale branch, `buildServerEnv`'s `remoteHosting` merge, the
   tailnet cases in `server-deploy.test.ts`.
6. **`--tailnet`**: the CLI option, `ClusterInstallOptions.tailnet`,
   `verifyTailnetOperator`, the install and CLI unit cases, the e2e-cli
   refusal case. Gate step 6.
7. **E2e and docs**: the server.test.ts wall case; docs/server-in-cluster.md
   ("What is deployed", "Reachability", "The ingress policy is the wall"
   rewritten for the two policies and the forwarder, the NodePort caveat
   deleted, a "Publishing on a tailnet" subsection for `--tailnet`),
   docs/cluster-setup.md (the install summary and the `--adopt-cni` section's
   port-mapping sentence), docs/remote-hosting.md (a k8s install can be
   fronted by `--tailnet` instead of a host `tailscale serve`; the cookie
   caveat from the open question), README (`--tailnet` in the options
   block and the remote-hosting paragraph), docs/worktree-egress.md if it
   names the server policy's shape anywhere (it does not today; check).
   Full e2e-cli and e2e runs (gate step 5).
