/**
 * What sits in front of the server's Service, per backend.
 *
 * The server Deployment is one manifest on every backend; what differs is
 * how its Service is reached from outside the cluster, and every such
 * difference is rendered here as a manifest set rather than branched on in
 * the driver (docs/plans/cloud-k8s.md "Two backends, one driver"). A
 * fronting answers the questions install asks in order: what to apply for
 * the origin to answer (and what the other fronting left behind), which
 * peers its ingress policy must admit, what origin it published, what the
 * Deployment's environment must say about that origin, and how long that
 * origin may take to answer.
 *
 * The LIVE cluster is the record of which fronting an install chose: a
 * `tailscale`-class Ingress named for the server is the tailnet fronting,
 * and `frontingOfIngress` reads it back so that `yaac server
 * start|restart` can wait on the right origin with no new state on disk.
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
import { execFileAsync, registryRef } from '#drivers/k8s/container'
import { env } from '@yaac/shared/env'
import { ClusterInstallError } from './arg-guards'

/** What the Deployment's environment must state for a published origin. */
export interface RemoteHosting {
  allowedHosts: string[]
}

/** A `kubectl delete` target: resource kind and name, in the install namespace. */
export type FrontingObject = [kind: string, name: string]

export interface ServerFronting {
  kind: 'kind' | 'tailnet'
  /**
   * Everything that has to exist for the origin to answer, the server's
   * Service first. Applied in order before the origin is resolved; every
   * Deployment among them is rolled out before the origin is probed.
   */
  manifests(): Record<string, unknown>[]
  /**
   * The OTHER fronting's objects, deleted on apply so a re-install that
   * switches fronting leaves nothing of the old one behind — above all no
   * Ingress that would make `frontingOfIngress` answer the wrong way.
   */
  retired(): FrontingObject[]
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
  return {
    kind: 'kind',
    manifests: () => [
      serverServiceManifest(),
      buildServerFrontConfigMapManifest(),
      buildServerFrontDeploymentManifest(registryRef(ENVOY_MIRROR_TAG)),
    ],
    retired: () => [['ingress', SERVER_APP_NAME]],
    ingressPeers: () => [],
    resolveOrigin: async () => `http://127.0.0.1:${String(await kindPublishedPort())}`,
    remoteHosting: () => ({ allowedHosts: [] }),
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
  + 'install`. Running worktrees are lost (as any cluster delete loses them); '
  + 'nothing under the data dir is touched.'

/**
 * The host port the kind cluster publishes the server on. kind fixes it
 * when the cluster is CREATED, so an unset `YAAC_SERVER_PORT` in this
 * shell says nothing about it: a cluster created under another value holds
 * that one, and it is read off the control-plane node's own mapping. An
 * explicit `YAAC_SERVER_PORT` still names it outright, which is how the
 * e2e harness publishes each file's server on a forward of its own.
 *
 * There is no fallback port. Whatever answers a guessed one is not this
 * cluster, and install would register it. A node without the mapping is
 * refused with the recreate advice at once, and any other podman failure
 * with podman's own words.
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

/** What `kubectl get ingress -o json` answers, as far as a fronting reads it. */
interface RawIngress {
  spec?: { ingressClassName?: string; tls?: Array<{ hosts?: string[] }> }
  status?: { loadBalancer?: { ingress?: Array<{ hostname?: string }> } }
}

/** How long the operator gets to publish a hostname into the Ingress status. */
const TAILNET_PUBLISH_TIMEOUT_MS = 120_000

/**
 * The tailnet fronting: the server's ClusterIP Service behind the
 * Tailscale Kubernetes operator's `tailscale`-class Ingress, which gives
 * the server a tailnet-only MagicDNS name with a TLS certificate and
 * nothing else — no public LoadBalancer, no NodePort, no DNS to manage.
 *
 * An Ingress rather than the operator's L4 LoadBalancer Service, for two
 * reasons. An `http://` origin is not a secure context, and the webapp
 * quietly loses clipboard writes and the pickers there. And the Ingress
 * proxy IS `tailscale serve`: it terminates TLS, strips client-supplied
 * identity and forwarding headers and stamps its own, where an L4
 * exposure hands the pod whatever a tailnet device chose to send
 * (docs/remote-hosting.md).
 *
 * The operator runs a proxy pod per Ingress in its own namespace, labelled
 * with the Ingress it fronts, and dials the Service from that pod — which
 * is why the ingress peer is a pod selector rather than an address, and
 * why the Ingress carries the server's name. The origin is the `https://`
 * name the operator publishes into the Ingress status.
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
    retired: () => [['deployment', SERVER_FRONT_APP_NAME], ['configmap', SERVER_FRONT_APP_NAME]],
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
        const ing = await kubectlGetJson<RawIngress>([
          'get', 'ingress', SERVER_APP_NAME, '-n', k8sNamespace(),
        ])
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
    // The published name is what admits the tailnet — and, being no
    // loopback name, what puts every request through the identity rule.
    remoteHosting: (origin) => ({ allowedHosts: [new URL(origin).hostname] }),
    // The first HTTPS request to a new name is what makes the operator's
    // proxy fetch its certificate, which takes a while.
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
 * Which fronting an install's live Ingress records. A `tailscale`-class
 * Ingress named for the server is the tailnet fronting, published under
 * the device name its TLS host asks for; anything else — no Ingress at
 * all, which is what every kind install and the e2e harness have — is the
 * kind fronting, by the general rule rather than by a special case.
 */
export function frontingOfIngress(ingress: Record<string, unknown> | null): ServerFronting {
  const raw = ingress as RawIngress | null
  if (raw?.spec?.ingressClassName === TAILSCALE_INGRESS_CLASS) {
    return tailnetFronting({ hostname: raw.spec.tls?.[0]?.hosts?.[0] ?? TAILNET_HOSTNAME })
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
 *
 * The trailing dot makes the name absolute. It has four dots, under the
 * pod's `ndots:5`, so it would otherwise be tried against every search
 * domain first — and a hostNetwork pod's list ends with the NODE's (the
 * podman network's, a tailnet's), which CoreDNS forwards upstream. Where
 * that upstream hangs (a VPN owning the host's DNS), resolution never
 * reaches the bare name and the server's origin never answers. Absolute,
 * it is one query CoreDNS answers itself.
 */
export function buildServerFrontConfigMapManifest(): Record<string, unknown> {
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
