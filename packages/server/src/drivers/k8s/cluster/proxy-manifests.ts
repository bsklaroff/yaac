import crypto from 'node:crypto'
import {
  BUILDER_ROLE_GUARD_NAME,
  DNS_STUB_PORT,
  LABEL_DATA_DIR_HASH,
  LABEL_PROJECT,
  LABEL_PROXY_INPUT,
  LABEL_PROXY_OUTPUT,
  LABEL_ROLE,
  LABEL_WORKTREE_ID,
  POD_STREAM_PORT,
  PRIORITY_CLASS_INFRA,
  PROXY_APP_NAME,
  PROXY_AUTH_SECRET_NAME,
  PROXY_CA_SECRET_NAME,
  PROXY_CREDENTIALS_SECRET_NAME,
  PROXY_PORT,
  PROXY_PROJECT_SECRETS_PREFIX,
  PROXY_REFRESHED_SECRET_NAME,
  PROXY_REGISTRATION_PREFIX,
  PROXY_SA_NAME,
  PROXY_STATE_CONFIGMAP_NAME,
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
import { env } from '@yaac/shared/env'
import type { CredentialBundle } from '#drivers/contract'

/**
 * Pod securityContext running the proxy as the host's own uid/gid — see
 * `hostUidSecurityContext`, which the server's Deployment shares.
 *
 * The proxy mounts nothing from the host, so no path it touches is owned
 * by anyone in particular; it keeps the server's identity so that the two
 * infra pods read as one principal wherever a uid shows (process listings,
 * the relay's peer checks). The image's default `node` uid (1000) is not
 * assumed either way.
 *
 * `fsGroup` on top of that shared identity, as on the server's Deployment
 * and for the same reason: both of the proxy's volumes are emptyDirs (see
 * the deployment), and emptyDir is the one volume kind whose ownership the
 * kubelet manages.
 */
export function proxyRunAsSecurityContext(): Record<string, unknown> {
  const identity = hostUidSecurityContext()
  return { securityContext: { ...identity, fsGroup: identity.runAsGroup } }
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
      // Recreate, not RollingUpdate: the transparent listeners are
      // addressed by the Service, and an overlap window would split one
      // worktree's connections across two pods whose blocked-host records
      // and captured rotations would each overwrite the other's.
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { app: PROXY_APP_NAME } },
      template: {
        metadata: { labels: podLabels },
        spec: {
          // The proxy watches pods (source-IP → worktree) and its input
          // objects via the in-cluster API, and writes its three outputs
          // there, so it needs its SA token mounted — the access is
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
                // point HOME at a dedicated emptyDir (writable via fsGroup).
                // The entrypoint's ssh-agent socket and the proxy's
                // known_hosts writer both resolve HOME; ssh-add expands ~
                // via getpwuid (not $HOME), so the proxy hands it the file
                // explicitly with -H.
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
                { name: 'proxy-data', mountPath: '/data' },
                { name: 'home', mountPath: '/home/proxy' },
              ],
            },
          ],
          // Nothing from the host: the proxy is stateless. Its inputs are
          // objects it watches and its outputs objects it writes
          // (docs/worktree-egress.md), so a pod replacement — anywhere in
          // the cluster — restores itself from the apiserver alone.
          volumes: [
            // Tor's state and readiness marker, per pod: a circuit is
            // re-bootstrapped on every replacement.
            { name: 'proxy-data', emptyDir: {} },
            // Writable HOME for the proxy's ssh-agent socket, ssh-add and
            // known_hosts. emptyDir so fsGroup can make it group-writable
            // by the non-root proxy uid. The agent socket is pod-local:
            // worktree pods reach the agent over SSH_AGENT_PORT.
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

/**
 * The proxy's Role: pods, Secrets and ConfigMaps readable (it watches its
 * inputs), and exactly its three output objects writable.
 *
 * `list` and `watch` cannot be name-scoped, so the read grant is
 * namespace-wide; the install namespace holds nothing but yaac's own
 * objects (the proxy already carries `yaac-proxy-auth` in its env), and
 * the proxy already holds every value in memory. `create` cannot be
 * name-scoped either, which is why the outputs are pre-created by the
 * server (`ensureProxyResources`) and the proxy only ever `update`s and
 * `patch`es them.
 */
export function buildProxyRoleManifest(): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: PROXY_SA_NAME, namespace: k8sNamespace(), labels: { app: PROXY_APP_NAME } },
    rules: [
      { apiGroups: [''], resources: ['pods', 'secrets', 'configmaps'], verbs: ['get', 'list', 'watch'] },
      {
        apiGroups: [''],
        resources: ['secrets'],
        resourceNames: [PROXY_REFRESHED_SECRET_NAME, PROXY_CA_SECRET_NAME],
        verbs: ['update', 'patch'],
      },
      {
        apiGroups: [''],
        resources: ['configmaps'],
        resourceNames: [PROXY_STATE_CONFIGMAP_NAME],
        verbs: ['update', 'patch'],
      },
    ],
  }
}

// ── The objects the proxy is told through ─────────────────────────────

const proxyLabels = (extra: Record<string, string>): Record<string, string> =>
  ({ app: PROXY_APP_NAME, ...extra })

function secretData(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([k, v]) => [k, Buffer.from(v, 'utf8').toString('base64')]),
  )
}

/**
 * The credentials Secret: every host-store file verbatim (a signed-out
 * tool contributes no key, which the proxy reads as signed out) plus the
 * ssh keys the agent is loaded from. Replaced whole on every push — the
 * set is one install-wide thing, and a key's absence is as much a fact as
 * its presence.
 */
export function buildProxyCredentialsSecretManifest(bundle: CredentialBundle): Record<string, unknown> {
  const files: Record<string, string> = {}
  for (const tool of ['claude', 'codex', 'opencode', 'pi'] as const) {
    const file = bundle[tool]
    if (file) files[`${tool}.json`] = JSON.stringify(file)
  }
  files['github.json'] = JSON.stringify({ tokens: bundle.git })
  files['ssh-keys.json'] = JSON.stringify(bundle.ssh)
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: PROXY_CREDENTIALS_SECRET_NAME,
      namespace: k8sNamespace(),
      labels: proxyLabels({ [LABEL_PROXY_INPUT]: 'credentials' }),
    },
    type: 'Opaque',
    data: secretData(files),
  }
}

/**
 * Name of a project's secret-values Secret: `yaac-proxy-secrets-<safeSlug
 * ≤21>-<hash8>`, the shape the per-project registry uses and for the same
 * reasons — a slug is not DNS-safe, and the hash spans the data dir so
 * installs sharing a namespace cannot collide.
 */
export function proxyProjectSecretsName(projectSlug: string): string {
  return installScopedName(PROXY_PROJECT_SECRETS_PREFIX, projectSlug)
}

export function installScopedName(prefix: string, projectSlug: string): string {
  const safeSlug = projectSlug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 21)
  const hash8 = crypto.createHash('sha256')
    .update(`${dataDirHash()}/${projectSlug}`)
    .digest('hex')
    .slice(0, 8)
  return `${prefix}-${safeSlug}-${hash8}`.replace(/--+/g, '-')
}

/**
 * One project's opened secret values, keyed the way its registration's
 * `secretRef`s name them (`<slug>/<NAME>`). One object per project because
 * values are edited per project and opened by decryption — re-rendering
 * every project's values to change one is work with nothing behind it.
 */
export function buildProjectSecretsManifest(
  projectSlug: string,
  values: Record<string, string>,
): Record<string, unknown> {
  const scoped = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [`${projectSlug}/${name}`, value]),
  )
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: proxyProjectSecretsName(projectSlug),
      namespace: k8sNamespace(),
      labels: proxyLabels({ [LABEL_PROXY_INPUT]: 'secrets', [LABEL_PROJECT]: projectSlug }),
    },
    type: 'Opaque',
    data: secretData({ 'values.json': JSON.stringify(scoped) }),
  }
}

/** Name of a worktree's registration ConfigMap (ids are UUIDs, so the
 *  name fits without hashing). */
export function proxyRegistrationName(worktreeId: string): string {
  return `${PROXY_REGISTRATION_PREFIX}-${worktreeId}`
}

/**
 * One worktree's registration: rules (with `secretRef`s, never values),
 * allowed hosts, repo URL, tool, project and test redirects — a ConfigMap
 * precisely because it carries no secret. Labelled with its worktree and
 * project so the proxy indexes it by worktree and a fan-out finds a
 * project's set.
 */
export function buildRegistrationConfigMapManifest(
  worktreeId: string,
  projectSlug: string,
  registration: object,
): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: proxyRegistrationName(worktreeId),
      namespace: k8sNamespace(),
      labels: proxyLabels({
        [LABEL_PROXY_INPUT]: 'registration',
        [LABEL_WORKTREE_ID]: worktreeId,
        [LABEL_PROJECT]: projectSlug,
      }),
    },
    data: { 'registration.json': JSON.stringify(registration) },
  }
}

/**
 * The three objects the proxy writes, created empty by the server so the
 * proxy's Role can name them (see `buildProxyRoleManifest`). Applied only
 * when absent — an apply of the empty shape onto a live one would wipe
 * what the proxy wrote.
 */
export function buildProxyOutputManifests(): Array<Record<string, unknown>> {
  const output = (kind: string): Record<string, string> =>
    proxyLabels({ [LABEL_PROXY_OUTPUT]: kind })
  return [
    {
      apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
      metadata: { name: PROXY_REFRESHED_SECRET_NAME, namespace: k8sNamespace(), labels: output('refreshed') },
    },
    {
      apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
      metadata: { name: PROXY_CA_SECRET_NAME, namespace: k8sNamespace(), labels: output('ca') },
    },
    {
      apiVersion: 'v1', kind: 'ConfigMap',
      metadata: { name: PROXY_STATE_CONFIGMAP_NAME, namespace: k8sNamespace(), labels: output('state') },
    },
  ]
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
