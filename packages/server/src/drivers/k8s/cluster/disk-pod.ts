import {
  DISK_APP_NAME,
  DISK_PORT,
  LABEL_INSTALL_ID,
  LABEL_ROLE,
  PRIORITY_CLASS_INFRA,
  ROLE_SERVER,
  installId,
  k8sNamespace,
  nodeLocalNodePath,
} from '#drivers/k8s/substrate'

/**
 * The per-node disk pod (docs/node-local-workspaces.md "A full node"):
 * a DaemonSet running `yaac-disk` (disk-probe.ts) from the server image on
 * every node, workspace nodes included. It answers the server, and nothing
 * else may dial it, with the free space of the node's node-local root and
 * the size of each workspace tree there. It runs as root with only
 * `DAC_READ_SEARCH`, so it can measure folders an agent's `sudo` hid, and
 * mounts only the root, read-only; it runs no workspace's code. Its egress is
 * denied by the namespace's `yaac-egress-world-deny`.
 */

/** Where the program is in the server image, whose build context is the
 *  bundle (`dist/` in a source checkout). */
const DISK_PROGRAM = '/opt/yaac/yaac-disk.mjs'

const labels = (): Record<string, string> => ({ app: DISK_APP_NAME, [LABEL_INSTALL_ID]: installId() })

export function buildDiskDaemonSetManifest(serverImage: string): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: { name: DISK_APP_NAME, namespace: k8sNamespace(), labels: labels() },
    spec: {
      selector: { matchLabels: labels() },
      updateStrategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: '100%' } },
      template: {
        metadata: { labels: labels() },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          priorityClassName: PRIORITY_CLASS_INFRA,
          tolerations: [{ operator: 'Exists' }],
          containers: [{
            name: 'disk',
            image: serverImage,
            imagePullPolicy: 'IfNotPresent',
            command: ['node', DISK_PROGRAM, '--root', '/node-local', '--port', String(DISK_PORT)],
            ports: [{ name: 'disk', containerPort: DISK_PORT }],
            securityContext: {
              runAsUser: 0,
              runAsGroup: 0,
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ['ALL'], add: ['DAC_READ_SEARCH'] },
            },
            resources: {
              requests: { cpu: '10m', memory: '32Mi' },
              limits: { cpu: '500m', memory: '128Mi' },
            },
            volumeMounts: [{ name: 'node-local', mountPath: '/node-local', readOnly: true }],
          }],
          volumes: [{ name: 'node-local', hostPath: { path: nodeLocalNodePath(), type: 'DirectoryOrCreate' } }],
        },
      },
    },
  }
}

/** Only the server may dial a disk pod. */
export function buildDiskIngressNpManifest(): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: `${DISK_APP_NAME}-ingress`, namespace: k8sNamespace(), labels: { app: DISK_APP_NAME } },
    spec: {
      podSelector: { matchLabels: { app: DISK_APP_NAME } },
      policyTypes: ['Ingress'],
      ingress: [{
        from: [{ podSelector: { matchLabels: { [LABEL_ROLE]: ROLE_SERVER } } }],
        ports: [{ protocol: 'TCP', port: DISK_PORT }],
      }],
    },
  }
}
