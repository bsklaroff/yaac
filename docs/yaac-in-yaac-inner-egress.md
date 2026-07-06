# yaac-in-yaac inner egress — transparent inner redirect via daemon projection

> **Status: shipped.** This is a current-state reference for the implemented
> mechanism, not a proposal. It is cross-referenced from the code (see
> `src/lib/k8s/bootstrap.ts` and `src/lib/session/inner-redirect-reconcile.ts`).
> Landed across commits `93102fb` (foundation), `5ae757d`, `22a0209`,
> `cb10137`, `d50ea2f`, `1d5ea5e` (shared fallback CCEC), `9987b1d` (suites pass
> nested).

## What it does

A `virtualCluster` session can run an **inner yaac** (`YAAC_NESTED=1`) against
its vcluster, creating inner sessions with their **own** proxy + allowlist. Each
inner session's egress is **transparently** redirected to the inner proxy at
higher precedence than the outer redirect, and chains through the outer proxy for
anything the inner allowlist doesn't specially handle. Allowlists compose by
**intersection** (inner ∩ outer), fail-closed at both layers.

"Transparent" means the inner yaac runs the **same** code path as a top-level
yaac (one API target — its vcluster), with no nesting-aware branching in its
egress setup and **no host-cluster credentials in the session pod**. This builds
on the Cilium egress model (commit `f1fbd33`): a CEC + CNP redirect selecting a
label, EDS upstream, source-IP identity via a pods-watch.

## Design: daemon projection (the chosen approach)

The inner yaac targets **only** its vcluster for everything, including its
CEC/CNP. The **outer daemon** (sole host cluster-admin) watches each managed
vcluster, recognizes yaac's own egress-redirect shapes, and **rebuilds** the
equivalent host CEC/CNP from its own trusted builders — re-scoped to the
vcluster's `managed-by` selector and retargeted at the host-synced inner proxy.

The session keeps **zero** host authority; the daemon never copies untrusted
policy, so a tenant cannot author an escape. (The rejected alternative — handing
the session a narrow host SA token so the inner yaac writes host CEC/CNP directly
— couldn't be transparent: the inner yaac's primary API is its vcluster, so its
host-policy writes would have to be routed to a *different* API than everything
else, and it would put a host credential in the agent's pod.)

## Topology & data path

```
HOST cluster (Cilium)         ns: yaac
  outer proxy + outer CEC/CNP redirect   (selects yaac.session-id Exists)
  outer daemon = host cluster-admin

  outer session pod  (virtualCluster; label yaac.session-id=<outerSid>)
    └ runs INNER yaac daemon  (YAAC_NESTED=1, KUBECONFIG=vcluster)
        creates inner sessions as pods IN the vcluster  yvc-<sid>
        runs ensureProxyResources against the vcluster → inner proxy + CEC/CNP

  vcluster yvc-<sid> syncs to host:
    - inner session pods   → host pods, label managed-by=<vc>   (the workload)
    - inner proxy Deploy/Svc/SA → host pod + Service            (the inner proxy)
    - inner CEC/CNP        → NOT synced (CRDs); the daemon PROJECTS them

  Host redirect stack for the vcluster's synced pods (managed-by=<vc>):
    (fallback) managed-by=<vc>          → OUTER proxy   [low precedence, prio 90]
    (override, ONE PER INNER INSTALL)
               managed-by=<vc>, data-dir-hash=<install>, role!=inner-proxy
                                        → that install's INNER proxy
                                                        [normal precedence, prio 50]
    inner-proxy pods' own egress: excluded from the overrides → caught by the
       fallback redirect → OUTER proxy → internet   (chaining/fallback)
    synced pods with NO install label (e.g. e2e mock pods): no override
       matches → fallback → OUTER proxy

  Several inner installs can share one vcluster — the nested session's ambient
  daemon plus any per-run e2e daemons spawned inside it, each with its own
  proxy. The install key is the `yaac.data-dir-hash` label every daemon already
  stamps on its session pods and (since the per-install scheme) on its proxy
  Deployment pods + Service; tenant labels ride the sync verbatim.
```

Data path for an inner-session pod's `curl https://api.example`:
1. Cilium redirects 443 via the **override** CNP (prio 50 beats the prio-90
   fallback) → node Envoy → **inner proxy** (host-synced).
2. Inner proxy reads PP2 srcIp = the pod's host IP and resolves it to an inner
   session-id (the vcluster pod's `status.podIP` is the host IP), → inner
   allowlist → MITM/judge.
3. Inner proxy dials the real upstream. Its egress (`yaac.role=inner-proxy`,
   excluded from the override) is caught by the fallback redirect → **outer
   proxy** → judged against the **outer** allowlist → internet. The inner proxy
   trusts the outer CA (`NODE_EXTRA_CA_CERTS`, via the projected
   `yaac-outer-proxy-ca` ConfigMap; see `OUTER_CA_CONFIGMAP_NAME`).
4. Net: inner ∩ outer allowlist, fail-closed at both layers, no proxy code change.

## Control path: the projection loop

`reconcileInnerRedirects` in `src/lib/session/inner-redirect-reconcile.ts`,
wired as a background-loop tick step in `src/daemon/background-loop.ts`. One pass
per managed vcluster (`listVclusterNamespaces`):

1. **Discover the inner proxies.** `findInnerProxyServices` lists the
   host-synced inner-proxy Services in the vcluster's namespace — matched by the
   `managed-by=<vc>` label plus the preserved `yaac-proxy` name prefix (the
   syncer translates the name) — one per inner install, keyed by each Service's
   `yaac.data-dir-hash` label. A Service's presence is that install's
   **opt-in**; a `yaac-proxy` Service *without* the install label (an inner
   yaac predating the per-install scheme) is ignored (logged once): its pods
   stay on the outer fallback — recreate the nested session to upgrade.
2. **Rebuild, don't copy.** The daemon never reads tenant-authored selectors;
   it rebuilds host objects from trusted builders in `src/lib/k8s/bootstrap.ts`,
   one CEC+override pair per install (names suffixed `-<installHash>` via
   `innerRedirectObjectName`):
   - `buildInnerEgressRedirectCecManifest(vcNamespace, innerProxyService,
     installHash)` — the EDS redirect CEC (same three listeners as the outer
     CEC) retargeted at that install's host-synced inner proxy Service.
   - `buildInnerSessionEgressRedirectCnpManifest(vcNamespace, vcName,
     installHash)` — the override CNP: `endpointSelector` = `managed-by=<vc>`
     AND `yaac.data-dir-hash=<install>` AND `yaac.role NotIn inner-proxy`,
     egress 443/80/SSH → that install's inner CEC listeners at
     `SESSION_REDIRECT_PRIORITY`.
   - `buildInnerProxyIngressCnpManifest(vcNamespace, vcName)` — SHARED per
     vcluster (unsuffixed `INNER_PROXY_INGRESS_CNP_NAME`): locks every inner
     proxy's transparent ports to the redirected `managed-by=<vc>` identity and
     the control port to the host; the rules are install-independent.
3. **Apply/prune.** All projected objects carry
   `yaac.projection=inner-redirect` (per-install ones also the install hash).
   Each tick prunes labeled objects whose install no longer has a proxy (and
   the pre-per-install fixed-name CEC/CNP, unconditionally), then applies the
   pairs for every live install plus the shared ingress lock (idempotent,
   `--ignore-not-found`). The prune listing keys on the projection label —
   NEVER on `app` alone, which the untouchable egress floor shares. The
   objects live in the vcluster's host namespace, so they cascade on namespace
   teardown.

The inner proxy itself is **not** projected — it's an ordinary vcluster workload
that syncs to the host on its own (Deployment + Service). Only the *datapath
redirect* (CEC/CNP) needs host projection.

## Priority model (shipped)

`src/lib/k8s/bootstrap.ts:108-109`. `toPorts.listener.priority`: **lower number
= higher precedence**; unset is the lowest (~126).

- `SESSION_REDIRECT_PRIORITY = 50` — the SAME normal value used by **every**
  yaac's session-egress redirect (outer top-level and inner alike). Because it is
  uniform, an inner yaac is fully transparent: there is no daemon-assigned
  per-level band and no nesting-aware priority arithmetic. The override the
  daemon projects for a vcluster's session pods uses this value.
- `VCLUSTER_FALLBACK_PRIORITY = 90` — the outer yaac's deliberately
  low-precedence fallback redirect for a vcluster's synced pods (→ the outer
  proxy). It gives synced pods working, allowlisted egress from the moment they
  exist (before/without any inner yaac), and the inner override (prio 50) beats
  it (50 < 90) for the session pods, while the inner-proxy pod — excluded from
  the override — stays on the fallback and chains to the outer proxy (loop-free).

`vcluster-in-vcluster is rejected`, so there is exactly one nesting level and no
band exhaustion to reason about.

> **Undocumented-API guard.** `listener.priority` is undocumented; lower-wins is
> empirical (spike re-confirmed 2026-06-16). The mandatory e2e
> `test/e2e/inner-redirect-priority.test.ts` pins the explicit-vs-explicit
> override case and must be re-run on every Cilium upgrade — treat a regression
> as a release blocker.

## Shared fallback CCEC (avoids per-vcluster Envoy churn)

The fallback's redirect **listeners** live in a single **shared, cluster-scoped**
`CiliumClusterwideEnvoyConfig`, not a per-vcluster CEC:

- `buildVclusterFallbackRedirectCcecManifest()` — one CCEC per install,
  EDS-backed by the outer proxy. Its name is install-scoped via
  `vclusterFallbackCcecName(namespace)` (suffixes `VCLUSTER_FALLBACK_REDIRECT_NAME`
  with the install namespace) so the real `yaac` install and ephemeral e2e
  `yaac-test-<run-id>` installs coexist on one cluster.
- `buildVclusterFallbackRedirectCnpManifest(vcNamespace, vcName)` — each
  vcluster keeps its **own** fallback CNP (for tenant isolation) but references
  the shared CCEC **cross-namespace by `kind: CiliumClusterwideEnvoyConfig`** (a
  CNP's `listener.envoyConfig` ref carries no namespace; a CCEC needs none).

Why shared: creating/destroying a vcluster then adds/removes **no** Envoy
listeners. A per-vcluster CEC would churn listeners on every session, triggering
a node-wide "regenerate all endpoints" that wedges every session's egress. The
CCEC is cluster-scoped, so it does **not** cascade on namespace deletion — it is
torn down explicitly (e2e global-setup cleanup; install teardown). The inner
**override** CEC stays per-vcluster — its upstream is each vcluster's own inner
proxy. (This shared-CCEC change landed in commit `1d5ea5e`.) The per-vcluster
fallback CNP is the vcluster's unforgeable egress floor — default-deny + exactly
443/80/SSH → outer proxy + intracluster/DNS — see
`buildVclusterFallbackRedirectCnpManifest`.

## Attribution

Two complementary mechanisms resolve a redirected pod's host IP to a session:

- **Inner sessions → inner proxy.** The stock inner proxy watches the
  **vcluster** API with its vcluster SA and builds `podIP→sessionId` from inner
  pods carrying `yaac.session-id`. Redirected traffic arrives with PP2 srcIp =
  the pod's host IP, and the vcluster pod's `status.podIP` is that host IP, so
  the existing pod-watch resolves it with **no proxy code change**.
- **Chained / pre-opt-in traffic → outer proxy.** A vcluster's egress that
  reaches the **outer** proxy (the inner proxy's own upstream dials, plus synced
  pods before an inner yaac opts in) arrives with the source pod's host IP, but
  those pods live in the vcluster namespace with no outer `yaac.session-id` —
  the outer proxy would otherwise fail-close. The daemon supplies a
  `hostIP→outerSessionId` map: `buildVclusterAttribution` /
  `reconcileVclusterAttribution` in
  `src/lib/session/vcluster-attribution-reconcile.ts` (another background-loop
  tick step) push it to the outer proxy via `PUT /vcluster-attribution`
  (`proxyClient.registerVclusterAttribution`; parsed by
  `parseVclusterAttribution` in `k8s/proxy/pod-watch.ts`, applied in
  `k8s/proxy/proxy.ts`). Full-replace each push, so torn-down pod IPs are evicted.

## Trust model (the security crux)

- The inner yaac/session pod holds **no host credential**
  (`automountServiceAccountToken: false`, vcluster-only kubeconfig). It can only
  write to its vcluster.
- The **daemon** is the only writer of host CEC/CNP and it **rebuilds** from
  trusted builders — it never copies tenant-authored policy, so no allow-all
  escape can reach the host. The inner yaac's in-vcluster CEC/CNP are *opt-in
  signals*, not the applied content.
- **Scope** is pinned to `managed-by=<vc>` by the daemon, so a vcluster's
  override can only affect **its own** synced pods — never another session's,
  never infra.
- **Routing override vs. containment.** The override CNPs are a *routing*
  preference, not the containment boundary. The unforgeable
  `buildVclusterFallbackRedirectCnpManifest` floor already default-denies every
  synced pod's raw world and supplies intracluster + DNS. The override's
  `yaac.role != inner-proxy` exclusion and the `yaac.data-dir-hash` install
  key are tenant-forgeable, but forging either is non-escalating: a pod that
  forges `inner-proxy` or drops its install label lands on the fallback →
  **outer** proxy (still allowlisted); one that forges a sibling install's
  hash lands on that install's proxy, which fail-closes unknown source IPs.
  Raw world is never reachable.
- **Loop-free + fail-closed.** The inner proxy is excluded from its own override
  and still caught by the fallback redirect → outer proxy. Anything the override
  doesn't cover stays under the fallback. Both layers are default-deny.

## CRD registration in the vcluster

For the inner yaac's `kubectl apply CiliumEnvoyConfig/CiliumNetworkPolicy` to
succeed (not "no matches for kind"), the vcluster needs the Cilium CRD schemas —
**definitions only, no operator/agent** (the host Cilium is the only datapath).
`ensureCiliumCrds` in `src/lib/k8s/cilium-crds.ts` installs **permissive**
(`x-kubernetes-preserve-unknown-fields`) CEC/CNP CRDs and waits for them to be
Established. In a vcluster these objects are inert — the daemon projects the
real, host-enforced redirect. Permissive (not Cilium's full ~400KB schema) is
safe because the objects are produced by yaac's own builders and need no API
schema validation. Called from bootstrap when running nested.

## Inner yaac wiring

- **Inner-proxy role label.** `buildProxyDeploymentManifest(imageRef, { nested })`
  stamps the proxy pod with `yaac.role=inner-proxy` (`LABEL_ROLE` /
  `ROLE_INNER_PROXY`) only when nested, so the overrides can exclude it.
  Triggered via `proxyClient` with `{ nested: process.env.YAAC_NESTED === '1' }`.
- **Install identity label.** Every daemon stamps `yaac.data-dir-hash` on its
  proxy Deployment pods and Service (`buildProxyDeploymentManifest` /
  `buildProxyServiceManifest`) — nested or not, matching the label session
  pods always carried. Nested, it is the key the projection groups by.
- **Recursion cap.** The hard recursion error is narrowed to **vcluster-in-
  vcluster only** — `src/daemon/session-create.ts:705-710` rejects
  `virtualCluster && YAAC_NESTED==='1'`. The ordinary (non-vcluster) inner-
  session path is allowed, so an inner yaac creates inner sessions normally.
- **Nested env.** `YAAC_NESTED=1` is set on the session env
  (`session-create.ts`); nested cluster-check skips host-only gates
  (`cluster-check.ts`); the nested registry resolves to the outer registry
  (`registry.ts`); the inner proxy host points at the vcluster
  (`session-create.ts`).
- **Proxy image — no change.** The inner proxy is the stock yaac proxy image; it
  just watches a different API (the vcluster) and resolves by `status.podIP`.

## Tests

- **Unit:** `test/unit/inner-redirect-reconcile.test.ts` (recognize / rebuild /
  prune), `test/unit/vcluster-attribution-reconcile.test.ts`,
  `test/unit/cilium-crds.test.ts`, plus the inner builders covered in the
  bootstrap unit tests (selector has `role != inner-proxy`; priority is
  `SESSION_REDIRECT_PRIORITY`; EDS targets the inner proxy Service).
- **e2e — the override (mandatory, pins the undocumented `priority`):**
  `test/e2e/inner-redirect-priority.test.ts` — a pod selected by both the
  fallback and a normal-priority inner override reaches the **inner** upstream;
  removing the override reverts to the **outer**. Re-run on every Cilium upgrade.
- **e2e — transparent egress:** `test/e2e/transparent-egress.test.ts` covers the
  SNI MITM / HTTP / SSH-tunnel / DNS-stub paths (host-side-redirect cases gated
  `skipIf(IS_NESTED_YAAC)`).
- **Nested capability:** the full unit + e2e suites are made to pass inside a
  nested yaac session (commit `9987b1d`); nesting-incapable cases are gated on
  `IS_NESTED_YAAC`. The session-create e2e family (own daemon+proxy+mocks)
  runs nested ungated and ASSUMES a per-install-projecting outer daemon —
  under an older first-match outer daemon its sessions land on an arbitrary
  proxy and the tests fail on egress timeouts (upgrade the host yaac).

## Known must-verify / fragilities

1. **`status.podIP == hostIP`** is the attribution linchpin for inner-session
   resolution; the daemon-supplied `hostIP→sid` map
   (`vcluster-attribution-reconcile.ts`) is the productized fallback for the
   chained/outer path.
2. **`listener.priority` is undocumented** — guarded by the mandatory override
   e2e (see above).
3. **Inner proxy reachability across the sync boundary** — the projected host
   CEC EDS-resolves the host-synced inner proxy Service; its endpoints must
   populate (the f1fbd33 EDS lesson: node-Envoy can't route a ClusterIP, it must
   hit pod endpoints).
5. **Synced Service labels** — the per-install discovery reads the tenant
   `yaac.data-dir-hash` label off the host-synced proxy Service. Tenant POD
   labels provably sync verbatim (the shipped `yaac.role` exclusion depends on
   it); the Service-label counterpart is asserted only by the nested e2e run
   under a per-install outer daemon. If the syncer ever translates Service
   labels, `findInnerProxyServices` logs the unlabeled Service and projects
   nothing — fail-safe (fallback containment), not fail-open.
4. **Containment** — the projection loop is the trust boundary: the daemon must
   rebuild (never copy) and pin scope. It deserves the same scrutiny as any host
   admission guard.
