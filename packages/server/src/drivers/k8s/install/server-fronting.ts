/**
 * How the server's Service is reached from outside the cluster (its
 * "fronting"): a host port on kind, or a Tailscale Ingress
 * (docs/server-in-cluster.md "Reachability"). Each fronting supplies its
 * manifests, ingress peers, published origin and timeouts.
 *
 * The fronting is not stored on disk: `frontingOfIngress` reads it back
 * from the live cluster so `yaac server start|restart` can wait on the
 * right origin.
 */
import {
  LABEL_DATA_DIR_HASH,
  PRIORITY_CLASS_INFRA,
  SERVER_APP_NAME,
  SERVER_FRONT_APP_NAME,
  SERVER_FRONT_PORT,
  SERVER_POD_PORT,
  TAILSCALE_OPERATOR_NAMESPACE,
  TAILSCALE_PARENT_NAMESPACE_LABEL,
  TAILSCALE_PARENT_RESOURCE_LABEL,
  dataDirHash,
  k8sNamespace,
  readObject,
  type ObjectRef,
} from '#drivers/k8s/substrate'
import { ENVOY_MIRROR_TAG } from '#drivers/k8s/cluster'
import { execFileAsync, registryRef } from '#drivers/k8s/container'
import { env } from '@yaac/shared/env'
import type { AccessMode } from '@yaac/shared/types'
import { ClusterInstallError } from './arg-guards'

/** What the Deployment's environment must state for a published origin:
 *  the access mode it serves in, and the names it is reached at. */
export interface RemoteHosting {
  accessMode: AccessMode
  allowedHosts: string[]
}

/** An object a fronting owns, in the install namespace. */
type FrontingObject = Omit<ObjectRef, 'namespace'>

export interface ServerFronting {
  kind: 'kind' | 'tailnet'
  /**
   * Objects the origin needs, the server's Service first. Applied in order
   * and rolled out before the origin is resolved and probed.
   */
  manifests(): Record<string, unknown>[]
  /**
   * The other fronting's objects, deleted on apply so switching fronting
   * leaves nothing behind (especially an Ingress `frontingOfIngress` would
   * misread).
   */
  retired(): FrontingObject[]
  /**
   * NetworkPolicy `from` peers that deliver fronted traffic to the server
   * pod. Node addresses are admitted separately (cluster/policy-manifests.ts).
   */
  ingressPeers(): Record<string, unknown>[]
  /** The origin clients dial, waiting for the fronting to publish it. */
  resolveOrigin(): Promise<string>
  /** What the Deployment's env must state for that origin. */
  remoteHosting(origin: string): RemoteHosting
  /** How long the rolled server gets to answer at that origin. */
  publishTimeoutMs: number
  /** Diagnosis for "rolled out, but the origin never answered". */
  unreachableDiagnosis(origin: string): string
}

/** The server's Service: a ClusterIP under every fronting. */
function serverServiceManifest(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: SERVER_APP_NAME,
      namespace: k8sNamespace(),
      labels: { app: SERVER_APP_NAME },
    },
    spec: {
      type: 'ClusterIP',
      selector: { app: SERVER_APP_NAME },
      ports: [{ name: 'api', port: SERVER_POD_PORT, targetPort: SERVER_POD_PORT }],
    },
  }
}

/**
 * The kind fronting: a hostNetwork Envoy on the control-plane node forwards
 * the kind `extraPortMapping` port to the server's ClusterIP Service.
 *
 * Not a NodePort: Calico applies policy before kube-proxy's masquerade, so
 * a NodePort connection would arrive from the host's address (the podman
 * gateway or gvproxy), which the server's ingress policy cannot predict.
 * The forwarder's connections come from the node itself, which the policy
 * already admits.
 */
export function kindFronting(): ServerFronting {
  return {
    kind: 'kind',
    manifests: () => [
      serverServiceManifest(),
      buildServerFrontConfigMapManifest(),
      buildServerFrontDeploymentManifest(registryRef(ENVOY_MIRROR_TAG)),
    ],
    retired: () => [{ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', name: SERVER_APP_NAME }],
    ingressPeers: () => [],
    resolveOrigin: async () => `http://127.0.0.1:${String(await kindPublishedPort())}`,
    remoteHosting: () => ({ accessMode: 'local', allowedHosts: [] }),
    publishTimeoutMs: 60_000,
    unreachableDiagnosis: () =>
      'This is what a cluster created before the server was published looks '
      + 'like: the mapped port has no host end, and kind writes port mappings '
      + `only when a cluster is created.\n    ${KIND_RECREATE_ADVICE}\n`
      + `    If the cluster is recent, inspect the forwarder: \`kubectl -n ${k8sNamespace()} `
      + `get deploy,pods -l app=${SERVER_FRONT_APP_NAME}\`.`,
  }
}

const KIND_RECREATE_ADVICE = 'Recreate it: `yaac cluster delete`, then `yaac cluster '
  + 'install`. Running workspaces are lost (as any cluster delete loses them); '
  + 'nothing under the data dir is touched.'

/**
 * The host port kind publishes the server on. `YAAC_SERVER_PORT` wins when
 * set (the e2e harness uses it); otherwise it is read from the
 * control-plane node's port mapping, which kind fixes at cluster creation.
 * There is no fallback: a node without the mapping is refused with advice
 * to recreate the cluster.
 */
async function kindPublishedPort(): Promise<number> {
  if (env.serverPort !== undefined) return env.serverPort
  const node = `${env.kindCluster}-control-plane`
  let stdout = ''
  try {
    ({ stdout } = await execFileAsync('podman', ['port', node, `${String(SERVER_FRONT_PORT)}/tcp`]))
  } catch (err) {
    const stderr = ((err as { stderr?: string }).stderr ?? '').trim()
      || (err instanceof Error ? err.message : String(err))
    if (!stderr.includes('failed to find published port')) {
      throw new ClusterInstallError(
        `Cannot read the server's host port off the kind node ${node}: ${stderr}`,
      )
    }
  }
  const mapped = stdout.trim().split('\n')[0]
  if (mapped === '') {
    throw new ClusterInstallError(
      `The kind node ${node} publishes no host port for the server: the cluster `
      + 'was created before the server was published, and kind writes port '
      + `mappings only when a cluster is created.\n    ${KIND_RECREATE_ADVICE}`,
    )
  }
  const port = Number(mapped.split(':').pop())
  if (!Number.isInteger(port) || port <= 0) {
    throw new ClusterInstallError(
      `Unexpected \`podman port\` output for the kind node ${node}: ${mapped}`,
    )
  }
  return port
}

/** The IngressClass the Tailscale operator serves. */
const TAILSCALE_INGRESS_CLASS = 'tailscale'
/** The device name a yaac server publishes as. */
export const TAILNET_HOSTNAME = 'yaac'

/** The server Ingress, as far as a fronting reads it. */
interface RawIngress {
  spec?: { ingressClassName?: string; tls?: Array<{ hosts?: string[] }> }
  status?: { loadBalancer?: { ingress?: Array<{ hostname?: string }> } }
}

/** How long the operator gets to publish a hostname into the Ingress status. */
const TAILNET_PUBLISH_TIMEOUT_MS = 120_000

/**
 * The tailnet fronting: the Tailscale operator's `tailscale`-class Ingress
 * gives the server a tailnet-only MagicDNS name with TLS.
 *
 * An Ingress rather than an L4 LoadBalancer because the webapp needs an
 * `https://` origin (a secure context), and because the Ingress proxy
 * terminates TLS and replaces client-supplied identity headers
 * (docs/remote-hosting.md). The operator's proxy pod, in its own
 * namespace, is the ingress peer. The origin is the hostname the operator
 * publishes in the Ingress status.
 */
export function tailnetFronting(opts: { hostname: string }): ServerFronting {
  return {
    kind: 'tailnet',
    manifests: () => [serverServiceManifest(), {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: SERVER_APP_NAME,
        namespace: k8sNamespace(),
        labels: { app: SERVER_APP_NAME },
      },
      spec: {
        ingressClassName: TAILSCALE_INGRESS_CLASS,
        defaultBackend: { service: { name: SERVER_APP_NAME, port: { number: SERVER_POD_PORT } } },
        tls: [{ hosts: [opts.hostname] }],
      },
    }],
    retired: () => [
      { apiVersion: 'apps/v1', kind: 'Deployment', name: SERVER_FRONT_APP_NAME },
      { apiVersion: 'v1', kind: 'ConfigMap', name: SERVER_FRONT_APP_NAME },
    ],
    ingressPeers: () => [{
      namespaceSelector: {
        matchLabels: { 'kubernetes.io/metadata.name': TAILSCALE_OPERATOR_NAMESPACE },
      },
      podSelector: {
        matchLabels: {
          [TAILSCALE_PARENT_RESOURCE_LABEL]: SERVER_APP_NAME,
          [TAILSCALE_PARENT_NAMESPACE_LABEL]: k8sNamespace(),
        },
      },
    }],
    resolveOrigin: async () => {
      const deadline = Date.now() + TAILNET_PUBLISH_TIMEOUT_MS
      for (;;) {
        const ing = await readObject<RawIngress>({
          apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', name: SERVER_APP_NAME, namespace: k8sNamespace(),
        })
        const hostname = ing?.status?.loadBalancer?.ingress?.find((i) => i.hostname)?.hostname
        if (hostname) return `https://${hostname}`
        if (Date.now() >= deadline) {
          throw new ClusterInstallError(
            'The Tailscale operator did not publish a hostname for the server '
            + `Ingress within ${String(TAILNET_PUBLISH_TIMEOUT_MS / 1000)}s.\n`
            + `    Inspect it: kubectl -n ${TAILSCALE_OPERATOR_NAMESPACE} get deploy operator; `
            + `kubectl -n ${k8sNamespace()} describe ingress ${SERVER_APP_NAME}; `
            + `kubectl -n ${TAILSCALE_OPERATOR_NAMESPACE} get pods -l `
            + `${TAILSCALE_PARENT_RESOURCE_LABEL}=${SERVER_APP_NAME}\n`
            + '    The usual causes are the operator\'s OAuth client lacking the '
            + 'tag its proxies need, or the tailnet ACL not admitting it.',
          )
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
    },
    // A non-loopback host, so every request goes through the identity check.
    remoteHosting: (origin) => ({ accessMode: 'tailnet', allowedHosts: [new URL(origin).hostname] }),
    // The first HTTPS request to a new name triggers a slow certificate fetch.
    publishTimeoutMs: 180_000,
    unreachableDiagnosis: (origin) =>
      `The operator published ${origin}, but this machine cannot reach it over HTTPS.\n`
      + '    Check, in order: that HTTPS certificates are enabled for the tailnet (the '
      + 'admin console\'s DNS page — nothing in the cluster can read that setting); '
      + 'that MagicDNS is on and this machine is on the same tailnet (`tailscale status`); '
      + 'and that the tailnet\'s ACLs admit this machine to the server\'s device.',
  }
}

/**
 * The fronting an install uses, from its live server Ingress: tailnet for
 * a `tailscale`-class Ingress, otherwise kind.
 */
export function frontingOfIngress(ingress: Record<string, unknown> | null): ServerFronting {
  const raw = ingress as RawIngress | null
  if (raw?.spec?.ingressClassName === TAILSCALE_INGRESS_CLASS) {
    return tailnetFronting({ hostname: raw.spec.tls?.[0]?.hosts?.[0] ?? TAILNET_HOSTNAME })
  }
  return kindFronting()
}

/** Forwarder pod labels, including the install identity. */
function frontPodLabels(): Record<string, string> {
  return { app: SERVER_FRONT_APP_NAME, [LABEL_DATA_DIR_HASH]: dataDirHash() }
}

const FRONT_CONFIG_DIR = '/etc/yaac-server-front'

/**
 * Envoy config for the forwarder: a TCP proxy from the mapped port to the
 * server Service's DNS name (resolved via `STRICT_DNS`, so a recreated
 * Service needs no config change).
 *
 * The name ends in a dot so it is not tried against the node's search
 * domains first; those are forwarded upstream, and a hanging upstream DNS
 * (e.g. a VPN) would stop the name from ever resolving.
 */
function buildServerFrontConfigMapManifest(): Record<string, unknown> {
  const upstream = `${SERVER_APP_NAME}.${k8sNamespace()}.svc.cluster.local.`
  const bootstrap = [
    'static_resources:',
    '  listeners:',
    '  - name: front',
    `    address: { socket_address: { address: 0.0.0.0, port_value: ${String(SERVER_FRONT_PORT)} } }`,
    '    filter_chains:',
    '    - filters:',
    '      - name: envoy.filters.network.tcp_proxy',
    '        typed_config:',
    '          "@type": type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy',
    '          stat_prefix: server',
    '          cluster: server',
    '  clusters:',
    '  - name: server',
    '    type: STRICT_DNS',
    '    dns_lookup_family: V4_ONLY',
    '    connect_timeout: 5s',
    '    load_assignment:',
    '      cluster_name: server',
    '      endpoints:',
    '      - lb_endpoints:',
    '        - endpoint:',
    `            address: { socket_address: { address: ${upstream}, port_value: ${String(SERVER_POD_PORT)} } }`,
    '',
  ].join('\n')
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: SERVER_FRONT_APP_NAME,
      namespace: k8sNamespace(),
      labels: { app: SERVER_FRONT_APP_NAME },
    },
    data: { 'bootstrap.yaml': bootstrap },
  }
}

/**
 * The forwarder Deployment: `hostNetwork` on the control-plane node (where
 * the kind port mapping lands), `Recreate` since two pods cannot share the
 * port, non-root with no capabilities. `--use-dynamic-base-id` lets several
 * hostNetwork Envoys share a node.
 */
function buildServerFrontDeploymentManifest(envoyImage: string): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: SERVER_FRONT_APP_NAME,
      namespace: k8sNamespace(),
      labels: { app: SERVER_FRONT_APP_NAME },
    },
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { app: SERVER_FRONT_APP_NAME } },
      template: {
        metadata: { labels: frontPodLabels() },
        spec: {
          hostNetwork: true,
          dnsPolicy: 'ClusterFirstWithHostNet',
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          priorityClassName: PRIORITY_CLASS_INFRA,
          nodeSelector: { 'node-role.kubernetes.io/control-plane': '' },
          tolerations: [{
            key: 'node-role.kubernetes.io/control-plane',
            operator: 'Exists',
            effect: 'NoSchedule',
          }],
          containers: [{
            name: 'envoy',
            image: envoyImage,
            imagePullPolicy: 'IfNotPresent',
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 101,
              runAsGroup: 101,
              allowPrivilegeEscalation: false,
              capabilities: { drop: ['ALL'] },
            },
            command: [
              'envoy', '-c', `${FRONT_CONFIG_DIR}/bootstrap.yaml`,
              '--log-level', 'warn', '--use-dynamic-base-id',
            ],
            ports: [{ containerPort: SERVER_FRONT_PORT, hostPort: SERVER_FRONT_PORT }],
            readinessProbe: {
              tcpSocket: { port: SERVER_FRONT_PORT },
              periodSeconds: 2,
              failureThreshold: 30,
            },
            resources: {
              requests: { cpu: '20m', memory: '32Mi' },
              limits: { memory: '128Mi' },
            },
            volumeMounts: [{ name: 'config', mountPath: FRONT_CONFIG_DIR, readOnly: true }],
          }],
          volumes: [{ name: 'config', configMap: { name: SERVER_FRONT_APP_NAME } }],
        },
      },
    },
  }
}
