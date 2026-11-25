/**
 * The token endpoint of a cluster install (docs/server-in-cluster.md
 * "The token endpoint"): the server pod's token listener, exposed at the
 * one `<addr>:<port>` that `--token-listen` names and nowhere else.
 *
 * The pod binds the token port on the pod network, where its ingress policy
 * opens that port alone to any source; the address the admin named is
 * enforced one hop out. On byo that hop is kube-proxy, through a Service
 * with `externalIPs`, which delivers only packets addressed to that address
 * and port on whichever node holds it. On kind the node is a container only
 * this machine reaches, so a forwarder container beside it publishes the
 * address with podman and passes connections to a NodePort.
 *
 * The Service is the record: it carries the listen address as an
 * annotation, so a later install without the flag keeps what is there.
 */
import { isIPv4 } from 'node:net'
import {
  SERVER_APP_NAME,
  SERVER_TOKEN_INGRESS_NP_NAME,
  SERVER_TOKEN_PORT,
  SERVER_TOKEN_SERVICE_NAME,
  SERVER_TOKEN_TLS_SECRET,
  applyObject,
  deleteObject,
  execFileAsync,
  installId,
  k8sNamespace,
  listObjects,
  readObject,
  type ObjectRef,
} from '#drivers/k8s/substrate'
import { ENVOY_UPSTREAM_IMAGE, buildServerTokenIngressNpManifest } from '#drivers/k8s/cluster'
import { env } from '@yaac/shared/env'
import {
  TOKEN_TLS_CERT_FILE,
  TOKEN_TLS_KEY_FILE,
  formatTokenListen,
  parseTokenListen,
  planTokenCertificate,
  tokenKeyFingerprint,
  tokenPairProblem,
  type TokenListen,
  type TokenTlsPair,
} from '@yaac/shared/token-tls'
import type { CheckResult } from '@yaac/shared/types'
import { ClusterInstallError } from './arg-guards'

/** Where the server pod mounts the Secret, as `YAAC_TOKEN_TLS_DIR`. */
export const POD_TOKEN_TLS_DIR = '/var/run/yaac/token-tls'
/** The annotation on the Service that records the admin's `<addr>:<port>`. */
const LISTEN_ANNOTATION = 'yaac.token-listen'
/** Ports a node uses itself, which kube-proxy's rule would take over
 *  (ssh, rpcbind, NFS, the API server, the kubelet). */
const NODE_PORTS = [22, 111, 2049, 6443, 10250]
const NODE_PORT_RANGE = [30000, 32767] as const
/** The port the forwarder listens on inside its container, and the uid of
 *  the Envoy image's `envoy` user, which it runs as. */
const FRONT_PORT = 10000
const ENVOY_UID = 101

type Run = (file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>

interface RawService {
  metadata?: { name?: string; namespace?: string; annotations?: Record<string, string> }
  spec?: { externalIPs?: string[]; ports?: Array<{ port?: number; nodePort?: number }> }
}

function serviceRef(): ObjectRef {
  return { apiVersion: 'v1', kind: 'Service', name: SERVER_TOKEN_SERVICE_NAME, namespace: k8sNamespace() }
}

function secretRef(): ObjectRef {
  return { apiVersion: 'v1', kind: 'Secret', name: SERVER_TOKEN_TLS_SECRET, namespace: k8sNamespace() }
}

/** The install's token endpoint as the live cluster records it, or null. */
export async function installedTokenListen(): Promise<TokenListen | null> {
  const recorded = (await readObject<RawService>(serviceRef()))?.metadata?.annotations?.[LISTEN_ANNOTATION]
  return recorded === undefined ? null : parseTokenListen(recorded)
}

/**
 * What a byo install refuses before it applies anything: an address no
 * node reports, an address and port another Service already names (the
 * API server checks external addresses for no clash), and a port a node
 * uses itself, since kube-proxy's rule takes a packet before a process
 * listening there would.
 */
export async function refuseByoTokenListen(listen: TokenListen): Promise<void> {
  if (NODE_PORTS.includes(listen.port) || (listen.port >= NODE_PORT_RANGE[0] && listen.port <= NODE_PORT_RANGE[1])) {
    throw new ClusterInstallError(
      `--token-listen port ${String(listen.port)} is one a node uses itself (${NODE_PORTS.join(', ')} and `
      + `${String(NODE_PORT_RANGE[0])}-${String(NODE_PORT_RANGE[1])}); pick a port nothing on the node listens on.`,
    )
  }
  const nodes = await listObjects<{ status?: { addresses?: Array<{ address?: string }> } }>('v1', 'Node')
  const addresses = nodes.flatMap((n) => (n.status?.addresses ?? []).map((a) => a.address ?? '')).filter(isIPv4)
  if (!addresses.includes(listen.address)) {
    throw new ClusterInstallError(
      `--token-listen ${listen.address} is no address a node reports; the nodes report ${addresses.join(', ') || 'none'}.`,
    )
  }
  const clash = (await listObjects<RawService>('v1', 'Service')).find((s) =>
    !(s.metadata?.name === SERVER_TOKEN_SERVICE_NAME && s.metadata.namespace === k8sNamespace())
    && (s.spec?.externalIPs ?? []).includes(listen.address)
    && (s.spec?.ports ?? []).some((p) => p.port === listen.port))
  if (clash !== undefined) {
    throw new ClusterInstallError(
      `--token-listen ${formatTokenListen(listen)} is already named by the Service `
      + `${clash.metadata?.namespace ?? ''}/${clash.metadata?.name ?? ''}; pick another port.`,
    )
  }
}

/**
 * Make sure the Secret holds a certificate for `address` (`planTokenCertificate`
 * decides whether to write one), and answer its key fingerprint.
 */
export async function ensureTokenTlsSecret(address: string): Promise<string> {
  const stored = await readTokenTlsSecret()
  const next = await planTokenCertificate(stored, address)
  if (next !== null) {
    await applyObject({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: SERVER_TOKEN_TLS_SECRET, namespace: k8sNamespace(), labels: { app: SERVER_APP_NAME } },
      type: 'kubernetes.io/tls',
      data: {
        [TOKEN_TLS_CERT_FILE]: Buffer.from(next.cert).toString('base64'),
        [TOKEN_TLS_KEY_FILE]: Buffer.from(next.key).toString('base64'),
      },
    })
  }
  return tokenKeyFingerprint(next?.cert ?? stored.cert as string)
}

/** Whichever of the pair's parts the Secret holds. */
export async function readTokenTlsSecret(): Promise<Partial<TokenTlsPair>> {
  const data = (await readObject<{ data?: Record<string, string> }>(secretRef()))?.data ?? {}
  const decode = (name: string): string | undefined => data[name] === undefined ? undefined : Buffer.from(data[name], 'base64').toString()
  const [cert, key] = [decode(TOKEN_TLS_CERT_FILE), decode(TOKEN_TLS_KEY_FILE)]
  return { ...(cert !== undefined ? { cert } : {}), ...(key !== undefined ? { key } : {}) }
}

/**
 * The token Service: a NodePort on kind, whose node port the API server
 * picks and the forwarder dials; on byo a ClusterIP whose `externalIPs`
 * makes kube-proxy deliver `<addr>:<port>` and nothing else.
 */
export function buildTokenServiceManifest(listen: TokenListen, byo: boolean): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: SERVER_TOKEN_SERVICE_NAME,
      namespace: k8sNamespace(),
      labels: { app: SERVER_APP_NAME },
      annotations: { [LISTEN_ANNOTATION]: formatTokenListen(listen) },
    },
    spec: byo
      ? {
        type: 'ClusterIP',
        selector: { app: SERVER_APP_NAME },
        externalIPs: [listen.address],
        ports: [{ name: 'token', port: listen.port, targetPort: SERVER_TOKEN_PORT }],
      }
      : {
        type: 'NodePort',
        selector: { app: SERVER_APP_NAME },
        ports: [{ name: 'token', port: SERVER_TOKEN_PORT, targetPort: SERVER_TOKEN_PORT }],
      },
  }
}

/**
 * Apply the token endpoint's policy and Service, policy first, so no
 * moment has the Service routing to a port the policy has not opened. A
 * cluster that admits no `externalIPs` (`DenyServiceExternalIPs`) is
 * reported as that.
 */
export async function applyTokenEndpoint(listen: TokenListen, byo: boolean): Promise<void> {
  await applyObject(buildServerTokenIngressNpManifest())
  try {
    await applyObject(buildTokenServiceManifest(listen, byo))
  } catch (err) {
    if (byo && /externalIPs|external IPs/i.test(String((err as Error).message))) {
      throw new ClusterInstallError(
        'This cluster refuses Services with externalIPs (the DenyServiceExternalIPs admission plugin), which '
        + `--token-listen needs on a --byo install: ${(err as Error).message}`,
      )
    }
    throw err
  }
}

/** Remove the token endpoint's policy and Service; the Secret is kept, so
 *  enabling it again keeps the key callers pinned. */
export async function removeTokenEndpoint(): Promise<void> {
  await deleteObject(serviceRef())
  await deleteObject({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', name: SERVER_TOKEN_INGRESS_NP_NAME, namespace: k8sNamespace() })
}

/** The node port the API server gave the kind Service. */
export async function tokenNodePort(): Promise<number> {
  const port = (await readObject<RawService>(serviceRef()))?.spec?.ports?.[0]?.nodePort
  if (port === undefined) throw new Error(`the ${SERVER_TOKEN_SERVICE_NAME} Service has no node port`)
  return port
}

/** The kind forwarder's container name, one per install. */
export function tokenFrontName(): string {
  return `yaac-token-front-${installId()}`
}

/**
 * Run, keep or replace the kind forwarder: a podman container on the kind
 * network that publishes `listen` (so podman binds exactly that address)
 * and passes connections to the control-plane node's `nodePort`. Its
 * labels record what it was run for; one run for anything else is
 * replaced, and one that is not running (after a reboot) is started.
 * `labels` are added for a test's leak sweep.
 */
export async function ensureTokenFront(
  listen: TokenListen,
  nodePort: number,
  opts: { run?: Run; labels?: string[] } = {},
): Promise<void> {
  const run = opts.run ?? execFileAsync
  const name = tokenFrontName()
  const node = `${env.kindCluster}-control-plane`
  const { stdout: nodeAddr } = await run('podman', ['inspect', '--format', '{{(index .NetworkSettings.Networks "kind").IPAddress}}', node])
  const target = `${nodeAddr.trim()}:${String(nodePort)}`
  const want = { 'yaac.token-front.listen': formatTokenListen(listen), 'yaac.token-front.target': target }
  const current = await run('podman', ['inspect', '--format', '{{json .Config.Labels}} {{.State.Running}}', name])
    .then(({ stdout }) => {
      const cut = stdout.trim().lastIndexOf(' ')
      return { labels: JSON.parse(stdout.trim().slice(0, cut)) as Record<string, string>, running: stdout.trim().slice(cut + 1) === 'true' }
    }, () => undefined)
  if (current !== undefined && Object.entries(want).every(([k, v]) => current.labels[k] === v)) {
    if (!current.running) await run('podman', ['start', name])
    return
  }
  if (current !== undefined) await run('podman', ['rm', '-f', name])
  try {
    await run('podman', [
      'run', '-d', '--name', name, '--network', 'kind', '--restart', 'always',
      // Envoy itself, as the image's own non-root user: the image's
      // entrypoint chowns /dev/stdout before dropping to that user, which a
      // macOS podman machine refuses, so it would never start there.
      '--user', `${String(ENVOY_UID)}:${String(ENVOY_UID)}`, '--entrypoint', 'envoy',
      '-p', `${formatTokenListen(listen)}:${String(FRONT_PORT)}`,
      ...Object.entries(want).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
      ...(opts.labels ?? []).flatMap((l) => ['--label', l]),
      ENVOY_UPSTREAM_IMAGE,
      '--config-yaml', frontConfig(target), '--log-level', 'warn',
    ])
  } catch (err) {
    const holder = await run('ss', ['-ltnp', `sport = :${String(listen.port)}`]).then(({ stdout }) => stdout.trim(), () => '')
    throw new ClusterInstallError(
      `Could not publish the token endpoint at ${formatTokenListen(listen)}: ${(err as Error).message.split('\n')[0]}`
      + (holder.split('\n').length > 1 ? `\n    Held by:\n    ${holder.split('\n').slice(1).join('\n    ')}` : '')
      + '\n    The port is never changed for you: free it, or name another with --token-listen.',
    )
  }
}

/** Remove the kind forwarder, if it is there. */
export async function removeTokenFront(run: Run = execFileAsync): Promise<void> {
  await run('podman', ['rm', '-f', '--ignore', tokenFrontName()]).catch(() => undefined)
}

/** The forwarder's Envoy config: a TCP proxy to the node port. */
function frontConfig(target: string): string {
  const [address, port] = target.split(':')
  return JSON.stringify({
    static_resources: {
      listeners: [{
        name: 'token',
        address: { socket_address: { address: '0.0.0.0', port_value: FRONT_PORT } },
        filter_chains: [{
          filters: [{
            name: 'envoy.filters.network.tcp_proxy',
            typed_config: {
              '@type': 'type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy',
              stat_prefix: 'token',
              cluster: 'node',
            },
          }],
        }],
      }],
      clusters: [{
        name: 'node',
        type: 'STATIC',
        connect_timeout: '5s',
        load_assignment: {
          cluster_name: 'node',
          endpoints: [{ lb_endpoints: [{ endpoint: { address: { socket_address: { address, port_value: Number(port) } } } }] }],
        },
      }],
    },
  })
}

/**
 * The token endpoint as `yaac cluster start|restart|status` print it: where
 * it answers and its key fingerprint; null when the install has none.
 */
export async function installedTokenEndpoint(): Promise<{ listen: string; fingerprint: string | null } | null> {
  const listen = await installedTokenListen()
  if (listen === null) return null
  const { cert } = await readTokenTlsSecret()
  let fingerprint: string | null = null
  try {
    if (cert !== undefined) fingerprint = tokenKeyFingerprint(cert)
  } catch {
    // An unreadable certificate prints as no fingerprint; check reports it.
  }
  return { listen: formatTokenListen(listen), fingerprint }
}

/**
 * The `token-endpoint` check, or null for an install with none: the
 * Secret must hold a whole, matching, current pair, and the policy must be
 * applied and open the token port alone.
 */
export async function tokenEndpointCheck(): Promise<CheckResult | null> {
  if (await installedTokenListen() === null) return null
  const fix = 'Re-run `yaac cluster install` to repair the token endpoint.'
  const { cert, key } = await readTokenTlsSecret()
  const problem = cert === undefined || key === undefined ? `the Secret ${SERVER_TOKEN_TLS_SECRET} holds no tls.crt and tls.key` : tokenPairProblem({ cert, key })
  if (problem !== null) return { name: 'token-endpoint', status: 'fail', detail: problem, fix }
  const policy = await readObject<{ spec?: { ingress?: Array<{ from?: unknown; ports?: Array<{ port?: number }> }> } }>({
    apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', name: SERVER_TOKEN_INGRESS_NP_NAME, namespace: k8sNamespace(),
  })
  const ports = (policy?.spec?.ingress ?? []).flatMap((r) => r.ports ?? []).map((p) => p.port)
  if (policy === null || ports.length !== 1 || ports[0] !== SERVER_TOKEN_PORT) {
    return {
      name: 'token-endpoint', status: 'fail',
      detail: `the NetworkPolicy ${SERVER_TOKEN_INGRESS_NP_NAME} ${policy === null ? 'is missing' : `opens ports ${ports.join(', ') || 'none'}, not the token port alone`}`,
      fix,
    }
  }
  return { name: 'token-endpoint', status: 'pass', detail: 'its certificate is current and its policy opens the token port alone' }
}
