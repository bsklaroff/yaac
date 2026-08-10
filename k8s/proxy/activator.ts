/**
 * Wake activator for asleep vclusters (docs/vcluster-scale-to-zero.md).
 *
 * One install-wide pod fronts the API Service of every ASLEEP vcluster:
 * while a vcluster's control plane is scaled to 0, a yaac-managed
 * EndpointSlice points the vcluster's API ClusterIP here. On the first
 * client connection the activator scales the control plane back to 1,
 * parks the request until the apiserver answers, deletes the
 * EndpointSlice, and responds **307 to the same URL** — the client
 * re-dials (a fresh connection, now routed to the real endpoint) and
 * re-presents its own credentials there. Identity survives because the
 * client re-authenticates itself, not because the activator forwards
 * anything: it never verifies, mints, or replays CLIENT identity, and
 * it never proxies a byte of API traffic.
 *
 * It still TERMINATES TLS rather than holding the TCP handshake: a cold
 * start takes ~12-20s, past Go's fixed 10s TLS-handshake timeout in
 * client-go — completing the handshake immediately and holding the
 * *HTTP request* keeps clients on their much longer per-request
 * deadlines. Termination is per-vcluster by SNI: the kubeconfig's
 * server name identifies the vcluster, and the serving leaf is minted
 * from that vcluster's own server CA (read from its `<name>-certs`
 * Secret only while a wake is in flight), which clients pin.
 *
 * `Connection: close` on the 307 is load-bearing: without it Go reuses
 * the same keep-alive connection (same host) for the retry and lands
 * back on the activator in a redirect loop.
 */

import https from 'node:https'
import {
  ApiException,
  AppsV1Api,
  CoreV1Api,
  DiscoveryV1Api,
  KubeConfig,
  PatchStrategy,
  setHeaderOptions,
} from '@kubernetes/client-node'
import tls from 'node:tls'
import forge from 'node-forge'
import type http from 'node:http'
import type { Duplex } from 'node:stream'


/** Must match vclusterSleepSliceName in packages/server/src/runtime/k8s/cluster/activator.ts. */
export function sleepSliceName(vcName: string): string {
  return `yaac-sleep-${vcName}`
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

export interface VclusterRef {
  /** vcluster (release) name, `yvc-<sid8>`. */
  name: string
  /** Its dedicated host namespace, `<install-ns>-vc-<sid8>`. */
  namespace: string
}

/**
 * Strict SNI → vcluster binding. The kubeconfig's server is
 * `<name>.<vc-ns>.svc.cluster.local`; both labels must agree on the same
 * worktree id AND belong to THIS install's namespace prefix, so a
 * connection for vcluster X can never wake (or be answered under the
 * serving identity of) another install's vclusters.
 */
export function parseVclusterSni(
  servername: string | undefined,
  installNamespace: string,
): VclusterRef | null {
  if (!servername) return null
  const m = /^yvc-([a-z0-9]{1,8})\.([a-z0-9-]+)\.svc\.cluster\.local$/.exec(servername)
  if (!m) return null
  const [, sid, namespace] = m
  if (namespace !== `${installNamespace}-vc-${sid}`) return null
  return { name: `yvc-${sid}`, namespace }
}

/**
 * Mint a short-lived serving leaf for the vcluster's API host, signed by
 * the vcluster's own server CA. The cert the real endpoint serves on
 * 8443 (the syncer's proxy cert, carrying the extraSANs FQDN) is
 * generated at boot inside the pod and never exported — the Secret's
 * `apiserver.crt` has only the in-vcluster SANs, which clients pinning
 * the API-host FQDN reject. The CA key IS in the Secret, so the
 * activator does exactly what the syncer does at boot: mint a leaf for
 * the name it must serve. Clients pin that CA in their kubeconfig, so
 * the minted chain validates.
 */
export function mintServingCert(
  caCertPem: string,
  caKeyPem: string,
  servername: string,
): { certPem: string; keyPem: string } {
  const caCert = forge.pki.certificateFromPem(caCertPem)
  const caKey = forge.pki.privateKeyFromPem(caKeyPem)
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '00' + forge.util.bytesToHex(forge.random.getBytesSync(16))
  cert.validity.notBefore = new Date(Date.now() - 5 * 60 * 1000)
  cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000)
  cert.setSubject([{ name: 'commonName', value: servername }])
  cert.setIssuer(caCert.subject.attributes)
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: servername }] },
  ])
  cert.sign(caKey, forge.md.sha256.create())
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  }
}

// ── Host-API access ─────────────────────────────────────────────────────────

/** The typed clients the wake path drives. */
export interface ActivatorApis {
  core: CoreV1Api
  apps: AppsV1Api
  discovery: DiscoveryV1Api
}

/**
 * Build the clients from a kubeconfig.
 *
 * Credentials are resolved per REQUEST by the library, not snapshotted at
 * startup: the in-cluster config registers a `tokenFile` auth provider that
 * re-reads the projected ServiceAccount token kubelet rotates. An activator
 * holding a start-up copy would 401 after the first rotation and never
 * recover — silently, since it only calls the apiserver when a sleeping
 * vcluster is dialed, so the symptom surfaces as "waking hangs" long after
 * the credential actually died.
 */
export function activatorApis(kubeConfig: KubeConfig): ActivatorApis {
  return {
    core: kubeConfig.makeApiClient(CoreV1Api),
    apps: kubeConfig.makeApiClient(AppsV1Api),
    discovery: kubeConfig.makeApiClient(DiscoveryV1Api),
  }
}

function inClusterApis(): ActivatorApis {
  const kubeConfig = new KubeConfig()
  kubeConfig.loadFromCluster()
  return activatorApis(kubeConfig)
}

/** HTTP status behind a client-node failure, or null if it is not one. */
export function apiStatusCode(err: unknown): number | null {
  return err instanceof ApiException ? err.code : null
}

/** Status code when the error is an API error, else the raw message. */
function describeApiError(err: unknown): string {
  const code = apiStatusCode(err)
  return code === null ? String(err) : String(code)
}

// ── Per-vcluster credential + wake state ────────────────────────────────────

/** The material we derive from the vcluster's `<name>-certs` Secret. */
interface VcCerts {
  /** Serving leaf + key for the vcluster's API host, MINTED here. */
  servingCert: Buffer
  servingKey: Buffer
  /** The server CA (readiness-probe verification of the real endpoint). */
  serverCa: Buffer
}

function certsFromSecretData(
  data: Record<string, string>,
  vc: VclusterRef,
  servername: string,
): VcCerts {
  const need = (key: string): Buffer => {
    const b64 = data[key]
    if (!b64) throw new Error(`secret ${vc.name}-certs is missing key ${key}`)
    return Buffer.from(b64, 'base64')
  }
  // vcluster's embedded-k8s PKI names the cluster CA `ca.crt` and also
  // exports it as a dedicated `server-ca` pair — prefer the split names
  // when present.
  const caCert = data['server-ca.crt'] ? need('server-ca.crt') : need('ca.crt')
  const caKey = data['server-ca.key'] ? need('server-ca.key') : need('ca.key')
  const minted = mintServingCert(caCert.toString(), caKey.toString(), servername)
  return {
    servingCert: Buffer.from(minted.certPem),
    servingKey: Buffer.from(minted.keyPem),
    serverCa: caCert,
  }
}

export interface ActivatorOptions {
  port: number
  /** This install's namespace — the SNI binding's required prefix. */
  installNamespace: string
  /** Control-plane pod port; defaults to `port` (both 8443 in production).
   *  Injectable so tests can run listener and backend on one host. */
  backendPort?: number
  /** Injectable so tests can point the clients at a fake apiserver. */
  kubeConfig?: KubeConfig
  log?: (msg: string) => void
}

/** How long a full cold start may take before parked requests fail. */
const WAKE_TIMEOUT_MS = 120_000
const WAKE_POLL_MS = 500
/** Post-slice-delete pause for datapath endpoint propagation. */
const DATAPATH_SETTLE_MS = 500

export function startActivator(opts: ActivatorOptions): https.Server {
  const apis = opts.kubeConfig ? activatorApis(opts.kubeConfig) : inClusterApis()
  const log = opts.log ?? ((m: string) => console.log(`[activator] ${m}`))
  const backendPort = opts.backendPort ?? opts.port

  // Certs are cached only briefly: the activator holds a vcluster's
  // serving material during an in-flight wake (SNI handshake → parked
  // requests), not as standing state for awake vclusters.
  const certsCache = new Map<string, { certs: VcCerts; expires: number }>()
  const CERTS_TTL_MS = 60_000

  async function loadCerts(vc: VclusterRef): Promise<VcCerts> {
    const hit = certsCache.get(vc.namespace)
    if (hit && hit.expires > Date.now()) return hit.certs
    const secret = await apis.core
      .readNamespacedSecret({ namespace: vc.namespace, name: `${vc.name}-certs` })
      .catch((err: unknown) => {
        throw new Error(`get ${vc.name}-certs → ${describeApiError(err)}`)
      })
    const apiHost = `${vc.name}.${vc.namespace}.svc.cluster.local`
    const certs = certsFromSecretData(secret.data ?? {}, vc, apiHost)
    certsCache.set(vc.namespace, { certs, expires: Date.now() + CERTS_TTL_MS })
    return certs
  }

  /**
   * The control-plane pod's IP, excluding synced pods: `managed-by` is
   * the one label the syncer stamps on every synced pod and a tenant
   * cannot suppress, so requiring its ABSENCE (plus the chart's app/
   * release labels) can never select a tenant pod masquerading as the
   * control plane.
   */
  async function controlPlanePodIp(vc: VclusterRef): Promise<string | null> {
    const list = await apis.core.listNamespacedPod({
      namespace: vc.namespace,
      labelSelector: `app=vcluster,release=${vc.name},!vcluster.loft.sh/managed-by`,
    })
    for (const pod of list.items) {
      if (pod.metadata?.deletionTimestamp) continue
      if (pod.status?.phase === 'Running' && pod.status.podIP) return pod.status.podIP
    }
    return null
  }

  /** TLS probe: the apiserver boot is done when :8443 completes a handshake. */
  function probeTls(podIp: string, certs: VcCerts, servername: string): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = tls.connect(
        { host: podIp, port: backendPort, servername, ca: certs.serverCa, timeout: 3000 },
        () => { sock.destroy(); resolve(true) },
      )
      sock.on('error', () => resolve(false))
      sock.on('timeout', () => { sock.destroy(); resolve(false) })
    })
  }

  /**
   * True once the endpoint controller's own slice for the vcluster's
   * Service lists a READY endpoint. This — not the pod accepting TLS —
   * is what makes the Service route a NEW connection to the real
   * backend, and the 307's re-dial is exactly such a connection: answer
   * before this and the client races into a backend-less Service
   * (observed live as `connection refused`).
   */
  async function serviceRoutesToBackend(vc: VclusterRef): Promise<boolean> {
    const list = await apis.discovery.listNamespacedEndpointSlice({
      namespace: vc.namespace,
      labelSelector: `kubernetes.io/service-name=${vc.name}`,
    })
    for (const slice of list.items) {
      const managedBy = slice.metadata?.labels?.['endpointslice.kubernetes.io/managed-by']
      if (managedBy !== 'endpointslice-controller.k8s.io') continue
      if ((slice.endpoints ?? []).some((e) => e.conditions?.ready === true)) return true
    }
    return false
  }

  async function performWake(vc: VclusterRef, servername: string): Promise<void> {
    const certs = await loadCerts(vc)
    const scale = await apis.apps
      .readNamespacedDeploymentScale({ name: vc.name, namespace: vc.namespace })
      .catch((err: unknown) => {
        throw new Error(`get scale ${vc.name} → ${describeApiError(err)}`)
      })
    if ((scale.spec?.replicas ?? 0) === 0) {
      log(`waking ${vc.name} (scale 0 → 1)`)
      await apis.apps.patchNamespacedDeploymentScale(
        { name: vc.name, namespace: vc.namespace, body: { spec: { replicas: 1 } } },
        setHeaderOptions('Content-Type', PatchStrategy.MergePatch),
      ).catch((err: unknown) => {
        throw new Error(`scale ${vc.name} to 1 → ${describeApiError(err)}`)
      })
    }

    const deadline = Date.now() + WAKE_TIMEOUT_MS
    for (;;) {
      const podIp = await controlPlanePodIp(vc).catch(() => null)
      if (podIp
        && await probeTls(podIp, certs, servername)
        && await serviceRoutesToBackend(vc).catch(() => false)) {
        // The interception slice must be gone BEFORE any parked request
        // is answered: the 307's re-dial must route to the real
        // endpoint, not back here.
        await apis.discovery.deleteNamespacedEndpointSlice({
          name: sleepSliceName(vc.name), namespace: vc.namespace,
        }).catch((err: unknown) => {
          // 404 is the benign race: another wake already removed it.
          if (apiStatusCode(err) === 404) return
          log(`warning: delete ${sleepSliceName(vc.name)} → ${describeApiError(err)} (reconcile will retry)`)
        })
        // Brief settle so the datapath drops our just-deleted endpoint
        // before the re-dial: endpoint programming is fast but not
        // synchronous with the API write.
        await new Promise((r) => setTimeout(r, DATAPATH_SETTLE_MS))
        log(`${vc.name} is awake (control plane at ${podIp})`)
        return
      }
      if (Date.now() > deadline) throw new Error(`vcluster ${vc.name} did not wake within ${WAKE_TIMEOUT_MS}ms`)
      await new Promise((r) => setTimeout(r, WAKE_POLL_MS))
    }
  }

  // One wake per vcluster at a time; concurrent first-touch parks on the
  // same promise and all requests release together on readiness.
  const wakes = new Map<string, Promise<void>>()
  function ensureAwake(vc: VclusterRef, servername: string): Promise<void> {
    let inflight = wakes.get(vc.namespace)
    if (!inflight) {
      inflight = performWake(vc, servername)
      inflight.catch(() => wakes.delete(vc.namespace))
      wakes.set(vc.namespace, inflight)
      // The completed result is kept briefly so a burst of first-touch
      // requests shares one wake, then dropped so a later stale-slice
      // hit re-verifies instead of trusting old state.
      void inflight.then(() => setTimeout(() => wakes.delete(vc.namespace), 30_000))
    }
    return inflight
  }

  const server = https.createServer({
    // No default cert: a connection without a valid vcluster SNI fails
    // its handshake — the activator serves nothing under its own name.
    // No client-cert request either: the activator authenticates no one
    // (the re-dialed request authenticates at the real apiserver), and
    // an unauthenticated caller can at most trigger a wake — which the
    // SNI handshake alone already does.
    SNICallback: (servername, cb) => {
      const vc = parseVclusterSni(servername, opts.installNamespace)
      if (!vc) {
        cb(new Error(`unknown SNI ${servername}`))
        return
      }
      loadCerts(vc).then((certs) => {
        cb(null, tls.createSecureContext({ cert: certs.servingCert, key: certs.servingKey }))
        // Start the wake at handshake time — shaves the first request's
        // wait by the client's own connect/handshake round trips.
        ensureAwake(vc, servername).catch((err) => log(`wake ${vc.name}: ${(err as Error).message}`))
      }).catch((err) => cb(err as Error))
    },
    // No h2: client-go/kubectl fall back to HTTP/1.1 when h2 is not
    // negotiated, which keeps the redirect semantics simple.
    ALPNProtocols: ['http/1.1'],
  })

  /** Status-shaped error the k8s clients can render. */
  function respondError(res: http.ServerResponse, code: number, message: string): void {
    res.writeHead(code, { 'Content-Type': 'application/json', Connection: 'close' })
    res.end(JSON.stringify({ kind: 'Status', apiVersion: 'v1', status: 'Failure', message, code }))
  }

  /**
   * Park until the vcluster serves, then hand back where to redirect:
   * the exact URL the client dialed (Host header preserves the port it
   * used; the SNI name is the fallback). Same host → Go re-sends the
   * client's own Authorization header and client cert on the new
   * connection, which by now routes to the real endpoint.
   */
  async function parkAndLocate(req: http.IncomingMessage): Promise<
    { location: string } | { reject: number; message: string }
  > {
    const socket = req.socket as tls.TLSSocket
    const servername = socket.servername
    const vc = parseVclusterSni(servername || undefined, opts.installNamespace)
    if (!vc || !servername) return { reject: 421, message: 'no vcluster for SNI' }
    try {
      await ensureAwake(vc, servername)
    } catch (err) {
      return { reject: 502, message: `vcluster wake failed: ${(err as Error).message}` }
    }
    const host = req.headers.host ?? `${servername}:${opts.port}`
    return { location: `https://${host}${req.url ?? '/'}` }
  }

  server.on('request', (req, res) => {
    void parkAndLocate(req).then((r) => {
      if ('reject' in r) {
        respondError(res, r.reject, r.message)
        return
      }
      // Connection: close is load-bearing — see the module doc.
      res.writeHead(307, { Location: r.location, Connection: 'close' })
      res.end()
    })
  })

  // Upgrade-based flows (SPDY exec/attach, websockets) get the same 307
  // over the raw socket. client-go's upgrade round-trippers are
  // conservative about redirects, so an upgrade as the very first touch
  // of an asleep vcluster may surface an error and succeed on retry —
  // by then the vcluster is awake and routed directly.
  server.on('upgrade', (req, socket: Duplex) => {
    void parkAndLocate(req).then((r) => {
      if ('reject' in r) {
        socket.end(`HTTP/1.1 ${r.reject} Rejected\r\nConnection: close\r\n\r\n`)
        return
      }
      socket.end(`HTTP/1.1 307 Temporary Redirect\r\nLocation: ${r.location}\r\nConnection: close\r\n\r\n`)
    })
  })

  // Parked requests must survive a full cold start: disable the default
  // request timeout that would cut them off mid-wake.
  server.requestTimeout = 0
  server.headersTimeout = 60_000

  server.listen(opts.port, () => log(`listening on :${opts.port} for install ${opts.installNamespace}`))
  return server
}
