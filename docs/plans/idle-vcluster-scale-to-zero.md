# Idle vcluster scale-to-zero (born-at-zero, wake-on-access)

Proposal. A `virtualCluster` session's per-session vcluster should run **zero
apiserver and zero CoreDNS pods — and so consume ~no memory — until the first
thing tries to access its API**, then cold-start on demand in a few seconds and
stay up for the rest of the session.

This is "Tier A": reclaim the control plane of a vcluster that has been created
but not yet used. Re-sleeping a vcluster that has already done work ("Tier B")
needs a quiescence detector and is out of scope here (see the end).

## Why — the idle cost being reclaimed

Each `virtualCluster` session gets its own vcluster: one control-plane pod
(kube-apiserver + kube-controller-manager + kine/SQLite + the vcluster syncer)
plus a CoreDNS pod, running for the session's entire lifetime with no
idle/sleep logic anywhere. Measured on a live idle vcluster in-session:

- apiserver **RSS ≈ 180 MB**, ~2190 goroutines, `GOGC=100`, `GOMEMLIMIT` unset,
  yet only **~249 stored objects** — i.e. the footprint is fixed Go-runtime
  baseline (API type registry, OpenAPI specs, admission, P&F), not data.
- Idle datastore write churn **≈ 0.58 writes/s**, of which **~86 % is KCM
  leader-election lease renewal** (every ~2 s) — pure overhead on an idle
  cluster.

So an idle vcluster's control plane is almost entirely overhead. Born-at-zero
reclaims the whole ~180 MB apiserver + the rest of the control-plane pod +
CoreDNS, per unused vcluster, until something actually needs the API.

(Flag/env tuning — `--leader-elect=false`, trimmed controllers, `GOGC`,
disabling prewarm/image-prewarm when nested — is a complementary "reduce the
always-on floor" lever, tracked separately; it helps vclusters that *can't*
sleep. This doc is the reclaim-it-entirely lever.)

## Current shape (verified in-session unless noted)

- **The control plane renders as a `Deployment`, not a StatefulSet.** The chart's
  `vcluster.kind` helper picks a Deployment whenever `volumeClaim` is off and
  embedded-etcd is off — exactly this embedded-SQLite setup. `getVclusterStatus`
  reads `deployment/<name>` for readiness. So "scale to zero" is
  `kubectl scale deployment <name> --replicas=0`.
- **PKI and data live in `emptyDir`s.** The chart mounts a `certs` emptyDir at
  `/pki` and a `data` emptyDir at `/data`. A fresh control-plane pod therefore
  **regenerates its own CA + leaf certs**. (Newer vcluster docs describe the PKI
  at `/data/pki/`; the 0.34.3 chart mounts `certs` → `/pki`, so the exact path
  in this version must be confirmed host-side — see Verification.)
- **The kubeconfig is a static file**, captured once at session-create
  (`waitForVclusterKubeconfig`), written to the session dir and dir-mounted at
  `~/.kube`. Its server is the API-host FQDN
  `https://<name>.<vc-ns>.svc.cluster.local:8443`, and it embeds a **CA + a
  `system:masters` client cert + key** (all three minted at the single boot).
  It does not change when the control plane restarts.
- **The API host resolves via the *host* cluster's CoreDNS** to the
  control-plane Service ClusterIP (a `10.96.x` address), independent of the
  vcluster's own CoreDNS pod (a `10.244.x` pod IP). Confirmed by resolving it
  from inside the session. → Scaling the *vcluster's* CoreDNS to 0 does not
  break API-host resolution.
- **CoreDNS is a Deployment inside the vcluster**, synced to a host pod. →
  Scaling the virtual `coredns` Deployment to 0 makes the syncer drop the synced
  host pod.

## The core problem, and the fix

Born-at-zero means scaling the control plane `0 → 1` on demand. But because the
PKI is in an `emptyDir`, a fresh pod mints a **new CA**, which would invalidate
the already-mounted kubeconfig (embedded CA + client cert). The fix is to
**persist the PKI (and the data dir) on a node-local volume** so the on-demand
boot reuses the existing CA/certs and the mounted kubeconfig stays valid.

## Design

```
create → apply manifests (certs+data on a persistent node volume; replicas
         field stripped so yaac owns it) → control plane boots ONCE →
         waitForVclusterKubeconfig → write kubeconfig into the session mount →
         scale control-plane + CoreDNS to 0
           │  steady state: 0 apiserver, 0 CoreDNS, ~0 MB
           ▼
first access → session pod dials API ClusterIP:8443 → activator catches the
         connection → signals the outer server → scale control-plane (+CoreDNS)
         to 1 → boot REUSES persisted PKI (kubeconfig still valid) →
         waitForVclusterReady → connection passed through → stays up
```

### 1. Persist the PKI (and data) — post-render step

Extend the existing post-render transform (`addYaacLabels` in
`renderVclusterManifests`, which already parses every rendered doc) to rewrite
the control-plane pod's `certs` (`/pki`) and `data` (`/data`) `emptyDir` volumes
into node-local persistent volumes keyed by vcluster name. The control-plane pod
runs on runc (trusted infra), so hostPath ownership is handled with an `fsGroup`
or a chown init-container — none of the gVisor virtiofs-ownership constraints
apply to it. Keep it a **Deployment**: do *not* flip the chart's `volumeClaim`
on, which `vcluster.kind` would turn into a StatefulSet and ripple through the
readiness and scale code. (Persisting `/pki` is load-bearing; persisting `/data`
is cheap and sets up Tier B.)

Alternative considered: enabling the chart-native
`controlPlane.statefulSet.persistence.volumeClaim.enabled` persists `/data`
(and, if this version keeps PKI under `/data/pki`, the PKI too) via a real PVC —
but it converts the control plane to a StatefulSet and still leaves the separate
`/pki` emptyDir unpersisted. The post-render approach covers whichever
volume(s) actually hold the PKI in one place and avoids the shape change.

### 2. Let yaac own replicas out-of-band — same post-render step

Strip `spec.replicas` from the control-plane and CoreDNS Deployments. The first
`apply` then defaults to 1 (the create-time boot); afterwards `kubectl scale`
sets 0/1 and later re-applies (server restart, re-ensure) won't stomp the value
because the field is absent from the applied config. This is what makes
"scaled to 0" durable.

### 3. `sleepVcluster` / `wakeVcluster` (in `vcluster.ts`)

- **Sleep**: scale control-plane Deployment → 0, and scale the *virtual*
  `coredns` Deployment → 0 (via the vc kubeconfig) so the syncer removes its
  host pod.
- **Wake**: scale control-plane → 1, `waitForVclusterReady`, restore virtual
  `coredns` → 1, re-run `reconcileInnerRedirects` for the vcluster.

### 4. `create.ts` — born-at-zero end state

After `waitForVclusterKubeconfig` and writing the kubeconfig file, call
`sleepVcluster`. This is the "boot once at create, then 0".

### 5. The activator (the one genuinely new component)

A single, always-on, TCP-**passthrough** pod shared across the install (fixed
cost — one pod total, not per-vcluster, so the per-idle-vcluster footprint stays
zero). While a vcluster is asleep, its API Service points at the activator. On
the session pod's first connection to the API ClusterIP:8443, the activator
triggers `wakeVcluster`, **holds the connection** until the apiserver is ready,
then passes it through — so a long-lived client (an inner informer, `kubectl`)
sees a *slow* connect, not a failure, and never needs to retry. It terminates no
TLS (passthrough), so it needs no cert.

Interception mechanism — two candidates:

- a yaac-managed **EndpointSlice** on the API Service pointing at the activator
  while asleep (removed on wake so the Service selector takes over), or
- a per-vcluster **Cilium CEC redirect** of the API host → activator that the
  outer server applies on sleep / removes on wake.

The second fits yaac's existing Cilium-native datapath (the outer server is
already the sole host writer of CEC/CNP) and is the leaning choice.

### 6. Status + reconcilers

Add `asleep` / `waking` to the `SessionDetail.virtualCluster` status block, and
make `reconcileVclusters` and `reconcileInnerRedirects` skip asleep vclusters
(their apiserver is intentionally down). Wake must never leave a session stranded
on a cluster that failed to come back: on wake failure (PVC lost, apiserver
won't boot) surface it in the status block rather than hang.

## Wake semantics, latency, races

- Sleep is a controlled scale, not a crash: the outer session pod is untouched,
  and any client of the vcluster API pauses (connection held) rather than
  erroring.
- Cold start is a few seconds (apiserver init + SQLite open); acceptable per the
  agreed latency budget.
- "Outer agent idle before first use" is the only sleep trigger in Tier A, and
  the vcluster stays up after the first wake — no re-sleep, so no wake/sleep
  thrash mid-session.
- The containment objects (VAP guard, per-vcluster fallback CNP, projected
  redirects) are host objects that persist through sleep, and nothing runs while
  asleep, so the security floor is unaffected.

## Verification status

Verified in-session (this doc's "Current shape" claims):

- kubeconfig structure and its CA + `system:masters` client-cert dependency;
- API-host resolves via host CoreDNS to a `10.96.x` Service ClusterIP,
  independent of the vcluster's own CoreDNS pod;
- CoreDNS is an in-vcluster Deployment synced to a host pod;
- apiserver RSS ≈ 180 MB and idle write churn ≈ 0.58/s (≈86 % KCM
  leader-election);
- control plane is a Deployment (chart `vcluster.kind` + the readiness code).

Not verifiable from inside a session (host-cluster access, which the session
holds no credentials for) — each with the concrete host-side test to run:

- **Linchpin: a `0 → 1` reboot with a persisted `/pki` reuses the CA rather than
  regenerating it.** vCluster's certificate docs support this (cert *rotation*
  re-signs new leaves with the **existing** CA, and a restart reloads
  in-memory-cached certs) — i.e. the CA persists and is reused when the PKI dir
  is present. Confirm directly: persist `/pki`, delete the control-plane pod,
  and diff the served CA / the kubeconfig's embedded CA before and after.
- **Exact 0.34.3 PKI path** (`/pki` emptyDir vs `/data/pki`): `kubectl exec` the
  control-plane pod and `ls -la /pki /data/pki`, so the persist step targets the
  right volume(s).
- **hostPath ownership** for the runc control-plane pod (fsGroup vs chown-init),
  or a `standard`/local-path storageClass if PVCs are preferred.
- **Activator interception** behavior (EndpointSlice vs CEC redirect; that a
  held connection completes its TLS handshake against the woken apiserver).

## Out of scope

- **Tier B** — re-sleeping a vcluster that has done work, which requires a
  quiescence predicate (no pods but control-plane + CoreDNS), an idle timer, and
  handling the persistent inner `yaac-proxy` Deployment (which today never scales
  down). Tier A's persisted `/data` is a stepping stone.
- Making the inner yaac server defer its apiserver watches until it has work (an
  adjacent optimization; without it, a session whose init starts an inner server
  wakes its vcluster immediately).
- The always-on-floor flag/env tuning (leader-election off, `GOGC`,
  prewarm/image-prewarm off when nested).
