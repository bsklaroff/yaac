/**
 * In-cluster exposure of the shared `yaac-registry` container for builder
 * pods (docs/trust-split-builds.md).
 *
 * The registry is a podman container on the podman `kind` network — the
 * kind NODE reaches it by container name via containerd's hosts.toml, but
 * it has no cluster DNS entry, so a POD (the ephemeral runsc builder, whose
 * in-sandbox podman pulls parents and pushes products) cannot address it.
 * A selectorless Service plus a manually-written EndpointSlice pointing at
 * the registry's kind-network IP gives pods a stable name
 * (`yaac-registry.<ns>.svc.cluster.local:5000`) without moving the
 * registry into the cluster.
 *
 * The IP is discovered host-side (`podman inspect`) and re-written on
 * every ensure — cheap, and self-healing when the registry container is
 * recreated with a new address. Written during `yaac cluster setup`
 * (production namespace) and lazily by the builder engine (per-run e2e
 * namespaces).
 */
import {
  execFileAsync,
  k8sNamespace,
  kubectlApply,
} from '#platform/k8s/kubectl'
import { REGISTRY_CONTAINER_NAME } from '#platform/container'
import { ensureNamespace } from './proxy-apply'

/** Service (and EndpointSlice) name — matches the container name. */
export const REGISTRY_SERVICE_NAME = 'yaac-registry'

/**
 * Service and target port. The registry container listens on 5000
 * in-network (the host-published 5001 is loopback-only and irrelevant to
 * pods).
 */
export const REGISTRY_SERVICE_PORT = 5000

/**
 * The registry host builder pods push/pull through. Full FQDN, matching
 * the per-project registries' convention (split-horizon resolvers treat
 * the bare `<svc>.<ns>.svc` form inconsistently).
 */
export function registryClusterHost(): string {
  return `${REGISTRY_SERVICE_NAME}.${k8sNamespace()}.svc.cluster.local:${REGISTRY_SERVICE_PORT}`
}

/**
 * The registry container's IP on the podman `kind` network (the network
 * `yaac cluster setup` connects it to). Throws with a repair pointer when
 * the container is missing or not on the network.
 */
export async function discoverRegistryKindIp(): Promise<string> {
  let raw: string
  try {
    const { stdout } = await execFileAsync('podman', [
      'inspect', REGISTRY_CONTAINER_NAME,
      '--format', '{{json .NetworkSettings.Networks}}',
    ])
    raw = stdout.trim()
  } catch (err) {
    // execFileAsync is promisified execFile, which only ever rejects with an
    // Error — no non-Error branch to guard.
    throw new Error(
      `cannot inspect the ${REGISTRY_CONTAINER_NAME} container — is the local `
      + `registry running? Run \`yaac cluster check\`.\n${(err as Error).message}`,
    )
  }
  const networks = JSON.parse(raw) as Record<string, { IPAddress?: string }>
  const ip = networks.kind?.IPAddress
  if (!ip) {
    throw new Error(
      `${REGISTRY_CONTAINER_NAME} is not on the podman "kind" network `
      + '(builder pods reach it through a Service targeting its kind-network '
      + 'IP). Run `yaac cluster setup --repair`.',
    )
  }
  return ip
}

/** Selectorless Service — endpoints come from the EndpointSlice below. */
export function buildRegistryServiceManifest(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: REGISTRY_SERVICE_NAME,
      namespace: k8sNamespace(),
    },
    spec: {
      // No selector: the backend is not a pod. kube-proxy still programs
      // the ClusterIP DNAT from the custom EndpointSlice.
      ports: [{
        port: REGISTRY_SERVICE_PORT,
        targetPort: REGISTRY_SERVICE_PORT,
        protocol: 'TCP',
      }],
    },
  }
}

/**
 * The Service's endpoints: the registry container's kind-network IP. The
 * `kubernetes.io/service-name` label is what binds a manual EndpointSlice
 * to its selectorless Service.
 */
export function buildRegistryEndpointSliceManifest(ip: string): Record<string, unknown> {
  return {
    apiVersion: 'discovery.k8s.io/v1',
    kind: 'EndpointSlice',
    metadata: {
      name: `${REGISTRY_SERVICE_NAME}-1`,
      namespace: k8sNamespace(),
      labels: { 'kubernetes.io/service-name': REGISTRY_SERVICE_NAME },
    },
    addressType: 'IPv4',
    ports: [{ name: '', port: REGISTRY_SERVICE_PORT, protocol: 'TCP' }],
    endpoints: [{ addresses: [ip], conditions: { ready: true } }],
  }
}

/**
 * Ensure the Service + EndpointSlice exist in the current namespace and
 * point at the registry's live kind-network IP. Idempotent; returns the
 * in-cluster registry host.
 */
export async function ensureRegistryClusterService(): Promise<string> {
  const ip = await discoverRegistryKindIp()
  await ensureNamespace()
  await kubectlApply(buildRegistryServiceManifest())
  await kubectlApply(buildRegistryEndpointSliceManifest(ip))
  return registryClusterHost()
}
