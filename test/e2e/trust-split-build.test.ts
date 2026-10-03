import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  requirePodman,
  requireCluster,
  useTestNamespace,
  createTempDataDir,
  cleanupTempDir,
  TEST_IMAGE_PREFIX,
} from '@yaac/test-utils/setup'
import { projectBuildDir, userBuildDir } from '@yaac/server/lib/build-dirs'
import { writeBuildFile } from '@yaac/server/domain/projects/build-files'
import { ensureImage } from '@yaac/server/drivers/k8s/images/build-coordinator'
import { ensureBuilderRoleGuard, ensureNamespace } from '@yaac/server/drivers/k8s/cluster/proxy-apply'
import {
  BUILDER_ROLE_GUARD_NAME,
  SERVER_SA_NAME,
} from '@yaac/server/drivers/k8s/substrate/proxy-constants'
import { resolveImageChain } from '@yaac/server/drivers/k8s/image-engine/image-builder'
import { imageExists } from '@yaac/server/drivers/k8s/container/runtime'
import {
  REGISTRY_NAMESPACE,
  REGISTRY_SERVICE_NAME,
  registryEndpoint,
  registryHasTag,
  registryHost,
  registryReachable,
  registryRef,
  registryTagState,
} from '@yaac/server/drivers/k8s/container/registry'
import { registryGrant } from '@yaac/server/drivers/k8s/container/registry-grant'
import {
  MAIN_REGISTRY_APP_LABEL,
  ensureMainRegistry,
} from '@yaac/server/drivers/k8s/cluster/main-registry'
import { LABEL_REGISTRY_SERVES } from '@yaac/server/drivers/k8s/cluster/project-registry'
import { RUNTIME_CLASS_GVISOR } from '@yaac/server/drivers/k8s/substrate/gvisor'
import { runPodToCompletion } from '@yaac/server/drivers/k8s/substrate/one-shot-pods'
import { applyObject, deleteObject, k8sNamespace, listObjects, readObject } from '@yaac/server/drivers/k8s/substrate/api'
import { _resetK8sClientForTests } from '@yaac/server/drivers/k8s/substrate/client'
import { kubectl } from '@yaac/test-utils/kubectl'
import { getImageBuildLog, listImageBuilds } from '@yaac/server/drivers/k8s/image-engine/image-builds'
import {
  buildServerClusterRoleBindingManifest,
  buildServerClusterRoleManifest,
  buildServerServiceAccountManifest,
} from '@yaac/server/drivers/k8s/install/server-deploy'

/**
 * Trust-split builds (docs/trust-split-builds.md): untrusted
 * Dockerfile.yaac / Dockerfile.user layers build in short-lived gVisor
 * builder pods. Each pulls its parent from the in-cluster registry, streams
 * its build log back, pushes only its new layers, and reuses cached steps
 * from earlier pods via --cache-from/--cache-to. The result is then run as
 * a pod to show the node can pull it.
 */

const PROJECT_SLUG = 'trust-split-e2e'
const PROJECT = { slug: PROJECT_SLUG, id: crypto.randomUUID() }

// Per-run nonce in every RUN step. The registry persists across runs, so
// without it the tags would already exist and the builds would be skipped.
const NONCE = crypto.randomBytes(4).toString('hex')

const DOCKERFILE_V1 = [
  'ARG BASE_IMAGE',
  'FROM ${BASE_IMAGE}',
  `RUN echo step-one-${NONCE} > /tmp/marker-one`,
  `RUN echo step-two-${NONCE} > /tmp/marker-two`,
  '',
].join('\n')

const DOCKERFILE_V2 = [
  'ARG BASE_IMAGE',
  'FROM ${BASE_IMAGE}',
  `RUN echo step-one-${NONCE} > /tmp/marker-one`,
  `RUN echo step-two-${NONCE} > /tmp/marker-two`,
  `RUN echo step-three-${NONCE} > /tmp/marker-three`,
  '',
].join('\n')

// The COPY checks that a support file in the user build dir reaches the
// builder pod and lands in the image.
const DOCKERFILE_USER = [
  'ARG BASE_IMAGE',
  'FROM ${BASE_IMAGE}',
  `RUN echo user-step-${NONCE} > /tmp/marker-user`,
  'COPY nvim/note.txt /tmp/marker-copied',
  '',
].join('\n')

let restoreNamespace: (() => void) | null = null
let tempDataDir: string | null = null
let serverKubeconfigPath: string | null = null

function serverUsername(): string {
  return `system:serviceaccount:${k8sNamespace()}:${SERVER_SA_NAME}`
}

/**
 * A kubeconfig that impersonates this run's server ServiceAccount
 * (`user.as`). This file calls `ensureImage` in-process, and the
 * builder-role guard only admits builder pods from the server's SA, as in
 * production. The host user needs the `impersonate` verb, and requests are
 * authorized as the SA, so beforeAll applies the server's RBAC.
 */
async function writeServerImpersonationKubeconfig(dir: string): Promise<string> {
  const { stdout } = await kubectl(
    ['config', 'view', '--flatten', '--minify', '-o', 'json'],
  )
  const cfg = JSON.parse(stdout) as { users?: Array<{ user?: Record<string, unknown> }> }
  for (const u of cfg.users ?? []) u.user = { ...u.user, as: serverUsername() }
  const file = path.join(dir, 'server-impersonation-kubeconfig.json')
  await fs.writeFile(file, JSON.stringify(cfg))
  return file
}

/**
 * Run `fn` acting as the server's SA, both in kubectl subprocesses and in
 * the API client, whose kubeconfig is loaded once and cached, so it is
 * dropped on the way in and out.
 */
async function asServerIdentity<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.KUBECONFIG
  process.env.KUBECONFIG = serverKubeconfigPath!
  _resetK8sClientForTests()
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.KUBECONFIG
    else process.env.KUBECONFIG = prev
    _resetK8sClientForTests()
  }
}

async function writeProjectDockerfile(content: string): Promise<void> {
  const dir = projectBuildDir(PROJECT_SLUG)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'Dockerfile.yaac'), content)
}

function buildLogFor(tag: string): string {
  const entry = listImageBuilds().find((e) => e.tag === tag)
  expect(entry, `expected a build entry for ${tag}`).toBeTruthy()
  expect(entry?.status).toBe('succeeded')
  return getImageBuildLog(entry!.id) ?? ''
}

describe('trust-split builds', () => {
  beforeAll(async () => {
    await requirePodman()
    await requireCluster()
    restoreNamespace = useTestNamespace()
    // `useTestNamespace` only sets the name; the server's bootstrap would
    // normally create it.
    await ensureNamespace()
    // The server's SA and RBAC, as `deployTestServer` applies them, for the
    // impersonated builds. The cluster-scoped objects are swept by
    // cluster-setup's afterAll.
    await applyObject(buildServerServiceAccountManifest())
    await applyObject(buildServerClusterRoleManifest())
    await applyObject(buildServerClusterRoleBindingManifest())
    tempDataDir = await createTempDataDir()
    serverKubeconfigPath = await writeServerImpersonationKubeconfig(tempDataDir)
  })

  afterAll(async () => {
    await deleteObject({ apiVersion: 'v1', kind: 'Namespace', name: k8sNamespace() }).catch(() => {})
    restoreNamespace?.()
    restoreNamespace = null
    if (tempDataDir) await cleanupTempDir(tempDataDir)
    tempDataDir = null
  })

  it('serves the registry in-cluster behind a selector-backed Service', async () => {
    await ensureMainRegistry()

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
    await expect(registryReachable()).resolves.toBe(true)
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
    await expect(registryTagState('podman-stable:v5.5')).resolves.toBe('present')

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
        containers: [{ name: 'c', image: registryRef('podman-stable:v5.5'), command: ['true'] }],
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

  it('builds untrusted layers in builder pods with cross-pod step cache', async () => {
    // First build: a new project layer.
    await writeProjectDockerfile(DOCKERFILE_V1)
    const chain1 = await resolveImageChain(PROJECT, TEST_IMAGE_PREFIX)
    const projectTag1 = chain1.layers.find((l) => l.name === 'project')?.tag
    expect(projectTag1).toBeTruthy()

    // As the server's SA, the only identity the guard admits.
    const final1 = await asServerIdentity(() => ensureImage(PROJECT, TEST_IMAGE_PREFIX))
    expect(final1).toBe(projectTag1)
    // The image is in the registry only, not the host store.
    expect(await registryHasTag(projectTag1!)).toBe(true)
    expect(await imageExists(projectTag1!)).toBe(false)
    expect(buildLogFor(projectTag1!)).toContain('STEP')

    // Second build: one step appended and a user layer added. A new
    // builder pod must reuse the unchanged steps from the registry cache,
    // then build the user layer.
    await writeProjectDockerfile(DOCKERFILE_V2)
    await fs.mkdir(userBuildDir(), { recursive: true })
    await fs.writeFile(path.join(userBuildDir(), 'Dockerfile.user'), DOCKERFILE_USER)
    // The COPY source for Dockerfile.user.
    await writeBuildFile(userBuildDir(), 'nvim/note.txt', Buffer.from(`copied-${NONCE}\n`))
    const chain2 = await resolveImageChain(PROJECT, TEST_IMAGE_PREFIX)
    const projectTag2 = chain2.layers.find((l) => l.name === 'project')?.tag
    const userTag = chain2.layers.find((l) => l.name === 'user')?.tag
    expect(projectTag2).toBeTruthy()
    expect(projectTag2).not.toBe(projectTag1)
    expect(userTag).toBeTruthy()

    const final2 = await asServerIdentity(() => ensureImage(PROJECT, TEST_IMAGE_PREFIX))
    expect(final2).toBe(userTag)
    expect(await registryHasTag(projectTag2!)).toBe(true)
    expect(await registryHasTag(userTag!)).toBe(true)

    expect(buildLogFor(projectTag2!)).toContain('Using cache')

    // The result runs: the node can pull the manifest whose parent layers
    // were mounted from another repo.
    const run = await runPodToCompletion({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'trust-split-verify', namespace: k8sNamespace() },
      spec: {
        restartPolicy: 'Never',
        runtimeClassName: RUNTIME_CLASS_GVISOR,
        containers: [{
          name: 'verify',
          image: registryRef(userTag!),
          imagePullPolicy: 'Always',
          command: [
            '/bin/sh', '-c',
            'cat /tmp/marker-one /tmp/marker-three /tmp/marker-user /tmp/marker-copied',
          ],
        }],
      },
    }, { timeoutMs: 180_000 })
    expect(run.phase).toBe('Succeeded')
    expect(run.logs).toContain('step-one')
    expect(run.logs).toContain('step-three')
    expect(run.logs).toContain('user-step')
    expect(run.logs).toContain('copied-')

    // Support files are part of the content hash, so an edit re-tags the
    // user layer (checked by resolution alone).
    await writeBuildFile(userBuildDir(), 'nvim/note.txt', Buffer.from(`edited-${NONCE}\n`))
    const chain3 = await resolveImageChain(PROJECT, TEST_IMAGE_PREFIX)
    const userTag3 = chain3.layers.find((l) => l.name === 'user')?.tag
    expect(userTag3).toBeTruthy()
    expect(userTag3).not.toBe(userTag)

    // No builder pods are left behind.
    const leftover = await listObjects<{ metadata: { name: string; deletionTimestamp?: string } }>(
      'v1', 'Pod', { namespace: k8sNamespace(), labelSelector: 'yaac.role=builder' },
    )
    const alive = leftover.filter((p) => !p.metadata.deletionTimestamp)
    expect(alive).toEqual([])
  }, 900_000)
})
