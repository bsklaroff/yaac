import {
  BUILDER_ROLE_GUARD_NAME,
  CA_CONFIGMAP_KEY,
  DNS_STUB_PORT,
  LABEL_DATA_DIR_HASH,
  LABEL_ROLE,
  OUTER_CA_CONFIGMAP_NAME,
  POD_STREAM_PORT,
  PRIORITY_CLASS_INFRA,
  PROXY_APP_NAME,
  PROXY_AUTH_SECRET_NAME,
  PROXY_PORT,
  PROXY_SA_NAME,
  RELAY_PORT,
  ROLE_BUILDER,
  ROLE_INNER_PROXY,
  RUNTIME_CLASS_GVISOR,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_TUNNEL_PORT,
  dataDirHash,
  k8sNamespace,
} from '#platform/k8s'
import { credentialsDir } from '@yaac/shared/project-paths'
import { env } from '@yaac/shared/env'
import { proxyDataHostDir, sshAgentHostDir } from './proxy-apply'

/** Mount dir + file for the projected outer CA inside the inner proxy. A
 * dedicated dir (not the session CA mount) so it never collides with the
 * inner proxy's own CA material. */
const OUTER_CA_MOUNT_DIR = '/etc/yaac/outer-ca'
const OUTER_CA_PATH = `${OUTER_CA_MOUNT_DIR}/${CA_CONFIGMAP_KEY}`

/**
 * Pod securityContext running the proxy as the server's own host uid/gid.
 * The proxy reads/writes hostPath dirs the server creates (the CA in
 * /data, the ssh-agent socket dir, and the 0700 credentials dir);
 * matching the creator's uid is what makes those accessible. The image's
 * default `node` uid (1000) only worked on applehv, whose virtiofs
 * ignored ownership — libkrun's enforces it, so a uid mismatch is EACCES.
 *
 * fsGroup makes the emptyDir-backed HOME (see the deployment) group-
 * writable by the proxy process; it applies only to ownership-managed
 * volumes (emptyDir), never to the hostPath mounts, which stay owned by
 * the host uid. Throws if getuid/getgid are unavailable: the server's
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
      + 'the yaac server requires a POSIX host',
    )
  }
  return { securityContext: { runAsUser: uid, runAsGroup: gid, fsGroup: gid } }
}

/**
 * Build the proxy Deployment manifest. Exported for unit tests; applied
 * by `ensureProxyResources`.
 *
 * Exposure: ClusterIP Service only — no hostNetwork, no hostPort, no
 * NodePort. The proxy listens inside its pod's network namespace; the
 * server reaches it through a loopback exec tunnel (see ExecTunnel —
 * runtime-agnostic, kept even though the runc proxy could also be
 * port-forwarded, so the tunnel doesn't churn with the runtime tier).
 */
export function buildProxyDeploymentManifest(
  imageRef: string,
  opts: { nested?: boolean } = {},
): Record<string, unknown> {
  // Every proxy pod carries the install identity (the same data-dir-hash
  // label session pods carry): tenant pod labels survive vcluster sync
  // verbatim, so the outer projection can group a vcluster's synced pods by
  // owning inner install. Nested (inner) proxy: additionally stamp the role
  // so netd can exclude it from its own claim (loop-free) and both hops can
  // discover it.
  const podLabels = {
    app: PROXY_APP_NAME,
    [LABEL_DATA_DIR_HASH]: dataDirHash(),
    ...(opts.nested ? { [LABEL_ROLE]: ROLE_INNER_PROXY } : {}),
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
      // Recreate, not RollingUpdate: two proxy pods would race over the
      // shared hostPath ssh-agent socket during the overlap window.
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { app: PROXY_APP_NAME } },
      template: {
        metadata: { labels: podLabels },
        spec: {
          // The proxy watches pods (source-IP → session) via the in-cluster
          // API, so it needs its SA token mounted — read-only pods access
          // granted by buildProxyRoleManifest.
          serviceAccountName: PROXY_SA_NAME,
          automountServiceAccountToken: true,
          enableServiceLinks: false,
          // Infra tier: losing the proxy costs every session on the cluster
          // its DNS and its entire route to the world, so it outranks the
          // sessions under node pressure and can preempt one when a full
          // node leaves it nowhere to run.
          priorityClassName: PRIORITY_CLASS_INFRA,
          // No runtimeClassName: the proxy is trusted yaac infra and runs on
          // runc — the sentry buys no containment for yaac-shipped code and
          // its CPU cost starves the node (see the gvisor.ts module doc).
          // The ssh-agent socket on the hostPath dir is then a plain host
          // socket, which sandboxed sessions still dial fine through their
          // own handler's host-uds=all. The inner (nested) proxy is a
          // vcluster tenant pod and equally stamps nothing.
          // Nested (inner) proxy: resolve upstream hostnames via its OWN DNS
          // stub (loopback), not the vcluster CoreDNS. The inner proxy carries
          // `managed-by`, so the outer yaac's fallback redirect catches its
          // egress and default-denies everything but world:443/80 (→ outer
          // proxy) + 53→itself — so a query to the vcluster CoreDNS is dropped
          // (getaddrinfo EAI_AGAIN). Its stub sinkholes every name to the dummy
          // IP; the proxy then dials that, the fallback redirects it to the
          // outer proxy, and the outer proxy resolves+dials the real upstream
          // (SNI-routed). dnsPolicy:None + an explicit nameserver survives
          // vcluster sync (the N3 spike confirmed this). Top-level proxy keeps
          // the cluster default — it reaches the world directly and needs real
          // resolution via cluster CoreDNS.
          ...(opts.nested
            ? { dnsPolicy: 'None', dnsConfig: { nameservers: ['127.0.0.1'] } }
            : {}),
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
                { containerPort: DNS_STUB_PORT, protocol: 'UDP' },
              ],
              env: [
                { name: 'API_PORT', value: String(PROXY_PORT) },
                { name: 'TRANSPARENT_HTTPS_PORT', value: String(TRANSPARENT_HTTPS_PORT) },
                { name: 'TRANSPARENT_HTTP_PORT', value: String(TRANSPARENT_HTTP_PORT) },
                { name: 'TRANSPARENT_TUNNEL_PORT', value: String(TRANSPARENT_TUNNEL_PORT) },
                // Stream relay (docs/stream-relay.md): the authenticated
                // CONNECT into session pods' streamd. Same env for outer and
                // inner proxies — only the addressing differs (NodePort vs
                // pod-IP dial).
                { name: 'RELAY_PORT', value: String(RELAY_PORT) },
                { name: 'POD_STREAM_PORT', value: String(POD_STREAM_PORT) },
                { name: 'DNS_STUB_PORT', value: String(DNS_STUB_PORT) },
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
                // (only public known_hosts) out of the persisted secret
                // dir. Only the proxy's known_hosts writer resolves HOME;
                // ssh-add expands ~ via getpwuid (not $HOME), so the proxy
                // hands it the file explicitly with -H.
                { name: 'HOME', value: '/home/proxy' },
                ...(env.useTor ? [{ name: 'USE_TOR', value: '1' }] : []),
                // Split-horizon DNS: the top-level proxy resolves internal
                // names (`*.svc`) against the cluster CoreDNS so session pods
                // learn live ClusterIPs (no IP pinning). OFF when nested — the
                // inner proxy is firewalled from the vcluster CoreDNS and must
                // sinkhole every name (its upstream dial chains to the outer
                // proxy, which resolves for real).
                ...(opts.nested ? [] : [{ name: 'DNS_FORWARD_INTERNAL', value: '1' }]),
                // Nested (inner) proxy: trust the OUTER proxy's MITM CA so the
                // chained upstream dial (→ outer proxy) validates. Additive —
                // Node still consults its bundled roots. See OUTER_CA_*.
                ...(opts.nested
                  ? [{ name: 'NODE_EXTRA_CA_CERTS', value: OUTER_CA_PATH }]
                  : []),
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
                ...(opts.nested
                  ? [{ name: 'outer-ca', mountPath: OUTER_CA_MOUNT_DIR, readOnly: true }]
                  : []),
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
            // Nested (inner) proxy: the outer CA, projected by the server into
            // the vcluster as a ConfigMap (buildOuterProxyCaConfigMapManifest).
            ...(opts.nested
              ? [{ name: 'outer-ca', configMap: { name: OUTER_CA_CONFIGMAP_NAME } }]
              : []),
          ],
        },
      },
    },
  }
}

/**
 * ConfigMap carrying the OUTER proxy's CA, applied by a nested (inner) yaac
 * into its vcluster so the inner proxy can trust the outer proxy's MITM leaf
 * on its chained upstream hop (see OUTER_CA_CONFIGMAP_NAME). vcluster syncs it
 * to the host because the inner proxy pod mounts it. Pure builder — the caller
 * reads the outer CA (from CA_CERT_PATH, its own trust mount) and applies.
 */
export function buildOuterProxyCaConfigMapManifest(caPem: string): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: OUTER_CA_CONFIGMAP_NAME, namespace: k8sNamespace() },
    data: { [CA_CONFIGMAP_KEY]: caPem },
  }
}

/**
 * Admission guard making `yaac.role=builder` unfakeable: the label is
 * policy-bearing (the world-deny exclusion above), so nothing untrusted
 * may mint it. The only API identities untrusted code can ever hold are
 * ServiceAccounts — session pods carry no token at all, and the one
 * session-reachable pod-create path (a vcluster's syncer materializing
 * virtual pods on the host) authenticates as its SA. The trusted server
 * and operators act as cert users. So: builder-labeled pods must not be
 * created or updated by any ServiceAccount, and must run under the
 * gvisor RuntimeClass (the label describes a sandboxed builder; a runc
 * pod wearing it is a bug or an attack either way). UPDATE is matched so
 * the label can't be patched onto an existing pod after admission.
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
          expression: "!request.userInfo.username.startsWith('system:serviceaccount:')",
          message:
            `the ${LABEL_ROLE}=${ROLE_BUILDER} label is reserved for yaac's `
            + 'server-created builder pods and may not be set by service accounts',
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
 *  every namespace, including vcluster session namespaces. */
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

/** ServiceAccount the proxy runs as so it can watch pods (source-IP→session). */
export function buildProxyServiceAccountManifest(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: PROXY_SA_NAME, namespace: k8sNamespace(), labels: { app: PROXY_APP_NAME } },
  }
}

/** Read-only Role: the proxy lists/watches pods to resolve source IP→session. */
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
      // Allocator-assigned ClusterIP (no longer pinned): session-create reads
      // it live at pod-create (proxyServiceClusterIp) for the pod's dnsConfig.
      // The Service is never deleted/recreated, so its ClusterIP is stable for
      // the cluster's lifetime; the egress redirect is EDS-backed (endpoints,
      // not the VIP) and the DNS policy is identity-based, so neither needs a
      // fixed IP.
      selector: { app: PROXY_APP_NAME },
      // port == targetPort throughout: the NetworkPolicy and the in-pod
      // egress filter list the post-translation (transport) port, so a
      // remap would make policy and Service silently diverge. No relay
      // entry: the server's port-forward (and a nested server's pod-IP
      // dial) target the pod port directly, never a Service port.
      ports: [
        { name: 'proxy', port: PROXY_PORT, targetPort: PROXY_PORT },
        { name: 'transparent-https', port: TRANSPARENT_HTTPS_PORT, targetPort: TRANSPARENT_HTTPS_PORT },
        { name: 'transparent-http', port: TRANSPARENT_HTTP_PORT, targetPort: TRANSPARENT_HTTP_PORT },
        { name: 'transparent-tunnel', port: TRANSPARENT_TUNNEL_PORT, targetPort: TRANSPARENT_TUNNEL_PORT },
        { name: 'dns', port: DNS_STUB_PORT, targetPort: DNS_STUB_PORT, protocol: 'UDP' },
      ],
    },
  }
}
