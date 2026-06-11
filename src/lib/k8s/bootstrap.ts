import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '@/lib/k8s/kubectl'
import { CA_CONFIGMAP_KEY, CA_CONFIGMAP_NAME } from '@/lib/k8s/pod-spec'
import { LABEL_SESSION_ID } from '@/lib/k8s/pods'
import { credentialsDir, getDataDir } from '@/lib/project/paths'
import { isTorEnabled } from '@/lib/git'

/** Deployment/Service name and pod selector label of the shared proxy. */
export const PROXY_APP_NAME = 'yaac-proxy'
/** Secret holding the daemon→proxy bearer secret. */
export const PROXY_AUTH_SECRET_NAME = 'yaac-proxy-auth'
/** Port the proxy serves inside the cluster (container + Service port). */
export const PROXY_PORT = 10255
/** NetworkPolicy restricting session-pod egress to the proxy + DNS. */
export const SESSION_NETWORK_POLICY_NAME = 'yaac-session-egress'

/**
 * Pod securityContext running the proxy as the daemon's own host uid/gid.
 * The proxy reads/writes hostPath dirs the daemon creates (the CA in
 * /data, the ssh-agent socket dir, and the 0700 credentials dir);
 * matching the creator's uid is what makes those accessible. The image's
 * default `node` uid (1000) only worked on applehv, whose virtiofs
 * ignored ownership — libkrun's enforces it, so a uid mismatch is EACCES.
 *
 * fsGroup makes the emptyDir-backed HOME (see the deployment) group-
 * writable by the proxy process; it applies only to ownership-managed
 * volumes (emptyDir), never to the hostPath mounts, which stay owned by
 * the host uid. Throws if getuid/getgid are unavailable: the daemon's
 * whole hostPath/uid model is POSIX-only, and silently emitting an
 * image-default-uid manifest would crash-loop the proxy on a strict
 * virtiofs host with a confusing EACCES instead of failing here.
 */
export function proxyRunAsSecurityContext(): Record<string, unknown> {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  if (uid === undefined || gid === undefined) {
    throw new Error(
      'proxyRunAsSecurityContext: process.getuid/getgid unavailable — '
      + 'the yaac daemon requires a POSIX host',
    )
  }
  return { securityContext: { runAsUser: uid, runAsGroup: gid, fsGroup: gid } }
}

/**
 * Host directory shared between the proxy pod (which runs ssh-agent on a
 * socket here) and session pods (which point SSH_AUTH_SOCK at it).
 * Single-node assumption: hostPath UNIX sockets only cross pods on the
 * same node.
 */
export function sshAgentHostDir(): string {
  return path.join(getDataDir(), 'run', 'ssh-agent')
}

/**
 * Host directory backing the proxy's `/data` (CA key/cert, tor state).
 * Persisting it across pod replacements keeps the MITM CA stable, so
 * session pods' mounted CA stays valid through proxy image upgrades.
 */
export function proxyDataHostDir(): string {
  return path.join(getDataDir(), 'run', 'proxy-data')
}

export async function ensureNamespace(): Promise<void> {
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: k8sNamespace() },
  })
}

interface RawSecret {
  data?: Record<string, string>
}

/**
 * Ensure the proxy auth Secret exists and return its value. The secret is
 * generated once per cluster and read back on every daemon start —
 * replacing the podman-era trick of recovering it from the proxy
 * container's env on adoption.
 */
export async function ensureProxyAuthSecret(): Promise<string> {
  const existing = await kubectlGetJson<RawSecret>([
    'get', 'secret', PROXY_AUTH_SECRET_NAME, '-n', k8sNamespace(),
  ])
  const encoded = existing?.data?.secret
  if (encoded) return Buffer.from(encoded, 'base64').toString('utf8')

  const secret = crypto.randomBytes(32).toString('hex')
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: PROXY_AUTH_SECRET_NAME, namespace: k8sNamespace() },
    type: 'Opaque',
    data: { secret: Buffer.from(secret).toString('base64') },
  })
  return secret
}

/**
 * Build the proxy Deployment manifest. Exported for unit tests; applied
 * by `ensureProxyResources`.
 *
 * Exposure: ClusterIP Service only — no hostNetwork, no hostPort, no
 * NodePort. The proxy listens inside its pod's network namespace; the
 * daemon reaches it through a loopback `kubectl port-forward`.
 */
export function buildProxyDeploymentManifest(imageRef: string): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: PROXY_APP_NAME,
      namespace: k8sNamespace(),
      labels: { app: PROXY_APP_NAME },
    },
    spec: {
      replicas: 1,
      // Recreate, not RollingUpdate: two proxy pods would race over the
      // shared hostPath ssh-agent socket during the overlap window.
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { app: PROXY_APP_NAME } },
      template: {
        metadata: { labels: { app: PROXY_APP_NAME } },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          ...proxyRunAsSecurityContext(),
          containers: [
            {
              name: 'proxy',
              image: imageRef,
              imagePullPolicy: 'IfNotPresent',
              ports: [{ containerPort: PROXY_PORT }],
              env: [
                { name: 'PORT', value: String(PROXY_PORT) },
                {
                  name: 'PROXY_AUTH_SECRET',
                  valueFrom: {
                    secretKeyRef: { name: PROXY_AUTH_SECRET_NAME, key: 'secret' },
                  },
                },
                // The proxy runs as the daemon's host uid (runAsUser
                // below), which need not own the image's /home/node — so
                // point HOME at a dedicated emptyDir (writable via fsGroup)
                // rather than the CA-bearing /data, keeping ssh material
                // (only public known_hosts) out of the persisted secret
                // dir. ssh-add and the known_hosts writer resolve ~ here.
                { name: 'HOME', value: '/home/proxy' },
                ...(isTorEnabled() ? [{ name: 'USE_TOR', value: '1' }] : []),
              ],
              readinessProbe: {
                httpGet: { path: '/healthz', port: PROXY_PORT },
                periodSeconds: 2,
                failureThreshold: 30,
              },
              volumeMounts: [
                { name: 'credentials', mountPath: '/yaac-credentials' },
                { name: 'ssh-agent', mountPath: '/ssh-agent' },
                { name: 'proxy-data', mountPath: '/data' },
                { name: 'home', mountPath: '/home/proxy' },
              ],
            },
          ],
          volumes: [
            {
              name: 'credentials',
              hostPath: { path: credentialsDir(), type: 'DirectoryOrCreate' },
            },
            {
              name: 'ssh-agent',
              hostPath: { path: sshAgentHostDir(), type: 'DirectoryOrCreate' },
            },
            {
              name: 'proxy-data',
              hostPath: { path: proxyDataHostDir(), type: 'DirectoryOrCreate' },
            },
            // Writable HOME for the proxy's ssh-add/known_hosts. emptyDir
            // (not hostPath) so fsGroup can make it group-writable by the
            // non-root proxy uid, and so nothing the proxy writes under
            // HOME persists onto the host.
            { name: 'home', emptyDir: {} },
          ],
        },
      },
    },
  }
}

/**
 * Build the NetworkPolicy that makes the proxy's allowlist mandatory at
 * the network layer. Without it the allowlist is advisory: HTTP(S)_PROXY
 * env vars are cooperative, and an agent that opens raw sockets has full
 * egress. The policy selects every session pod (any pod carrying the
 * session-id label) and allows egress ONLY to:
 *   - proxy pods (`app: yaac-proxy`) on the proxy port — Service-VIP
 *     traffic matches because policies evaluate post-DNAT against the
 *     backend pod's labels
 *   - kube-dns on port 53, so the proxy's Service name resolves
 *
 * No Ingress rules on purpose: nothing reaches session pods over the pod
 * network — exec, PTY attach, and port relays all ride `kubectl exec`
 * through the kubelet, which NetworkPolicy does not mediate. Note the
 * policy only bites on a CNI that enforces NetworkPolicy (kind's kindnet
 * does); `yaac cluster check` probes enforcement end to end.
 */
export function buildSessionNetworkPolicyManifest(): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: SESSION_NETWORK_POLICY_NAME,
      namespace: k8sNamespace(),
      labels: { app: PROXY_APP_NAME },
    },
    spec: {
      podSelector: {
        matchExpressions: [{ key: LABEL_SESSION_ID, operator: 'Exists' }],
      },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [{ podSelector: { matchLabels: { app: PROXY_APP_NAME } } }],
          ports: [{ protocol: 'TCP', port: PROXY_PORT }],
        },
        {
          to: [{
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
            },
            podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
          }],
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
          ],
        },
      ],
    },
  }
}

export function buildProxyServiceManifest(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: PROXY_APP_NAME,
      namespace: k8sNamespace(),
      labels: { app: PROXY_APP_NAME },
    },
    spec: {
      type: 'ClusterIP',
      selector: { app: PROXY_APP_NAME },
      ports: [{ port: PROXY_PORT, targetPort: PROXY_PORT }],
    },
  }
}

/**
 * Apply the proxy Deployment + Service and wait for the rollout. `kubectl
 * apply` is the drift reconciler: when the proxy image hash changes, the
 * Deployment's pod template changes and kubernetes replaces the pod —
 * the declarative successor to the podman-era hash-in-the-container-name
 * scheme plus manual stale-proxy GC.
 */
export async function ensureProxyResources(imageRef: string): Promise<void> {
  // Pre-create the credentials dir with tight permissions before any pod
  // mounts it — DirectoryOrCreate would make it root-owned 0755.
  await fs.mkdir(credentialsDir(), { recursive: true, mode: 0o700 })
  await fs.mkdir(sshAgentHostDir(), { recursive: true })
  await fs.mkdir(proxyDataHostDir(), { recursive: true })

  await kubectlApply(buildProxyDeploymentManifest(imageRef))
  await kubectlApply(buildProxyServiceManifest())
  // Applied with the proxy resources so the egress lockdown exists before
  // any session pod can be scheduled (sessions require ensureRunning()).
  await kubectlApply(buildSessionNetworkPolicyManifest())
  await kubectlWithRetry([
    'rollout', 'status', `deployment/${PROXY_APP_NAME}`,
    '-n', k8sNamespace(),
    '--timeout=180s',
  ], { timeout: 190_000, maxAttempts: 2 })
}

interface RawConfigMap {
  data?: Record<string, string>
}

/**
 * Upsert the proxy-CA ConfigMap that every session pod mounts. Skips the
 * write when the stored PEM already matches (the common case — the proxy
 * persists its CA in /data and only regenerates when that volume is lost).
 */
export async function ensureCaConfigMap(caPem: string): Promise<void> {
  const existing = await kubectlGetJson<RawConfigMap>([
    'get', 'configmap', CA_CONFIGMAP_NAME, '-n', k8sNamespace(),
  ])
  if (existing?.data?.[CA_CONFIGMAP_KEY] === caPem) return
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: CA_CONFIGMAP_NAME, namespace: k8sNamespace() },
    data: { [CA_CONFIGMAP_KEY]: caPem },
  })
}
