import {
  BUILDER_ROLE_GUARD_NAME,
  DNS_STUB_PORT,
  LABEL_DATA_DIR_HASH,
  LABEL_ROLE,
  POD_STREAM_PORT,
  PRIORITY_CLASS_INFRA,
  PROXY_APP_NAME,
  PROXY_AUTH_SECRET_NAME,
  PROXY_PORT,
  PROXY_SA_NAME,
  RELAY_PORT,
  ROLE_BUILDER,
  RUNTIME_CLASS_GVISOR,
  SERVER_SA_NAME,
  SSH_AGENT_PORT,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_TUNNEL_PORT,
  dataDirHash,
  hostUidSecurityContext,
  k8sNamespace,
} from '#drivers/k8s/substrate'
import { credentialsDir } from '@yaac/shared/project-paths'
import { env } from '@yaac/shared/env'
import { proxyDataHostDir } from '@yaac/shared/project-paths'

/**
 * Pod securityContext running the proxy as the host's own uid/gid — see
 * `hostUidSecurityContext`, which the server's Deployment shares.
 *
 * The proxy reads and writes hostPath dirs the server creates (the CA in
 * /data and the 0700 credentials dir), so it has to be the same identity
 * the server is. The image's default `node` uid (1000) only worked on
 * applehv, whose virtiofs ignored ownership — libkrun's enforces it, so a
 * uid mismatch is EACCES. Its `fsGroup` half is load-bearing here in a way
 * it is not for the server: the proxy's HOME is an emptyDir (see the
 * deployment), and emptyDir is ownership-managed.
 */
export function proxyRunAsSecurityContext(): Record<string, unknown> {
  return { securityContext: hostUidSecurityContext() }
}

/**
 * Build the proxy Deployment manifest. Exported for unit tests; applied
 * by `ensureProxyResources`.
 *
 * Exposure: ClusterIP Service only — no hostNetwork, no hostPort, no
 * NodePort. The proxy listens inside its pod's network namespace, and the
 * server reaches it there as an ordinary pod-to-pod Service dial: it is a
 * pod of the same namespace (docs/server-in-cluster.md), and this Service
 * is the only address it needs. Nothing off the pod network can reach it,
 * which is why the control and relay ports carry no auth-by-address
 * assumption beyond the ingress policy in policy-manifests.ts.
 */
export function buildProxyDeploymentManifest(imageRef: string): Record<string, unknown> {
  // Every proxy pod carries the install identity — the same data-dir-hash
  // label worktree pods carry.
  const podLabels = {
    app: PROXY_APP_NAME,
    [LABEL_DATA_DIR_HASH]: dataDirHash(),
  }
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
      // Recreate, not RollingUpdate: proxy state that is memory-only by
      // design (the ssh-agent's identities) lives in whichever pod the
      // Service happens to pick, so an overlap window would hand some
      // worktrees an agent the server has not loaded keys into.
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { app: PROXY_APP_NAME } },
      template: {
        metadata: { labels: podLabels },
        spec: {
          // The proxy watches pods (source-IP → worktree) via the in-cluster
          // API, so it needs its SA token mounted — read-only pods access
          // granted by buildProxyRoleManifest.
          serviceAccountName: PROXY_SA_NAME,
          automountServiceAccountToken: true,
          enableServiceLinks: false,
          // Infra tier: losing the proxy costs every worktree on the cluster
          // its DNS and its entire route to the world, so it outranks the
          // worktrees under node pressure and can preempt one when a full
          // node leaves it nowhere to run.
          priorityClassName: PRIORITY_CLASS_INFRA,
          // No runtimeClassName: the proxy is trusted yaac infra and runs on
          // runc — the sentry buys no containment for yaac-shipped code and
          // its CPU cost starves the node (see the gvisor.ts module doc).
          ...proxyRunAsSecurityContext(),
          containers: [
            {
              name: 'proxy',
              image: imageRef,
              imagePullPolicy: 'IfNotPresent',
              // NET_BIND_SERVICE lets the non-root proxy bind udp/53 for the
              // DNS stub, keeping the Service's port==targetPort invariant
              // (no remap, so policy and Service agree on the port).
              securityContext: { capabilities: { add: ['NET_BIND_SERVICE'] } },
              ports: [
                { containerPort: PROXY_PORT },
                { containerPort: TRANSPARENT_HTTPS_PORT },
                { containerPort: TRANSPARENT_HTTP_PORT },
                { containerPort: TRANSPARENT_TUNNEL_PORT },
                { containerPort: RELAY_PORT },
                { containerPort: SSH_AGENT_PORT },
                { containerPort: DNS_STUB_PORT, protocol: 'UDP' },
              ],
              env: [
                { name: 'API_PORT', value: String(PROXY_PORT) },
                { name: 'TRANSPARENT_HTTPS_PORT', value: String(TRANSPARENT_HTTPS_PORT) },
                { name: 'TRANSPARENT_HTTP_PORT', value: String(TRANSPARENT_HTTP_PORT) },
                { name: 'TRANSPARENT_TUNNEL_PORT', value: String(TRANSPARENT_TUNNEL_PORT) },
                // Stream relay (docs/stream-relay.md): the authenticated
                // CONNECT into worktree pods' streamd. Same env for outer and
                // inner proxies — only the addressing differs (NodePort vs
                // pod-IP dial).
                { name: 'RELAY_PORT', value: String(RELAY_PORT) },
                { name: 'POD_STREAM_PORT', value: String(POD_STREAM_PORT) },
                { name: 'DNS_STUB_PORT', value: String(DNS_STUB_PORT) },
                // ssh-agent forwarding: the proxy splices this port to its
                // own in-memory agent for entitled worktree pods, which
                // re-expose it as SSH_AUTH_SOCK's UNIX socket in-pod.
                { name: 'SSH_AGENT_PORT', value: String(SSH_AGENT_PORT) },
                {
                  name: 'PROXY_AUTH_SECRET',
                  valueFrom: {
                    secretKeyRef: { name: PROXY_AUTH_SECRET_NAME, key: 'secret' },
                  },
                },
                // The proxy runs as the server's host uid (runAsUser
                // below), which need not own the image's /home/node — so
                // point HOME at a dedicated emptyDir (writable via fsGroup)
                // rather than the CA-bearing /data, keeping ssh material
                // (the agent socket and the public known_hosts) out of the
                // persisted secret dir. The entrypoint's ssh-agent socket
                // and the proxy's known_hosts writer both resolve HOME;
                // ssh-add expands ~ via getpwuid (not $HOME), so the proxy
                // hands it the file explicitly with -H.
                { name: 'HOME', value: '/home/proxy' },
                ...(env.useTor ? [{ name: 'USE_TOR', value: '1' }] : []),
                // Split-horizon DNS: the proxy resolves internal names
                // (`*.svc`) against the cluster CoreDNS so worktree pods
                // learn live ClusterIPs (no IP pinning).
                { name: 'DNS_FORWARD_INTERNAL', value: '1' },
              ],
              readinessProbe: {
                httpGet: { path: '/healthz', port: PROXY_PORT },
                periodSeconds: 2,
                failureThreshold: 30,
              },
              volumeMounts: [
                { name: 'credentials', mountPath: '/yaac-credentials' },
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
              name: 'proxy-data',
              hostPath: { path: proxyDataHostDir(), type: 'DirectoryOrCreate' },
            },
            // Writable HOME for the proxy's ssh-agent socket, ssh-add and
            // known_hosts. emptyDir (not hostPath) so fsGroup can make it
            // group-writable by the non-root proxy uid, and so nothing the
            // proxy writes under HOME persists onto the host. The agent
            // socket is pod-local now that worktree pods reach the agent
            // over SSH_AGENT_PORT instead of a shared host directory.
            { name: 'home', emptyDir: {} },
          ],
        },
      },
    },
  }
}

/**
 * Admission guard making `yaac.role=builder` unfakeable: the label is
 * policy-bearing (the world-deny exclusion above), so nothing untrusted
 * may mint it. Builder pods are created by exactly one kind of identity —
 * a yaac server, which runs in-cluster as the `SERVER_SA_NAME`
 * ServiceAccount of its install namespace — so the guard admits that
 * username shape (`system:serviceaccount:<any-ns>:yaac-server`) and denies
 * every other identity, whether another ServiceAccount (the identity class
 * untrusted code can hold; worktree pods carry no token at all) or a cert
 * user such as a cluster operator.
 *
 * The shape, deliberately not one install's exact username: this policy is
 * cluster-scoped under a FIXED name, and one cluster hosts more than one
 * install (the real `yaac` one plus an ephemeral `yaac-test-<run-id>` per
 * e2e file — the same reason `serverClusterScopedName()` suffixes the
 * server's RBAC). Every install re-applies the guard, so its text must be
 * install-agnostic or the last applier locks everyone else's server out.
 * Suffixing the policy name instead would not compose either: VAP
 * validations AND together, so two policies each naming a different server
 * would deny both. Admitting the shape costs nothing under the threat
 * model — untrusted code holds no API identity at all, so it can neither
 * act as nor create a `yaac-server` ServiceAccount in any namespace.
 *
 * Carriers must also run under the gvisor RuntimeClass (the label
 * describes a sandboxed builder; a runc pod wearing it is a bug or an
 * attack either way). UPDATE is matched so the label can't be patched onto
 * an existing pod after admission.
 */
export function buildBuilderRoleGuardPolicyManifest(): Record<string, unknown> {
  return {
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingAdmissionPolicy',
    metadata: { name: BUILDER_ROLE_GUARD_NAME },
    spec: {
      failurePolicy: 'Fail',
      matchConstraints: {
        resourceRules: [{
          apiGroups: [''],
          apiVersions: ['v1'],
          operations: ['CREATE', 'UPDATE'],
          resources: ['pods'],
        }],
      },
      matchConditions: [{
        name: 'carries-builder-role',
        expression:
          `has(object.metadata.labels) && '${LABEL_ROLE}' in object.metadata.labels `
          + `&& object.metadata.labels['${LABEL_ROLE}'] == '${ROLE_BUILDER}'`,
      }],
      validations: [
        {
          expression:
            "request.userInfo.username.startsWith('system:serviceaccount:') "
            + `&& request.userInfo.username.endsWith(':${SERVER_SA_NAME}')`,
          message:
            `the ${LABEL_ROLE}=${ROLE_BUILDER} label is reserved for yaac's `
            + 'server-created builder pods and may not be set by any other identity',
        },
        {
          expression:
            'has(object.spec.runtimeClassName) '
            + `&& object.spec.runtimeClassName == '${RUNTIME_CLASS_GVISOR}'`,
          message: `${LABEL_ROLE}=${ROLE_BUILDER} pods must run under the `
            + `${RUNTIME_CLASS_GVISOR} RuntimeClass`,
        },
      ],
    },
  }
}

/** Cluster-wide binding (no matchResources): the label is reserved in
 *  every namespace. */
export function buildBuilderRoleGuardBindingManifest(): Record<string, unknown> {
  return {
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingAdmissionPolicyBinding',
    metadata: { name: BUILDER_ROLE_GUARD_NAME },
    spec: {
      policyName: BUILDER_ROLE_GUARD_NAME,
      validationActions: ['Deny'],
    },
  }
}

/** ServiceAccount the proxy runs as so it can watch pods (source-IP→worktree). */
export function buildProxyServiceAccountManifest(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: PROXY_SA_NAME, namespace: k8sNamespace(), labels: { app: PROXY_APP_NAME } },
  }
}

/** Read-only Role: the proxy lists/watches pods to resolve source IP→worktree. */
export function buildProxyRoleManifest(): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: PROXY_SA_NAME, namespace: k8sNamespace(), labels: { app: PROXY_APP_NAME } },
    rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] }],
  }
}

export function buildProxyRoleBindingManifest(): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: PROXY_SA_NAME, namespace: k8sNamespace(), labels: { app: PROXY_APP_NAME } },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: PROXY_SA_NAME },
    subjects: [{ kind: 'ServiceAccount', name: PROXY_SA_NAME, namespace: k8sNamespace() }],
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
      // Allocator-assigned ClusterIP (no longer pinned): worktree-create reads
      // it live at pod-create (proxyServiceClusterIp) for the pod's dnsConfig.
      // The Service is never deleted/recreated, so its ClusterIP is stable for
      // the cluster's lifetime; the egress redirect is EDS-backed (endpoints,
      // not the VIP) and the DNS policy is identity-based, so neither needs a
      // fixed IP.
      selector: { app: PROXY_APP_NAME },
      // port == targetPort throughout: the NetworkPolicy and the in-pod
      // egress filter list the post-translation (transport) port, so a
      // remap would make policy and Service silently diverge.
      ports: [
        { name: 'proxy', port: PROXY_PORT, targetPort: PROXY_PORT },
        // The relay, for the in-cluster server: it has a route to this
        // Service and none to a host port-forward, so YAAC_RELAY_ADDR names
        // the Service and the dial follows the proxy pod across a
        // reschedule. A host-side server still forwards to the pod port
        // directly and never reads this entry.
        { name: 'relay', port: RELAY_PORT, targetPort: RELAY_PORT },
        { name: 'transparent-https', port: TRANSPARENT_HTTPS_PORT, targetPort: TRANSPARENT_HTTPS_PORT },
        { name: 'transparent-http', port: TRANSPARENT_HTTP_PORT, targetPort: TRANSPARENT_HTTP_PORT },
        { name: 'transparent-tunnel', port: TRANSPARENT_TUNNEL_PORT, targetPort: TRANSPARENT_TUNNEL_PORT },
        // ssh-agent forwarding: worktree pods dial this on the Service
        // ClusterIP (the address they already carry as their resolver), so
        // the agent moves with the proxy pod, node and all.
        { name: 'ssh-agent', port: SSH_AGENT_PORT, targetPort: SSH_AGENT_PORT },
        { name: 'dns', port: DNS_STUB_PORT, targetPort: DNS_STUB_PORT, protocol: 'UDP' },
      ],
    },
  }
}
