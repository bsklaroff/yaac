import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import crypto from 'node:crypto'
import { requireCluster, useTestNamespace, TEST_IMAGE_PREFIX } from '@yaac/test-utils/setup'
import { requirePodman } from '#support/cluster'
import { ensureBuilderRoleGuard, ensureNamespace } from '@yaac/server/drivers/k8s/cluster/proxy-apply'
import {
  BUILDER_ROLE_GUARD_NAME,
  SERVER_SA_NAME,
} from '@yaac/server/drivers/k8s/substrate/proxy-constants'
import {
  REGISTRY_NAMESPACE,
  REGISTRY_SERVICE_NAME,
  registryEndpoint,
  registryHost,
  registryPodEndpoint,
  registryPodHost,
  registryReachable,
  mirrorMatchesRecord,
  registryRef,
  registryTagState,
} from '@yaac/server/drivers/k8s/cluster/registry'
import { UTILITY_MIRROR_TAG } from '@yaac/server/drivers/k8s/cluster/utility-image'
import { registryGrant } from '@yaac/server/drivers/k8s/cluster/registry-grant'
import { LABEL_REGISTRY_SERVES, MAIN_REGISTRY_APP_LABEL } from '@yaac/server/drivers/k8s/cluster/main-registry'
import { RUNTIME_CLASS_GVISOR } from '@yaac/server/drivers/k8s/substrate/pod-spec'
import { applyObject, deleteObject, k8sNamespace, readObject } from '@yaac/server/drivers/k8s/substrate/api'
import { kubectl } from '@yaac/test-utils/kubectl'
import {
  buildServerClusterRoleBindingManifest,
  buildServerClusterRoleManifest,
  buildServerServiceAccountManifest,
} from '@yaac/server/drivers/k8s/install/server-deploy'

/**
 * Image builds on the cluster (docs/image-builds.md): the main registry and
 * its two gated listeners, and the guard that reserves the builder role,
 * in-process against this run's namespace. No server runs here, so the
 * file runs beside a server-backed one. The builds themselves, in gVisor
 * builder pods (the step cache across pods, the source policy, refused
 * hosts), run in image-cli.test.ts, on builds its commands start anyway.
 */

let restoreNamespace: (() => void) | null = null

function serverUsername(): string {
  return `system:serviceaccount:${k8sNamespace()}:${SERVER_SA_NAME}`
}

describe('image builds', () => {
  beforeAll(async () => {
    await requirePodman()
    await requireCluster()
    // The image chain names its repos by this prefix, as the e2e servers do.
    vi.stubEnv('YAAC_IMAGE_PREFIX', TEST_IMAGE_PREFIX)
    restoreNamespace = useTestNamespace()
    // `useTestNamespace` only sets the name; the server's bootstrap would
    // normally create it.
    await ensureNamespace()
    // The server's SA and RBAC, as `deployTestServer` applies them, for the
    // guard's admitted identity. The cluster-scoped objects are swept by
    // cluster-setup's afterAll.
    await applyObject(buildServerServiceAccountManifest())
    await applyObject(buildServerClusterRoleManifest())
    await applyObject(buildServerClusterRoleBindingManifest())
  })

  afterAll(async () => {
    await deleteObject({ apiVersion: 'v1', kind: 'Namespace', name: k8sNamespace() }).catch(() => {})
    restoreNamespace?.()
    restoreNamespace = null
    vi.unstubAllEnvs()
  })

  /* Reads the install's registry rather than ensuring it: an ensure from
   * here would re-apply the shared Deployment with this run's install id,
   * pointing it at an empty volume. */
  it('serves the registry in-cluster behind a selector-backed Service', async () => {
    // Pods pull by the registry Service's FQDN in its shared namespace,
    // not this run's.
    expect(registryHost())
      .toBe(`${REGISTRY_SERVICE_NAME}.${REGISTRY_NAMESPACE}.svc.cluster.local:5000`)

    const svc = await readObject<{ spec: { selector?: Record<string, string>; clusterIP?: string } }>({
      apiVersion: 'v1', kind: 'Service', name: REGISTRY_SERVICE_NAME, namespace: REGISTRY_NAMESPACE,
    })
    // Only the serving pod: the one-shot writer pods share its app label.
    expect(svc?.spec.selector).toEqual({ app: MAIN_REGISTRY_APP_LABEL, [LABEL_REGISTRY_SERVES]: 'true' })
    expect(svc?.spec.clusterIP).toBeTruthy()

    const deploy = await readObject<{ status?: { readyReplicas?: number } }>({
      apiVersion: 'apps/v1', kind: 'Deployment', name: REGISTRY_SERVICE_NAME, namespace: REGISTRY_NAMESPACE,
    })
    expect(deploy?.status?.readyReplicas).toBeGreaterThan(0)
    await vi.waitFor(async () => { expect(await registryReachable()).toBe(true) }, { timeout: 60_000, interval: 2_000 })
  }, 120_000)

  it('gates every registry write on a signed grant for the repo it writes', async () => {
    // Repos for project ids no project holds, so registry GC reclaims them.
    const [idA, idB] = [crypto.randomUUID(), crypto.randomUUID()]
    const base = `http://${await registryEndpoint()}`
    const basic = (password: string): string =>
      `Basic ${Buffer.from(`yaac:${password}`).toString('base64')}`
    const grantA = basic(await registryGrant([`yaac-user-${idA}`], 600))
    const startUpload = async (repo: string, authorization?: string): Promise<Response> =>
      fetch(`${base}/v2/${repo}/blobs/uploads/`, {
        method: 'POST',
        headers: authorization ? { authorization } : {},
      })

    // Reads need no grant.
    expect((await fetch(`${base}/v2/_catalog`)).status).toBe(200)
    await expect(registryTagState(UTILITY_MIRROR_TAG)).resolves.toBe('present')
    // Root pods run the builder by the digest the mirror step recorded.
    await expect(mirrorMatchesRecord(UTILITY_MIRROR_TAG)).resolves.toBe(true)

    // A project grant pushes a whole image into the repo it names.
    const config = Buffer.from('{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}')
    const digest = `sha256:${crypto.createHash('sha256').update(config).digest('hex')}`
    const started = await startUpload(`yaac-user-${idA}`, grantA)
    expect(started.status).toBe(202)
    const location = new URL(started.headers.get('location')!, base)
    location.searchParams.set('digest', digest)
    const blob = await fetch(location, {
      method: 'PUT',
      headers: { authorization: grantA, 'content-type': 'application/octet-stream' },
      body: config,
    })
    expect(blob.status).toBe(201)
    const manifest = await fetch(`${base}/v2/yaac-user-${idA}/manifests/gate`, {
      method: 'PUT',
      headers: { authorization: grantA, 'content-type': 'application/vnd.oci.image.manifest.v1+json' },
      body: JSON.stringify({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest, size: config.length },
        layers: [],
      }),
    })
    expect(manifest.status).toBe(201)
    await expect(registryTagState(`yaac-user-${idA}:gate`)).resolves.toBe('present')

    // The grant writes nowhere else.
    for (const repo of [`yaac-user-${idB}`, 'yaac-base', 'podman-stable']) {
      expect((await startUpload(repo, grantA)).status, repo).toBe(403)
    }
    // Nor to a repo nested under its own.
    const nested = await fetch(`${base}/v2/yaac-user-${idA}/blobs/x/manifests/gate`, {
      method: 'PUT',
      headers: { authorization: grantA, 'content-type': 'application/vnd.oci.image.index.v1+json' },
      body: JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] }),
    })
    expect(nested.status).toBe(403)
    // No grant, an expired one, and a DELETE under any grant are refused.
    expect((await startUpload(`yaac-user-${idA}`)).status).toBe(401)
    const expired = basic(await registryGrant([`yaac-user-${idA}`], -60))
    expect((await startUpload(`yaac-user-${idA}`, expired)).status).toBe(401)
    const admin = basic(await registryGrant('*', 600))
    const del = await fetch(`${base}/v2/yaac-user-${idA}/manifests/gate`, {
      method: 'DELETE',
      headers: { authorization: admin },
    })
    expect(del.status).toBe(403)
  }, 60_000)

  it('gates reads of project, user and cache repos on the pod port, and leaves the node port open', async () => {
    // A project image pushed under a grant, read back on both listeners.
    const repo = `yaac-proj-${crypto.randomUUID()}`
    const write = `Basic ${Buffer.from(`yaac:${await registryGrant([repo], 600)}`).toString('base64')}`
    const node = `http://${await registryEndpoint()}`
    const config = Buffer.from('{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}')
    const digest = `sha256:${crypto.createHash('sha256').update(config).digest('hex')}`
    const started = await fetch(`${node}/v2/${repo}/blobs/uploads/`, { method: 'POST', headers: { authorization: write } })
    const location = new URL(started.headers.get('location')!, node)
    location.searchParams.set('digest', digest)
    await fetch(location, { method: 'PUT', headers: { authorization: write, 'content-type': 'application/octet-stream' }, body: config })
    const put = await fetch(`${node}/v2/${repo}/manifests/read`, {
      method: 'PUT',
      headers: { authorization: write, 'content-type': 'application/vnd.oci.image.manifest.v1+json' },
      body: JSON.stringify({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest, size: config.length },
        layers: [],
      }),
    })
    expect(put.status).toBe(201)

    // The node pulls anonymously; only pods on the node can reach it.
    const accept = { accept: 'application/vnd.oci.image.manifest.v1+json' }
    expect((await fetch(`${node}/v2/${repo}/manifests/read`, { method: 'HEAD', headers: accept })).status).toBe(200)
    // On the pod port, which builders reach, a protected repo needs a grant
    // for it, and the catalog is refused.
    const pod = `http://${await registryPodEndpoint()}`
    expect(registryPodHost()).toBe(`${REGISTRY_SERVICE_NAME}.${REGISTRY_NAMESPACE}.svc.cluster.local:5002`)
    expect((await fetch(`${pod}/v2/${repo}/manifests/read`, { method: 'HEAD' })).status).toBe(401)
    const other = `Basic ${Buffer.from(`yaac:${await registryGrant([`yaac-proj-${crypto.randomUUID()}`], 600)}`).toString('base64')}`
    expect((await fetch(`${pod}/v2/${repo}/manifests/read`, { method: 'HEAD', headers: { authorization: other } })).status).toBe(403)
    expect((await fetch(`${pod}/v2/${repo}/manifests/read`, { method: 'HEAD', headers: { ...accept, authorization: write } })).status).toBe(200)
    expect((await fetch(`${pod}/v2/_catalog`)).status).toBe(403)
    // A yaac-shipped image stays an anonymous read there too.
    const anyManifest = { accept: [
      'application/vnd.oci.image.index.v1+json', 'application/vnd.oci.image.manifest.v1+json',
      'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.docker.distribution.manifest.v2+json',
    ].join(', ') }
    expect((await fetch(`${pod}/v2/${UTILITY_MIRROR_TAG.replace(':', '/manifests/')}`, { method: 'HEAD', headers: anyManifest })).status).toBe(200)
  }, 60_000)

  it('reserves yaac.role=builder for the server ServiceAccount alone', async () => {
    await ensureBuilderRoleGuard()

    // This SA has pod-create RBAC, so only the guard can block it.
    const ns = k8sNamespace()
    const faker = `system:serviceaccount:${ns}:faker`
    await applyObject({
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: { name: 'faker-pod-create', namespace: ns },
      rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['create', 'get', 'delete'] }],
    })
    await applyObject({
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: 'faker-pod-create', namespace: ns },
      subjects: [{ kind: 'ServiceAccount', name: 'faker', namespace: ns }],
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'faker-pod-create' },
    })

    const podManifest = (name: string, labeled: boolean, gvisor = true): object => ({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name,
        namespace: ns,
        ...(labeled ? { labels: { 'yaac.role': 'builder' } } : {}),
      },
      spec: {
        restartPolicy: 'Never',
        ...(gvisor ? { runtimeClassName: RUNTIME_CLASS_GVISOR } : {}),
        containers: [{ name: 'c', image: registryRef(UTILITY_MIRROR_TAG), command: ['true'] }],
      },
    })
    const applyAs = (manifest: object, as?: string): Promise<{ stdout: string }> =>
      kubectl(
        ['apply', ...(as ? ['--as', as] : []), '-f', '-'],
        { input: JSON.stringify(manifest) },
      )

    // Only the server SA is admitted, so a cluster admin is denied too.
    // Runs first and retries: it waits out propagation of the guard
    // (a ValidatingAdmissionPolicy), and it is the only case that tells the
    // current guard from an older revision still enforced on the cluster.
    let adminDenial = ''
    for (let i = 0; i < 20 && !adminDenial; i++) {
      try {
        await applyAs(podManifest('admin-builder', true))
        // Not propagated yet: remove the pod and retry.
        await deleteObject({ apiVersion: 'v1', kind: 'Pod', name: 'admin-builder', namespace: ns }, { wait: true })
        await new Promise((r) => setTimeout(r, 500))
      } catch (err) {
        adminDenial = (err as { stderr?: string }).stderr ?? String(err)
      }
    }
    expect(adminDenial).toContain(BUILDER_ROLE_GUARD_NAME)
    expect(adminDenial).toContain('reserved')

    // The SA can create an unlabeled pod...
    await applyAs(podManifest('faker-control', false), faker)
    // ...but not a builder-labeled one.
    const fakerDenial = await applyAs(podManifest('faker-builder', true), faker)
      .then(() => '')
      .catch((err: unknown) => (err as { stderr?: string }).stderr ?? String(err))
    expect(fakerDenial).toContain(BUILDER_ROLE_GUARD_NAME)
    expect(fakerDenial).toContain('reserved')

    // The server's own identity is admitted. Without this, a guard that
    // denied everything would pass.
    const server = serverUsername()
    await applyAs(podManifest('server-builder', true), server)
    await deleteObject({ apiVersion: 'v1', kind: 'Pod', name: 'server-builder', namespace: ns }, { wait: true })

    // Even the server may not put the label on a non-gVisor pod. Only the
    // gvisor check may fail here; 'reserved' would mean the identity check
    // wrongly denied the server.
    const runcDenial = await applyAs(podManifest('server-runc-builder', true, false), server)
      .then(() => '')
      .catch((err: unknown) => (err as { stderr?: string }).stderr ?? String(err))
    expect(runcDenial).toContain('gvisor')
    expect(runcDenial).not.toContain('reserved')

    await deleteObject({ apiVersion: 'v1', kind: 'Pod', name: 'faker-control', namespace: ns }, { wait: true })
  }, 120_000)
})
