import {
  BUILDER_ROLE_GUARD_NAME,
  DNS_SINKHOLE,
  DNS_STUB_PORT,
  LABEL_INSTALL_ID,
  LABEL_PROJECT_ID,
  LABEL_PROXY_INPUT,
  LABEL_PROXY_OUTPUT,
  LABEL_ROLE,
  LABEL_WORKSPACE_ID,
  POD_STREAM_PORT,
  PRIORITY_CLASS_INFRA,
  PROXY_APP_NAME,
  PROXY_AUTH_SECRET_NAME,
  PROXY_CA_SECRET_NAME,
  PROXY_CREDENTIALS_SECRET_NAME,
  PROXY_OWNER_KEY_PATTERN,
  PROXY_PORT,
  PROXY_PROJECT_SECRETS_PREFIX,
  RUN_SECRETS_PREFIX,
  PROXY_REFRESHED_SECRET_NAME,
  PROXY_REGISTRATION_PREFIX,
  PROXY_SA_NAME,
  PROXY_STATE_CONFIGMAP_NAME,
  RELAY_PORT,
  ROLE_BUILDER,
  RUNTIME_CLASS_GVISOR,
  SERVER_APP_NAME,
  SERVER_MAMA_PORT,
  SITE_ROUTER_APP_NAME,
  SITE_ROUTER_TAILNET_PORT,
  SERVER_MAMA_SERVICE_NAME,
  SERVER_SA_NAME,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_TUNNEL_PORT,
  installId,
  installSecurityContext,
  k8sNamespace,
} from '#drivers/k8s/substrate'
import { env } from '@yaac/shared/env'
import { OMP_PROVIDERS, OPENCODE_PROVIDERS, PI_PROVIDERS, providerApiHost } from '@yaac/shared/tool-providers'
import type { CredentialBundle } from '#drivers/contract'

/**
 * Runs the proxy as the host's uid/gid, like the server
 * (`installSecurityContext`), so the two infra pods share one identity.
 * `fsGroup` makes its emptyDir volumes writable.
 */
function proxyRunAsSecurityContext(): Record<string, unknown> {
  const identity = installSecurityContext()
  return { securityContext: { ...identity, fsGroup: identity.runAsGroup } }
}

/**
 * The proxy Deployment, applied by `ensureProxyResources`. Exposed only via
 * a ClusterIP Service (no hostNetwork, hostPort or NodePort); the server
 * dials it pod-to-pod (docs/server-in-cluster.md).
 */
export function buildProxyDeploymentManifest(imageRef: string): Record<string, unknown> {
  const podLabels = {
    app: PROXY_APP_NAME,
    [LABEL_INSTALL_ID]: installId(),
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
      // Recreate: two overlapping pods would overwrite each other's
      // blocked-host records and captured token refreshes.
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { app: PROXY_APP_NAME } },
      template: {
        metadata: { labels: podLabels },
        spec: {
          // Needs its token to watch pods and inputs and write outputs
          // (buildProxyRoleManifest).
          serviceAccountName: PROXY_SA_NAME,
          automountServiceAccountToken: true,
          enableServiceLinks: false,
          // Every workspace's DNS and egress depend on it.
          priorityClassName: PRIORITY_CLASS_INFRA,
          // Trusted infra: runc, not gVisor (see install/gvisor-runtime.ts).
          ...proxyRunAsSecurityContext(),
          containers: [
            {
              name: 'proxy',
              image: imageRef,
              imagePullPolicy: 'IfNotPresent',
              // Lets the non-root proxy bind udp/53 for the DNS stub.
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
                // Stream relay (docs/stream-relay.md): authenticated CONNECT into
                // workspace pods' streamd.
                { name: 'RELAY_PORT', value: String(RELAY_PORT) },
                { name: 'POD_STREAM_PORT', value: String(POD_STREAM_PORT) },
                { name: 'DNS_STUB_PORT', value: String(DNS_STUB_PORT) },
                { name: 'DNS_SINKHOLE', value: DNS_SINKHOLE },
                // Where in-workspace yaac-mama calls are relayed to.
                {
                  name: 'MAMA_RELAY_URL',
                  value: `http://${SERVER_MAMA_SERVICE_NAME}.${k8sNamespace()}.svc.cluster.local:`
                    + `${String(SERVER_MAMA_PORT)}/api/workspace/mama`,
                },
                // Where requests to a tailnet site go, and the domain whose
                // names are those sites' (docs/workspace-egress.md "Tailnet sites").
                {
                  name: 'SITE_ROUTER',
                  value: `${SITE_ROUTER_APP_NAME}.${k8sNamespace()}.svc.cluster.local:${String(SITE_ROUTER_TAILNET_PORT)}`,
                },
                ...(env.siteDomain !== undefined ? [{ name: 'SITE_DOMAIN', value: env.siteDomain }] : []),
                {
                  name: 'PROXY_AUTH_SECRET',
                  valueFrom: {
                    secretKeyRef: { name: PROXY_AUTH_SECRET_NAME, key: 'secret' },
                  },
                },
                // The host uid may not own /home/node, so HOME is a writable
                // emptyDir.
                { name: 'HOME', value: '/home/proxy' },
                ...(env.useTor ? [{ name: 'USE_TOR', value: '1' }] : []),
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
          // No host mounts: the proxy's state lives in API objects
          // (docs/workspace-egress.md), so a replacement pod restores itself.
          volumes: [
            // Tor's state, rebuilt per pod.
            { name: 'proxy-data', emptyDir: {} },
            // Writable HOME (see above).
            { name: 'home', emptyDir: {} },
          ],
        },
      },
    },
  }
}

/**
 * Admission policy reserving `yaac.role=builder` (the label exempts pods
 * from world-deny egress). Only a yaac server's ServiceAccount
 * (`system:serviceaccount:<any-ns>:yaac-server`) may set it, and its pods
 * must run under gVisor. UPDATE is checked too, so the label cannot be
 * added later.
 *
 * It matches any namespace because the policy has a fixed cluster-wide name
 * and several installs (the real one plus e2e runs) each re-apply it:
 * narrowing it to one install's account would lock the others out, and
 * per-install policies don't work because a request must pass every
 * policy. Untrusted code has no API identity, so it cannot act as such an
 * account.
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

/** The proxy's ServiceAccount. */
export function buildProxyServiceAccountManifest(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: PROXY_SA_NAME, namespace: k8sNamespace(), labels: { app: PROXY_APP_NAME } },
  }
}

/**
 * The proxy's Role: read pods, Secrets and ConfigMaps (namespace-wide, since
 * `list`/`watch` cannot be limited by name), and update only its three
 * output objects. `create` cannot be limited by name either, so the server
 * pre-creates the outputs (`ensureProxyResources`).
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

/** Refuse an owner key the proxy would read differently
 *  (`PROXY_OWNER_KEY_PATTERN`). */
function assertProxyOwnerKey(owner: string): void {
  if (!new RegExp(`^${PROXY_OWNER_KEY_PATTERN}$`).test(owner)) {
    throw new Error(`invalid credential owner key: ${JSON.stringify(owner)}`)
  }
}

/**
 * The credentials Secret: per owner, each signed-in tool's credential file,
 * plus `git-tokens.json` (`[{token, grants}]`) and `ssh-keys.json`
 * (`[{privateKey, publicKey, grants}]`), each grant a `RepoGrant` (an ssh
 * one with its `knownHostsEntry`), each key prefixed `<owner>.`. The opencode, pi and omp files also carry
 * `apiHost`, the provider's host the proxy swaps the key in on (a custom
 * endpoint's own host); a provider with no known host gets no file, so the
 * key goes nowhere. Replaced whole
 * on every push, so a removed key disappears.
 */
export function buildProxyCredentialsSecretManifest(bundles: Record<string, CredentialBundle>): Record<string, unknown> {
  const files: Record<string, string> = {}
  for (const [owner, bundle] of Object.entries(bundles)) {
    assertProxyOwnerKey(owner)
    if (bundle.claude) files[`${owner}.claude.json`] = JSON.stringify(bundle.claude)
    if (bundle.codex) files[`${owner}.codex.json`] = JSON.stringify(bundle.codex)
    for (const [tool, providers] of [['opencode', OPENCODE_PROVIDERS], ['pi', PI_PROVIDERS], ['omp', OMP_PROVIDERS]] as const) {
      const file = bundle[tool]
      const apiHost = file && providerApiHost(providers, file.provider, file.endpoint)
      if (file && apiHost) files[`${owner}.${tool}.json`] = JSON.stringify({ ...file, apiHost })
    }
    files[`${owner}.git-tokens.json`] = JSON.stringify(bundle.git)
    files[`${owner}.ssh-keys.json`] = JSON.stringify(bundle.ssh)
  }
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

/** A project's secret-values Secret name. Project ids are random, so
 *  installs sharing a namespace cannot collide. */
export function proxyProjectSecretsName(projectId: string): string {
  return `${PROXY_PROJECT_SECRETS_PREFIX}-${projectId}`
}

/** One project's decrypted secret values, keyed as its registration's
 *  `secretRef`s name them (`<projectId>/<NAME>`). One object per project. */
export function buildProjectSecretsManifest(
  projectId: string,
  values: Record<string, string>,
): Record<string, unknown> {
  const scoped = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [`${projectId}/${name}`, value]),
  )
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: proxyProjectSecretsName(projectId),
      namespace: k8sNamespace(),
      labels: proxyLabels({ [LABEL_PROXY_INPUT]: 'secrets', [LABEL_PROJECT_ID]: projectId }),
    },
    type: 'Opaque',
    data: secretData({ 'values.json': JSON.stringify(scoped) }),
  }
}

/** A project's run-secrets Secret name. */
export function runSecretsName(projectId: string): string {
  return `${RUN_SECRETS_PREFIX}-${projectId}`
}

/** One project's run secret values, one key per name, which a workspace pod
 *  reads the ones it is given from with `secretKeyRef`. */
export function buildRunSecretsManifest(
  projectId: string,
  values: Record<string, string>,
): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: runSecretsName(projectId),
      namespace: k8sNamespace(),
      labels: { [LABEL_PROJECT_ID]: projectId },
    },
    type: 'Opaque',
    data: secretData(values),
  }
}

/** Name of a workspace's registration ConfigMap (ids are UUIDs, so the
 *  name fits without hashing). */
export function proxyRegistrationName(workspaceId: string): string {
  return `${PROXY_REGISTRATION_PREFIX}-${workspaceId}`
}

/**
 * One workspace's registration (rules with `secretRef`s but no values,
 * allowed hosts, repo URL, project, owner, test redirects). A
 * ConfigMap, since it holds no secrets. Labelled by workspace and project.
 * Refuses a malformed owner, which the proxy would drop the registration
 * for, failing the workspace closed.
 */
export function buildRegistrationConfigMapManifest(
  workspaceId: string,
  projectId: string,
  registration: { owner: string },
): Record<string, unknown> {
  assertProxyOwnerKey(registration.owner)
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: proxyRegistrationName(workspaceId),
      namespace: k8sNamespace(),
      labels: proxyLabels({
        [LABEL_PROXY_INPUT]: 'registration',
        [LABEL_WORKSPACE_ID]: workspaceId,
        [LABEL_PROJECT_ID]: projectId,
      }),
    },
    data: { 'registration.json': JSON.stringify(registration) },
  }
}

/** The three objects the proxy writes, pre-created empty by the server
 *  (see `buildProxyRoleManifest`). */
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
      // The ClusterIP is read at workspace create for the pod's DNS
      // (proxyServiceClusterIp); it is stable because the Service is never
      // recreated.
      selector: { app: PROXY_APP_NAME },
      // port == targetPort: policies name the pod port, so a remap would
      // silently diverge.
      ports: [
        { name: 'proxy', port: PROXY_PORT, targetPort: PROXY_PORT },
        // The relay, which the in-cluster server dials via the Service.
        { name: 'relay', port: RELAY_PORT, targetPort: RELAY_PORT },
        { name: 'transparent-https', port: TRANSPARENT_HTTPS_PORT, targetPort: TRANSPARENT_HTTPS_PORT },
        { name: 'transparent-http', port: TRANSPARENT_HTTP_PORT, targetPort: TRANSPARENT_HTTP_PORT },
        { name: 'transparent-tunnel', port: TRANSPARENT_TUNNEL_PORT, targetPort: TRANSPARENT_TUNNEL_PORT },
        { name: 'dns', port: DNS_STUB_PORT, targetPort: DNS_STUB_PORT, protocol: 'UDP' },
      ],
    },
  }
}

/**
 * The Service the proxy relays yaac-mama calls to: the server pod's mama-only
 * listener. Applied with the proxy, its only client.
 */
export function buildServerMamaServiceManifest(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: SERVER_MAMA_SERVICE_NAME,
      namespace: k8sNamespace(),
      labels: { app: SERVER_APP_NAME },
    },
    spec: {
      type: 'ClusterIP',
      selector: { app: SERVER_APP_NAME },
      ports: [{ name: 'mama', port: SERVER_MAMA_PORT, targetPort: SERVER_MAMA_PORT }],
    },
  }
}
