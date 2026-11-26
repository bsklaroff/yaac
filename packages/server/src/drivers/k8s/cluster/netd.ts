import {
  NETD_APP_NAME,
  NETD_SA_NAME,
  NETD_SITE_PORT,
  NETD_STREAM_PORT,
  POD_STREAM_PORT,
  PROXY_APP_NAME,
  PROXY_AUTH_SECRET_NAME,
  SOCKET_EGRESS_PORT,
  k8sNamespace,
  applyObject,
  socketsNodePath,
  waitForRollout,
} from '#drivers/k8s/substrate'
import { contextHash } from './image-tags'
import { prebuiltRef } from './registry'
import { NETD_DIR } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'
import { mountdImage } from './mountd'
import { apiserverEndpoints, clusterDnsCidrs } from './cluster-cidrs'
import { buildNetdEgressNpManifest, buildNetdIngressNpManifest } from './policy-manifests'

/**
 * `yaac-netd`: the per-node DaemonSet that carries sandbox traffic and
 * keeps the node's memory in hand. Two containers:
 *
 *  - **relay** (Go, `k8s/mountd/cmd/relay`, on the mountd image) binds an
 *    `egress.sock` in each workspace's and builder's socket directory on
 *    its node and hands every connection to the proxy behind a header
 *    naming the sandbox, and takes the server's streams and the site
 *    router's requests into a workspace through its `ingress.sock`
 *    (docs/workspace-egress.md, docs/stream-relay.md).
 *  - **netd** (TypeScript, `k8s/netd`) bounds each pod's swap and kills
 *    the workspace thrashing the node (docs/cluster-setup.md "Memory
 *    pressure").
 */

/** Content-hash tag of the netd image (the k8s/netd build context). */
export async function resolveNetdImageTag(image = 'yaac-netd'): Promise<string> {
  return `${image}:${await contextHash(NETD_DIR)}`
}

/** The netd image's in-cluster ref. Lookup-only; `yaac cluster install`
 *  builds it. */
async function ensureNetdImage(): Promise<string> {
  return prebuiltRef('netd', await resolveNetdImageTag(testEnv.netdImage))
}

function buildNetdServiceAccountManifest(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: NETD_SA_NAME, namespace: k8sNamespace(), labels: { app: NETD_APP_NAME } },
  }
}

/**
 * Read-only access to pods and Services in the install namespace: the
 * sandboxes on a node, whose socket directories the relay binds, and the
 * sites' Services, which name their live releases. `list`/`watch` cannot
 * be limited by name, but that namespace holds only yaac's objects. netd
 * never writes to the API, so a compromised netd cannot change cluster
 * state.
 */
function buildNetdRoleManifest(): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: NETD_SA_NAME, namespace: k8sNamespace(), labels: { app: NETD_APP_NAME } },
    rules: [{
      apiGroups: [''],
      resources: ['pods', 'services'],
      verbs: ['get', 'list', 'watch'],
    }],
  }
}

function buildNetdRoleBindingManifest(): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: NETD_SA_NAME, namespace: k8sNamespace(), labels: { app: NETD_APP_NAME } },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: NETD_SA_NAME },
    subjects: [{ kind: 'ServiceAccount', name: NETD_SA_NAME, namespace: k8sNamespace() }],
  }
}

/**
 * The DaemonSet, off the host network: nothing it does needs the node's
 * network namespace.
 *
 * - The relay runs as root, to bind and remove sockets in directories
 *   kubelet makes, with every capability dropped. It sees this install's
 *   socket root at `/s`: a unix socket's path is capped at 107 bytes,
 *   measured in the binder's own mount namespace, and the node path with a
 *   UUID install key runs past that. Its secret is the proxy auth secret,
 *   which it sends the proxy and checks the server's stream dials against.
 * - netd mounts the host's cgroup tree to write each pod's swap bound and
 *   to kill the workspace thrashing the node. It is mounted outside /sys,
 *   where the runtime's AppArmor profile denies writes.
 * - Ready means the relay's listeners are bound and the socket root is
 *   mounted.
 */
export function buildNetdDaemonSetManifest(netdImage: string, relayImage: string): Record<string, unknown> {
  const cgroupDir = '/host/cgroup'
  const readyFile = '/run/relay/ready'
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: {
      name: NETD_APP_NAME,
      namespace: k8sNamespace(),
      labels: { app: NETD_APP_NAME },
    },
    spec: {
      selector: { matchLabels: { app: NETD_APP_NAME } },
      // One node at a time: a node's streams and sites wait on its pod.
      updateStrategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1 } },
      template: {
        metadata: { labels: { app: NETD_APP_NAME } },
        spec: {
          serviceAccountName: NETD_SA_NAME,
          automountServiceAccountToken: true,
          enableServiceLinks: false,
          // Trusted infra, so runc. Tolerates everything: a node without
          // netd has no sandbox traffic.
          tolerations: [{ operator: 'Exists' }],
          priorityClassName: 'system-node-critical',
          containers: [
            {
              name: 'relay',
              image: relayImage,
              imagePullPolicy: 'IfNotPresent',
              command: [
                '/usr/local/bin/relay',
                '-root', '/s',
                '-node-root', socketsNodePath(),
                '-proxy', `${PROXY_APP_NAME}.${k8sNamespace()}.svc.cluster.local:${String(SOCKET_EGRESS_PORT)}`,
                '-secret-file', '/run/secrets/yaac/secret',
                '-stream-listen', `:${String(NETD_STREAM_PORT)}`,
                '-site-listen', `:${String(NETD_SITE_PORT)}`,
                '-stream-port', String(POD_STREAM_PORT),
                '-ready-file', readyFile,
              ],
              securityContext: { runAsUser: 0, capabilities: { drop: ['ALL'] } },
              env: [
                { name: 'POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
                { name: 'NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
              ],
              ports: [{ containerPort: NETD_STREAM_PORT }, { containerPort: NETD_SITE_PORT }],
              readinessProbe: { exec: { command: ['test', '-f', readyFile] }, periodSeconds: 2 },
              volumeMounts: [
                { name: 'sockets', mountPath: '/s' },
                { name: 'secret', mountPath: '/run/secrets/yaac', readOnly: true },
                { name: 'relay-run', mountPath: '/run/relay' },
              ],
            },
            {
              name: 'netd',
              image: netdImage,
              imagePullPolicy: 'IfNotPresent',
              securityContext: { runAsUser: 0, capabilities: { drop: ['ALL'] } },
              env: [
                { name: 'YAAC_NAMESPACE', value: k8sNamespace() },
                { name: 'NETD_CGROUP_ROOT', value: cgroupDir },
                { name: 'NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
              ],
              volumeMounts: [{ name: 'cgroup', mountPath: cgroupDir }],
            },
          ],
          volumes: [
            { name: 'sockets', hostPath: { path: socketsNodePath(), type: 'DirectoryOrCreate' } },
            { name: 'secret', secret: { secretName: PROXY_AUTH_SECRET_NAME } },
            { name: 'relay-run', emptyDir: {} },
            { name: 'cgroup', hostPath: { path: '/sys/fs/cgroup', type: 'Directory' } },
          ],
        },
      },
    },
  }
}

/** Create or update netd. Called from `ensureProxyResources`, before any
 *  workspace pod is scheduled. */
export async function ensureNetd(): Promise<void> {
  const [netdImage, relayImage, dnsCidrs, apiserver] = await Promise.all([
    ensureNetdImage(), mountdImage(), clusterDnsCidrs(), apiserverEndpoints(),
  ])
  // Its policies before its pods: the namespace's world-deny covers netd,
  // which would otherwise start unable to reach the apiserver or the proxy.
  for (const manifest of [
    buildNetdServiceAccountManifest(),
    buildNetdRoleManifest(),
    buildNetdRoleBindingManifest(),
    buildNetdIngressNpManifest(),
    buildNetdEgressNpManifest(dnsCidrs, apiserver),
    buildNetdDaemonSetManifest(netdImage, relayImage),
  ]) await applyObject(manifest)
  await waitForRollout({
    workload: `daemonset/${NETD_APP_NAME}`,
    namespace: k8sNamespace(),
    timeoutMs: 180_000,
    hint: `Inspect with \`kubectl -n ${k8sNamespace()} get pods -l app=${NETD_APP_NAME} -o wide\` `
      + 'and its relay\'s logs (docs/workspace-egress.md). If no pod exists, an admission or quota refusal is '
      + `in \`kubectl -n ${k8sNamespace()} describe ds/${NETD_APP_NAME}\`.`,
  })
}
