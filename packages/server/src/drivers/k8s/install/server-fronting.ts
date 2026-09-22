/**
 * What sits in front of the server's Service, per backend.
 *
 * The server Deployment is one manifest on every backend; what differs is
 * how its Service is reached from outside the cluster, and every such
 * difference is rendered here as a manifest set rather than branched on in
 * the driver (docs/plans/cloud-k8s.md "Two backends, one driver"). A
 * fronting answers five questions install asks in order: what Service to
 * apply, what else must exist for it to be reachable, which peers its
 * ingress policy must admit, what origin it published, and what the
 * Deployment's environment must say about that origin.
 *
 * The LIVE Service is the record of which fronting an install chose:
 * `frontingOfService` reads it back so that `yaac server start|restart`
 * can wait on the right origin with no new state on disk, and so that a
 * later install mode selects a fronting by passing one value here.
 *
 * Install-only, like the rest of this folder.
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
  kubectlGetJson,
} from '#drivers/k8s/substrate'
import { ENVOY_MIRROR_TAG } from '#drivers/k8s/cluster'
import { registryRef } from '#drivers/k8s/container'
import { resolveServerPort } from '@yaac/shared/server-port'
import { ClusterInstallError } from './arg-guards'

/** What the Deployment's environment must state for a published origin. */
export interface RemoteHosting {
  allowedHosts: string[]
  trustProxy: boolean
}

export interface ServerFronting {
  kind: 'kind' | 'tailnet'
  /** The Service, in the shape this fronting needs. */
  serviceManifest(): Record<string, unknown>
  /**
   * Anything else that has to exist for the origin to answer — the kind
   * forwarder's ConfigMap and Deployment. Applied after the Service; every
   * Deployment among them is rolled out before the origin is probed.
   */
  extraManifests(): Record<string, unknown>[]
  /**
   * NetworkPolicy `from` peers that deliver fronted traffic to the server
   * pod. The node addresses are NOT listed here: they are admitted
   * unconditionally by the node half of the wall (policy-manifests.ts).
   */
  ingressPeers(): Record<string, unknown>[]
  /**
   * The origin clients dial, once the fronting has published one. Reads the
   * fronting's own object when the origin is not known up front.
   */
  resolveOrigin(): Promise<string>
  /** What the Deployment's env must state for that origin. */
  remoteHosting(origin: string): RemoteHosting
  /** Diagnosis for "rolled out, but the origin never answered". */
  unreachableDiagnosis(origin: string): string
}

/**
 * The kind fronting: a ClusterIP Service, and a hostNetwork Envoy on the
 * control-plane node that forwards the port the kind `extraPortMapping`
 * targets into it.
 *
 * A forwarder rather than a NodePort, because of what the server pod's
 * ingress policy SEES. Calico evaluates policy in the filter hook, before
 * kube-proxy's POSTROUTING masquerade, so a NodePort connection presents
 * its original source — which for a kind port mapping is the host's
 * address as the node container sees it: the podman bridge gateway on
 * Linux, gvproxy's address inside the VM on macOS. Neither is a node
 * address. A forwarder in the node's own network namespace dials the
 * ClusterIP itself, so what reaches the pod is sourced from that node —
 * its InternalIP, or its Calico tunnel address when the pod is on a
 * worker — which is exactly the set the node half of the wall admits, and
 * exactly the flow the proxy's ingress policy already admits for netd's
 * Envoy. Nothing about the host side is guessed, on any platform, and the
 * API stops being published on every address the nodes have.
 */
export function kindFronting(): ServerFronting {
  const origin = `http://127.0.0.1:${String(resolveServerPort())}`
  return {
    kind: 'kind',
    serviceManifest: () => ({
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
    }),
    extraManifests: () => [
      buildServerFrontConfigMapManifest(),
      buildServerFrontDeploymentManifest(registryRef(ENVOY_MIRROR_TAG)),
    ],
    ingressPeers: () => [],
    resolveOrigin: () => Promise.resolve(origin),
    remoteHosting: () => ({ allowedHosts: [], trustProxy: false }),
    unreachableDiagnosis: () =>
      'This is what a cluster created before the server was published looks '
      + 'like: the mapped port has no host end, and kind writes port mappings '
      + 'only when a cluster is created.\n'
      + '    Recreate it: `yaac cluster delete`, then `yaac cluster install`. '
      + 'Running worktrees are lost (as any cluster delete loses them); nothing '
      + 'under the data dir is touched.\n'
      + `    If the cluster is recent, inspect the forwarder: \`kubectl -n ${k8sNamespace()} `
      + `get deploy,pods -l app=${SERVER_FRONT_APP_NAME}\`.`,
  }
}

/** The Service's `loadBalancerClass` value that names the Tailscale operator. */
const TAILSCALE_LB_CLASS = 'tailscale'
/** Annotation the operator reads the device name from — and we read it back from. */
const TAILSCALE_HOSTNAME_ANNOTATION = 'tailscale.com/hostname'
/** The device name a yaac server publishes as. */
export const TAILNET_HOSTNAME = 'yaac'

/** What `kubectl get service -o json` answers, as far as a fronting reads it. */
interface RawService {
  metadata?: { annotations?: Record<string, string> }
  spec?: { loadBalancerClass?: string }
  status?: { loadBalancer?: { ingress?: Array<{ hostname?: string; ip?: string }> } }
}

/** How long the operator gets to publish a hostname into the Service status. */
const TAILNET_PUBLISH_TIMEOUT_MS = 120_000

/**
 * The tailnet fronting: the Tailscale Kubernetes operator's LoadBalancer
 * Service, which gives the server a tailnet-only MagicDNS name and nothing
 * else (docs/plans/cloud-k8s.md "The tailnet is the only way onto a cloud
 * server"). No public LoadBalancer, no NodePort on the side —
 * `allocateLoadBalancerNodePorts: false`, since a LoadBalancer Service
 * allocates one by default and that would publish the API on every node
 * address of a pool behind nothing but the policy.
 *
 * The operator runs a proxy pod per exposed Service in its own namespace,
 * labelled with the Service it fronts, and SNATs tailnet traffic to that
 * pod's address on the way in — which is why the ingress peer is a pod
 * selector rather than an address. The origin is whatever MagicDNS name
 * the operator publishes into the Service status; the server is told to
 * admit it and to require a credential, because the tailnet is the trust
 * boundary now and not this machine's loopback.
 */
export function tailnetFronting(opts: { hostname: string }): ServerFronting {
  return {
    kind: 'tailnet',
    serviceManifest: () => ({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: SERVER_APP_NAME,
        namespace: k8sNamespace(),
        labels: { app: SERVER_APP_NAME },
        annotations: { [TAILSCALE_HOSTNAME_ANNOTATION]: opts.hostname },
      },
      spec: {
        type: 'LoadBalancer',
        loadBalancerClass: TAILSCALE_LB_CLASS,
        allocateLoadBalancerNodePorts: false,
        selector: { app: SERVER_APP_NAME },
        ports: [{ name: 'api', port: SERVER_POD_PORT, targetPort: SERVER_POD_PORT }],
      },
    }),
    extraManifests: () => [],
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
        const svc = await kubectlGetJson<RawService>([
          'get', 'service', SERVER_APP_NAME, '-n', k8sNamespace(),
        ])
        const hostname = svc?.status?.loadBalancer?.ingress?.find((i) => i.hostname)?.hostname
        if (hostname) return `http://${hostname}`
        if (Date.now() >= deadline) {
          throw new ClusterInstallError(
            'The Tailscale operator did not publish a hostname for the server '
            + `Service within ${String(TAILNET_PUBLISH_TIMEOUT_MS / 1000)}s.\n`
            + `    Inspect it: kubectl -n ${TAILSCALE_OPERATOR_NAMESPACE} get deploy operator; `
            + `kubectl -n ${k8sNamespace()} describe service ${SERVER_APP_NAME}; `
            + `kubectl -n ${TAILSCALE_OPERATOR_NAMESPACE} get pods -l `
            + `${TAILSCALE_PARENT_RESOURCE_LABEL}=${SERVER_APP_NAME}\n`
            + '    The usual causes are the operator\'s OAuth client lacking the '
            + 'tag its proxies need, or the tailnet ACL not admitting it.',
          )
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
    },
    // The published name alone is what admits the tailnet and requires
    // a credential. NOT `trustProxy`: the operator's Service is an L4
    // exposure that sanitizes no header, so trusting `X-Forwarded-*` here
    // would let any tailnet client forge them. The TLS-terminating form of
    // this fronting is where that flag belongs.
    remoteHosting: (origin) => ({ allowedHosts: [new URL(origin).hostname], trustProxy: false }),
    unreachableDiagnosis: (origin) =>
      `The operator published ${origin}, but this machine cannot reach it. `
      + 'It has to be on the same tailnet (`tailscale status`), and the tailnet\'s '
      + 'ACLs have to admit it to the server\'s device.',
  }
}

/**
 * Which fronting installed the Service this install runs. A Service of the
 * tailnet class is the tailnet fronting; anything else — a ClusterIP, a
 * NodePort from an install not yet re-converged, or no Service at all (the
 * e2e harness reaches its server by port-forward) — is the kind fronting,
 * by the general rule rather than by a special case.
 */
export function frontingOfService(svc: Record<string, unknown> | null): ServerFronting {
  const raw = svc as RawService | null
  if (raw?.spec?.loadBalancerClass === TAILSCALE_LB_CLASS) {
    return tailnetFronting({
      hostname: raw.metadata?.annotations?.[TAILSCALE_HOSTNAME_ANNOTATION] ?? TAILNET_HOSTNAME,
    })
  }
  return kindFronting()
}

/** Every pod of the forwarder carries the install identity, like the server's. */
function frontPodLabels(): Record<string, string> {
  return { app: SERVER_FRONT_APP_NAME, [LABEL_DATA_DIR_HASH]: dataDirHash() }
}

const FRONT_CONFIG_DIR = '/etc/yaac-server-front'

/**
 * Envoy's static bootstrap for the forwarder: one TCP-proxy listener on the
 * mapped port, one cluster at the server Service's DNS name. `STRICT_DNS`
 * on the name rather than a `STATIC` ClusterIP, so the ConfigMap never has
 * to be re-rendered when the Service is recreated; the pod's
 * `ClusterFirstWithHostNet` DNS policy is what lets a host-networked
 * process resolve a cluster name.
 */
export function buildServerFrontConfigMapManifest(): Record<string, unknown> {
  const upstream = `${SERVER_APP_NAME}.${k8sNamespace()}.svc.cluster.local`
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
 * The forwarder Deployment.
 *
 * `hostNetwork` on the control-plane node, because that is the node the
 * kind port mapping delivers to, and `Recreate` because two pods of it
 * would contend for one node port. Trusted yaac infra: plain runc, infra
 * priority, every capability dropped, a non-root uid — it binds one port
 * above 1024 and dials one ClusterIP. `--use-dynamic-base-id` for the
 * reason netd's Envoy states it: several hostNetwork Envoys share a node.
 * Readiness is the listener itself; the kubelet dials it at the node
 * address, which is what a client's connection does too.
 */
export function buildServerFrontDeploymentManifest(envoyImage: string): Record<string, unknown> {
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
