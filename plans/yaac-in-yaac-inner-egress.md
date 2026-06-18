# yaac-in-yaac inner egress — transparent inner redirect via daemon projection

## Goal

Let a `virtualCluster` session run an **inner yaac** (`YAAC_NESTED=1`) against its
vcluster that creates inner sessions with their **own** proxy + allowlist, where
the inner sessions' egress is **transparently** redirected to the inner proxy at
**higher priority** than the outer redirect — and chains through the outer proxy
for anything the inner allowlist doesn't specially handle (allowlists compose by
intersection). "Transparent" = the inner yaac runs the **same** code path as a
top-level yaac (one API target — its vcluster), with no nesting-aware branching
in its egress setup and **no host-cluster credentials in the session pod**.

This composes with the landed Cilium egress model (commit f1fbd33): a
cluster-level CEC + CNP redirect selecting a label, EDS upstream, source-IP
identity via a pods-watch, forgery lock on the session-egress default-deny.

## Decision: design B (daemon projection), not A (host token in the pod)

We considered two ways to get an inner redirect onto the host datapath:

- **A — host token in the pod.** Give the session a narrow host SA token + a
  redirect-only ValidatingAdmissionPolicy; the inner yaac writes host CEC/CNP
  directly. **Rejected:** it can't be transparent — the inner yaac's primary API
  is its vcluster (where it creates inner pods), so CEC/CNP would have to be
  routed to a *different* API than everything else (split-brain by resource
  type). It also puts a host credential in the same pod as the agent and makes
  the whole containment guarantee depend on a CEL policy being airtight against
  arbitrary authored Cilium policy.
- **B — daemon projection (chosen).** The inner yaac targets **only** its
  vcluster for everything, including its CEC/CNP (transparent, single API). The
  **outer daemon** (sole host cluster-admin) watches the vcluster, recognizes
  yaac's own egress-redirect shapes, and **rebuilds** the equivalent host
  CEC/CNP from its trusted builders — re-scoped to the vcluster's managed-by
  selector, retargeted at the host-synced inner proxy, and priority-clamped into
  the level's reserved band. The session keeps **zero** host authority; the
  daemon never copies untrusted policy, so a tenant cannot author an escape.

## Spike results (2026-06-16, Cilium 1.19.4, current EDS-CEC model)

**PROVEN — priority override on the current model.** A client pod selected by an
outer redirect CNP (no priority) reached the OUTER upstream; adding an inner
redirect CNP with `toPorts.listener.priority: 50` flipped it to the INNER
upstream (3/3), and deleting the inner CNP reverted to OUTER — dynamically, no
pod restart. Confirms: **lower priority number wins**, an *unspecified* outer
priority loses to any explicit lower value (matches the empirical
"unspecified→126"), and add/remove is hot. (Re-verifies the 2026-06-15 spike
[[cilium-l7-redirect-custom-upstream]] survives the EDS + identity-preserved
migration.) The override is a CNP-level concern (`toPorts.listener.priority`),
independent of the CEC cluster type (STATIC or EDS).

**CONFIRMED from the vendored chart** (`k8s/vcluster/values.yaml`):
- OSS vcluster **cannot** stamp custom labels on synced pods (expression patches
  are PRO; the OSS syncer hard-errors). Synced pods carry **only**
  `vcluster.loft.sh/managed-by`. → the inner session-id label lives in the
  *vcluster*, so attribution must use the inner proxy's **vcluster** pod-watch.
- `sync.toHost.networkPolicies.enabled: false` — because a tenant NetworkPolicy
  can union over containment and grant raw internet egress. → reinforces
  "daemon rebuilds, never syncs/copies" as the only safe projection.

**MUST-VERIFY (linchpin, not spiked — no helm/vcluster CLI on the box):** a
vcluster pod's `status.podIP` equals the **host** synced pod's IP. This is core
vcluster behavior (the syncer copies physical pod status — phase, podIP,
conditions — back to the virtual pod; otherwise `kubectl get pod` in the
vcluster would never show Running/an IP), so the prior is strong — but it is the
load-bearing fact for attribution and must be verified before relying on it. If
it ever doesn't hold, fall back to a daemon-supplied `hostIP→innerSid` map fed
to the inner proxy.

## Topology & data path

```
HOST cluster (Cilium)         ns: yaac
  outer proxy + outer CEC/CNP redirect   (selects yaac.session-id Exists)
  outer daemon = host cluster-admin

  outer session pod  (virtualCluster; label yaac.session-id=<outerSid>)
    └ runs INNER yaac daemon  (YAAC_NESTED=1, KUBECONFIG=vcluster)
        creates inner sessions as pods IN the vcluster  yvc-<sid>
        runs ensureProxyResources against the vcluster  → inner proxy + CEC/CNP

  vcluster yvc-<sid> syncs to host:
    - inner session pods   → host pods, label managed-by=<vc>      (the workload)
    - inner proxy Deploy/Svc/SA → host pod + Service               (the inner proxy)
    - inner CEC/CNP        → NOT synced (CRDs); daemon PROJECTS them

  Host redirect stack for the vcluster's pods (managed-by=<vc>):
    (default)  managed-by Exists      → OUTER proxy    [daemon, at vcluster setup]
    (override) managed-by=<vc>, not role=inner-proxy
                                       → INNER proxy    [daemon-PROJECTED, lower prio]
    inner-proxy pod's own egress: excluded from the override → caught by the
       default managed-by redirect → OUTER proxy → internet   (chaining/fallback)
```

Data path for an inner-session pod's `curl https://api.example`:
1. Cilium redirects 443 via the **override** CNP (lower priority wins over the
   default) → node Envoy → **inner proxy** (host-synced).
2. Inner proxy reads PP2 srcIp = the pod's host IP, resolves it via its
   **vcluster** pod-watch (`status.podIP == hostIP`) → inner session-id → inner
   allowlist → MITM/judge.
3. Inner proxy dials the real upstream. Its egress (label `role=inner-proxy`,
   excluded from the override) is caught by the **default** managed-by redirect
   → **outer proxy** → judged against the **outer** allowlist → internet.
4. Net: inner allowlist ∩ outer allowlist, fail-closed at both layers, no proxy
   code change. The inner proxy trusts the outer CA (`NODE_EXTRA_CA_CERTS`).

## Control path: the projection loop

A new daemon background step (`src/lib/session/inner-redirect-reconcile.ts`),
one tick per managed vcluster:

1. **Read** the vcluster (via the vcluster kubeconfig the daemon already holds)
   for yaac's egress-redirect CEC + session-egress CNP (known names from
   `bootstrap.ts`). Their presence is the inner yaac's opt-in — no separate
   control channel.
2. **Recognize, don't parse-arbitrary.** Both ends are yaac, so the daemon keys
   off the known object names/shape; it does not interpret tenant-authored
   selectors/ports.
3. **Rebuild** host objects from trusted builders:
   - **Host inner CEC** (`buildInnerEgressRedirectCecManifest(vc, innerProxySvc,
     level)`): same three listeners/EDS clusters as the outer CEC, but
     `backendServices` → the **host-synced inner proxy Service**
     (`<ns>/<inner-proxy-svc>`), same `use-original-source-address: false`.
   - **Host inner CNP** (`buildInnerSessionEgressRedirectCnpManifest(vc, level)`):
     `endpointSelector` = `managed-by=<vc>` **AND** `role != inner-proxy`
     (loop-free), egress 443/80→world + tunnel via the inner CEC listeners, with
     `toPorts.listener.priority` = the reserved band for `level`.
   - **Host inner proxy-ingress CNP**: same shape as the outer proxy-ingress —
     transparent ports open to the redirected identity, control port host-only.
4. **Apply/prune** with a `yaac.inner-redirect=<vc>` scope label; delete on
   vcluster teardown / orphan GC (daemon-start sweep, same pattern as the
   project-registry/vcluster reconcilers).

The inner proxy itself is **not** projected — it's an ordinary vcluster
workload that syncs to the host on its own (Deployment+Service). Only the
*datapath redirect* (CEC/CNP) needs host projection.

## Trust model (the security crux)

- The inner yaac/session pod holds **no host credential** (unchanged:
  `automountServiceAccountToken: false`, vcluster-only kubeconfig). It can only
  write to its vcluster.
- The **daemon** is the only writer of host CEC/CNP and it **rebuilds** from
  trusted builders — it never copies tenant-authored policy, so no allow-all
  escape can reach the host (the exact risk that keeps `networkPolicies` sync
  off). The inner yaac's CEC/CNP are *opt-in signals*, not the applied content.
- **Scope** is pinned to `managed-by=<vc>` by the daemon, so a vcluster's
  override can only affect **its own** synced pods — never another session's,
  never infra.
- **Priority (refined — single normal value, low-precedence fallback).** EVERY
  yaac's session-egress redirect uses the SAME normal priority
  (`SESSION_REDIRECT_PRIORITY=50`), so the inner is fully transparent — no
  daemon-assigned per-level band. The OUTER yaac adds a low-precedence FALLBACK
  redirect for a vcluster's synced pods (`managed-by` → outer proxy,
  `VCLUSTER_FALLBACK_PRIORITY=90`), so they have egress the moment they exist;
  the inner's normal-priority override (projected by the daemon, re-scoped to
  `managed-by`) beats the fallback (50 < 90) and wins, while the inner-proxy pod
  (excluded from the override, matched only by the fallback) chains → outer
  proxy. Lower number wins. (CNP `listener.envoyConfig` carries no namespace.
  SUPERSEDED — see plans/distributed-mapping-pine.md: the fallback's listeners
  now live in a single shared cluster-scoped CCEC the per-vcluster CNP references
  by kind, instead of a per-vcluster CEC, to stop session churn from regenerating
  every endpoint. The inner override CEC stays per-vcluster — its upstream is each
  vcluster's own inner proxy.) vcluster-in-vcluster is rejected, so one level — no
  band arithmetic needed.
- **Loop-free + fail-closed.** The inner proxy is excluded from its own override
  and still caught by the default managed-by redirect → outer proxy. Anything
  the override doesn't cover stays under the default redirect. Both layers are
  default-deny.

## Inner proxy — no code change

The inner proxy is the **stock** yaac proxy image, deployed by the inner yaac's
unmodified `ensureProxyResources` against the vcluster:
- It watches `kubernetes.default.svc` (the **vcluster** API) with its vcluster SA
  → builds `podIP→sessionId` from inner pods carrying `yaac.session-id`.
- Redirected traffic arrives with PP2 srcIp = the pod's **host** IP; because the
  vcluster pod's `status.podIP` is the host IP (MUST-VERIFY), the existing
  pod-watch resolves it directly. **No proxy code changes** — it just watches a
  different API.
- The inner yaac registers inner sessions with the inner proxy exactly as a
  top-level yaac does (allowlists). The inner proxy's host-synced Service is what
  the projected inner CEC's EDS targets.

## CRD registration in the vcluster (transparency prerequisite)

For the inner yaac's `kubectl apply CiliumEnvoyConfig/CiliumNetworkPolicy` to
succeed (not "no matches for kind"), the vcluster needs the Cilium **CRD
schemas** registered — definitions only, **no operator/agent** (the host Cilium
is the only datapath). Add the two CRD YAMLs to the vendored vcluster manifests
(or apply them in `ensureSessionVcluster` right after the vcluster is up). They
make the objects persist + be readable by the daemon's projection loop; nothing
in the vcluster acts on them.

## Implementation

### bootstrap.ts (host builders — generalize the existing ones)
- `buildInnerEgressRedirectCecManifest(vc, innerProxyService, level)` — the EDS
  CEC retargeted at the host-synced inner proxy Service.
- `buildInnerSessionEgressRedirectCnpManifest(vc, level)` — `managed-by=<vc>` AND
  `role != inner-proxy`, listeners + `priority` from the level band.
- `buildInnerProxyIngressCnpManifest(vc)` — proxy-ingress for the inner proxy.
- `priorityBandForLevel(level)` helper; the outer default stays unspecified.
- Reuse `proxyEdsClusterName`, the EDS pattern, and the `use-original-source-address`
  annotation verbatim.

### vcluster.ts / session-create.ts
- Register the Cilium CEC/CNP CRDs into each vcluster at creation.
- Stamp the inner proxy pod with `yaac.role=inner-proxy` (so the override can
  exclude it) — set by the inner yaac's proxy Deployment when `YAAC_NESTED=1`.
- Drop the hard recursion error for the *non-vcluster* inner-session path; keep
  rejecting vcluster-in-vcluster (`virtualCluster` under `YAAC_NESTED=1`).

### NEW src/lib/session/inner-redirect-reconcile.ts
- The watch/rebuild/apply/prune loop above; a `background-loop` tick step;
  orphan GC by the `yaac.inner-redirect=<vc>` scope label.

### proxy (k8s/proxy) — no change
- Confirm the pod-watch works when `KUBERNETES_SERVICE_HOST` points at the
  vcluster API and resolves by `status.podIP` (which is the host IP).

## Tests

- **Unit:** the three inner builders (selector has `role != inner-proxy`;
  priority is in the level band; EDS targets the inner proxy Service);
  `priorityBandForLevel`; the reconcile loop's recognize/rebuild/prune; CRD
  registration manifest.
- **MANDATORY e2e — the override (pins undocumented `priority`):** a pod selected
  by both a default redirect and a higher-precedence inner redirect reaches the
  **inner** upstream; remove the override → reaches the **outer**; the
  inner-proxy-role pod is excluded from the override and its egress chains to the
  outer. (This is the spike, productized — re-run on every Cilium upgrade.)
- **e2e — attribution:** a synced pod's redirected egress is attributed to the
  correct **inner** session by source IP (depends on `status.podIP == hostIP`).
- **e2e — end-to-end nesting (env-gated):** inner `yaac cluster check` + inner
  session create + an inner session reaches an inner-allowlisted host (MITM via
  inner proxy, chained through the outer proxy) and a host outside the inner ∩
  outer allowlist fails closed.

## Risks / must-verify

1. **`status.podIP == hostIP`** (attribution linchpin) — strong prior, unverified
   here; verify first. Fallback: daemon-supplied `hostIP→innerSid` map.
2. **`listener.priority` is undocumented** — lower-wins is empirical (re-confirmed
   2026-06-16). The mandatory override e2e is the guard; treat a Cilium upgrade
   that breaks it as a release blocker.
3. **Inner proxy reachability / EDS across the sync boundary** — the projected
   host CEC must EDS-resolve the host-synced inner proxy Service; verify the
   synced Service's endpoints populate (same EDS lesson as f1fbd33: node-Envoy
   can't route a ClusterIP, must hit pod endpoints).
4. **Priority-band exhaustion at depth** — only one level is in scope;
   vcluster-in-vcluster stays rejected, bounding depth.
5. **Containment** — the daemon must rebuild (never copy) and pin scope+band;
   the projection loop is the trust boundary and needs the same scrutiny as the
   VAP guard.

## Milestones

- **N0 — confirm the linchpin.** Stand up one vcluster; verify `status.podIP ==
  hostIP`; verify the stock proxy pod-watch resolves against the vcluster API.
- **N1 — host inner builders + priority bands** (unit only).
- **N2 — projection loop** (watch vcluster CEC/CNP → rebuild host objects →
  apply/prune); CRD registration in the vcluster; inner-proxy role label.
- **N3 — wire inner yaac** (drop the non-vcluster recursion block; inner
  `ensureProxyResources` runs against the vcluster transparently).
- **N4 — the mandatory override e2e + attribution e2e + end-to-end nesting smoke.**
