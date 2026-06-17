# Session egress blip after VM resume (laptop sleep)

## Status

Investigation only — **no code changed** (decided 2026-06-17). The common case
self-heals in seconds; the severe case is rare. This doc records the root-cause
analysis, the reproduction recipe, and candidate fixes so it can become an
actionable plan if the rough edge is revisited.

## Symptom

After the laptop wakes from sleep (which suspends the krun VM), a running
session's egress fails for a window, then self-heals with no intervention.

- **Original incident** (~9.5h sleep): HTTPS egress failed instantly with
  `SSL_ERROR_SYSCALL` (curl rc35) while DNS still resolved; recovery took a
  while (at least ~1 min; partly a measurement artifact of intermittent
  probing). Everything was `Running` — nothing had crashed.
- **Reproduced mild case** (180s freeze): a ~4s egress blip, presenting as an
  *instant* DNS failure (curl rc6, ~90µs), then clean recovery.

## Reproduction recipe

Freezing the krunkit process faithfully models a suspend (halts the guest clock
+ all guest networking; on resume the `--timesync` wiring corrects the clock):

```sh
KRUN=$(pgrep -f 'krunkit-1.2.1' | head -1)
kill -STOP "$KRUN"      # freeze the VM (also freezes the live session pod)
sleep 180               # hold
kill -CONT "$KRUN"      # resume; always trap-CONT for safety
```

Then immediately poll egress from the session pod while running
`cilium-dbg monitor --type drop --type policy-verdict` in the cilium-agent pod.
macOS has no `timeout`; bound calls with `kubectl --request-timeout` and
`curl -m`, and distinguish "kubectl exec failed (infra recovering)" from a real
egress failure via the curl exit code.

## Root cause

The blip is **the guest datapath settling for a few seconds after the vCPUs
resume** — the proxy pod is briefly unreachable for both UDP/53 (DNS) and the
Envoy→proxy hop (HTTPS), then recovers. It is internal pod→pod traffic, so it is
not gvproxy / the external network.

### Ruled out (with direct evidence — don't re-chase)

| Suspect | Verdict | Evidence |
|---|---|---|
| Clock / krunkit `--timesync` | not the cause | `skew=0s` by the first post-resume poll; timesync corrects within ~1s |
| Cilium policy / datapath drops | not the cause | `cilium monitor` showed **zero** drops for the session pod in both the live incident and the repro; egress was `action redirect`, Envoy→proxy `action allow`. Only drops were an unrelated pod hitting host DNS `10.89.0.1:53` |
| Cilium endpoint regeneration | not the cause | none logged at resume |
| CT-GC-gated recovery (mild case) | not the cause | repro recovered at t+5s; CT GC didn't run until t+23s |
| Proxy application code | not the cause | DNS stub is a stateless dgram (`k8s/proxy/proxy.ts:2363`); an instant rc6 means the packet reached **no listening socket** ⇒ proxy pod unreachable, below the app. No proxy error/timeout logs |

### Two regimes

- **Mild (reproduced):** short freeze → ~4s self-heal, no stale state, recovers
  before any GC.
- **Severe (unconfirmed — could not reproduce without a multi-hour sleep):** a
  long real sleep may let stale conntrack accumulate while Cilium's *adaptive*
  CT-GC interval has grown large (observed it recalculating **38m → 57m** on an
  idle cluster: `deleteRatio` low ⇒ interval grows). Recovery would then wait
  for the overdue GC on wake. This is the only scenario where bounding
  `conntrack-gc-interval` would plausibly help.

## Clock-sensitive code found (did NOT fire, but worth hardening if revisited)

- **Leaf-cert `notBefore = new Date()` with no backdating** —
  `k8s/proxy/proxy.ts:255` (CA) and `:299` (leaf). Standard MITM hygiene is to
  backdate ~5 min for skew tolerance. Produces cert-validity errors (rc60), not
  the rc35/rc6 observed — so hygiene, not the cause.
- **10s handshake timers** (`PP2_TIMEOUT_MS` / `SNI_PEEK_TIMEOUT_MS` /
  `CONNECT_TIMEOUT_MS`, `setTimeout` at `proxy.ts:2151/2203/2303`) — *would*
  misfire on a real suspend's monotonic-clock jump, tearing down in-flight
  connections. But logs show **zero** `no PROXY header` / `no ClientHello` /
  `no CONNECT` lines across 14h, so they didn't fire.
- **OAuth token expiry via `Date.now()`** (`proxy.ts:1238`, `:1328`) — a long
  sleep can push a token past `expiresAt` and force a refresh; possible auth
  hiccup, not a connection reset.

## Candidate fixes (none applied)

Ordered roughly by leverage. The robust option is a resume-triggered recovery,
because the cause is a "settling" delay that no single in-code knob removes.

1. **Resume-triggered warmup/repair** *(robust; needs a wake detector)* — on
   wake, actively drive the egress path back to health before the session
   retries. Detector options: host-side launchd/sleepwatcher, or a guest-side
   clock-jump watcher (a long-running pod that notices a `Date.now()`
   discontinuity). Action: re-probe egress until healthy; optionally
   `cilium bpf ct flush` for the proxy / `cilium endpoint regenerate`, or bounce
   `deploy/yaac-proxy`.
2. **Bound the conntrack-GC interval** — pin `conntrack-gc-interval` (~60s) in
   `scripts/setup-kind-cluster.sh` (Cilium config) so post-resume stale entries
   reap fast and predictably. Targets the severe (long-sleep) regime only.
3. **Backdate the MITM leaf cert `notBefore`** (~5 min) at `proxy.ts:255/299` —
   cheap skew-tolerance hygiene.
4. **TCP keepalive on the Envoy egress cluster** —
   `src/lib/k8s/bootstrap.ts` `redirectListenerAndCluster()` currently sets only
   `connectTimeout: 5s`; add `upstreamConnectionOptions.tcpKeepalive`
   (`keepalive_time 30 / interval 5 / probes 3` ≈ 45s detection) and a tcp_proxy
   `idleTimeout`. Plus `setKeepAlive` on the proxy's upstream sockets and a
   keepalive/read-timeout on the pod-watch K8s watch (`k8s/proxy/pod-watch.ts`),
   so a silently-dead watch reconnects fast.

The standard remedy for "TCP state goes stale across a suspend" is TCP keepalive
plus bounded idle/GC timers (Envoy `upstream_connection_options.tcp_keepalive`;
OS keepalive). See Envoy timeouts FAQ, kgateway/Gloo TCP-keepalive docs, and
Cilium issues #32472 / #19367 on stale conntrack after state transitions.

## Notes

- The fix work was scoped earlier as "Layers 1–3" (bound CT-GC + Envoy keepalive
  + proxy/pod-watch keepalive). The reproduction then showed Layer 1 (CT-GC) is
  irrelevant to the *common* case (zero drops, recovery before GC), which is why
  the plan above demotes it to the severe-regime-only fix.
- Related: `plans/yaac-in-yaac-inner-egress.md` (egress redirect design),
  and the clock-drift fix (krunkit `--timesync`) which is a *separate* issue.
