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
  IS_NESTED_YAAC,
} from '@yaac/test-utils/setup'
import { projectBuildDir, userBuildDir } from '@yaac/server/store/projects/build-dirs'
import { writeBuildFile } from '@yaac/server/store/projects/build-files'
import { ensureImage } from '@yaac/server/runtime/k8s/images/build-coordinator'
import { ensureBuilderRoleGuard, ensureNamespace } from '@yaac/server/runtime/k8s/cluster/proxy-apply'
import { BUILDER_ROLE_GUARD_NAME } from '@yaac/server/platform/k8s/proxy-constants'
import { resolveImageChain } from '@yaac/server/runtime/k8s/image-engine/image-builder'
import { imageExists } from '@yaac/server/platform/container/runtime'
import {
  REGISTRY_NAMESPACE,
  REGISTRY_SERVICE_NAME,
  registryHasTag,
  registryHost,
  registryReachable,
  registryRef,
} from '@yaac/server/platform/container/registry'
import {
  MAIN_REGISTRY_APP_LABEL,
  ensureMainRegistry,
} from '@yaac/server/runtime/k8s/cluster/main-registry'
import { RUNTIME_CLASS_GVISOR } from '@yaac/server/platform/k8s/gvisor'
import { runPodToCompletion } from '@yaac/server/platform/k8s/pods'
import {
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '@yaac/server/platform/k8s/kubectl'
import { getImageBuildLog, listImageBuilds } from '@yaac/server/runtime/k8s/image-engine/image-builds'

/**
 * End-to-end coverage of trust-split builds (docs/trust-split-builds.md):
 * untrusted Dockerfile.yaac / Dockerfile.user layers build inside ephemeral
 * runsc builder pods that pull their parent from the shared registry
 * (an in-cluster Deployment behind a ClusterIP Service), stream
 * build logs back through the build-tracking registry, delta-push their
 * product, and step-cache every unchanged instruction across genuinely
 * distinct pods via --cache-from/--cache-to registry cache images. The
 * final product is then run as a pod, proving node containerd can pull the
 * cross-repo-mounted manifest.
 *
 * Skipped nested: a nested install always routes builds to its (already
 * sandboxed) in-pod engine, and the podman `kind` network the registry
 * Service targets does not exist inside a session pod.
 */

const PROJECT_SLUG = 'trust-split-e2e'

// Per-run nonce baked into every RUN step: content-hash tags must be new
// each run, or the registry (which persists across e2e runs) already holds
// them and ensureImage rightly skips the builds this test asserts on.
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

// COPY proves the build-files flow end to end: a support file written into
// the user build dir ships to the builder pod (tar stream) and lands in
// the image.
const DOCKERFILE_USER = [
  'ARG BASE_IMAGE',
  'FROM ${BASE_IMAGE}',
  `RUN echo user-step-${NONCE} > /tmp/marker-user`,
  'COPY nvim/note.txt /tmp/marker-copied',
  '',
].join('\n')

let restoreNamespace: (() => void) | null = null
let tempDataDir: string | null = null

async function writeProjectDockerfile(content: string): Promise<void> {
  const dir = projectBuildDir(PROJECT_SLUG)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'Dockerfile.yaac'), content)
}

function buildLogFor(tag: string): string {
  const entry = listImageBuilds().find((e) => e.tag === tag && e.action === 'build')
  expect(entry, `expected a build entry for ${tag}`).toBeTruthy()
  expect(entry?.status).toBe('succeeded')
  return getImageBuildLog(entry!.id) ?? ''
}

describe.skipIf(IS_NESTED_YAAC)('trust-split builds', () => {
  beforeAll(async () => {
    await requirePodman()
    await requireCluster()
    restoreNamespace = useTestNamespace()
    // `useTestNamespace` only points YAAC_K8S_NAMESPACE at this run's
    // namespace; something still has to create it, and every object below
    // (the builder-role guard, the builder pods) lands in it. The server's
    // bootstrap is what does this in production — in here it is the
    // fixture's job.
    await ensureNamespace()
    tempDataDir = await createTempDataDir()
  })

  afterAll(async () => {
    await kubectlWithRetry(
      ['delete', 'namespace', k8sNamespace(), '--ignore-not-found', '--wait=false'],
      { maxAttempts: 2 },
    ).catch(() => {})
    restoreNamespace?.()
    restoreNamespace = null
    if (tempDataDir) await cleanupTempDir(tempDataDir)
    tempDataDir = null
  })

  it('serves the registry in-cluster behind a selector-backed Service', async () => {
    await ensureMainRegistry()

    // The ref every pod pulls by: the registry's own Service FQDN, in the
    // DEFAULT namespace rather than this run's isolated one — every run
    // shares one image store.
    expect(registryHost())
      .toBe(`${REGISTRY_SERVICE_NAME}.${REGISTRY_NAMESPACE}.svc.cluster.local:5000`)

    const svc = await kubectlGetJson<{ spec: { selector?: Record<string, string>; clusterIP?: string } }>([
      'get', 'service', REGISTRY_SERVICE_NAME, '-n', REGISTRY_NAMESPACE,
    ])
    expect(svc?.spec.selector).toEqual({ app: MAIN_REGISTRY_APP_LABEL })
    expect(svc?.spec.clusterIP).toBeTruthy()

    // Rolled out, and reachable from the server through its port-forward —
    // no host networking assumption anywhere in the path.
    const deploy = await kubectlGetJson<{ status?: { readyReplicas?: number } }>([
      'get', 'deployment', REGISTRY_SERVICE_NAME, '-n', REGISTRY_NAMESPACE,
    ])
    expect(deploy?.status?.readyReplicas).toBeGreaterThan(0)
    await expect(registryReachable()).resolves.toBe(true)
  }, 120_000)

  it('reserves yaac.role=builder — a pod-creating ServiceAccount cannot fake it', async () => {
    await ensureBuilderRoleGuard()

    // A ServiceAccount WITH pod-create RBAC in this namespace — the exact
    // shape of a vcluster syncer, the only pod-create path a session can
    // reach. RBAC must not be what blocks the fake below.
    const ns = k8sNamespace()
    const faker = `system:serviceaccount:${ns}:faker`
    await kubectlApply({
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: { name: 'faker-pod-create', namespace: ns },
      rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['create', 'get', 'delete'] }],
    })
    await kubectlApply({
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
      kubectlWithRetry(
        ['apply', ...(as ? ['--as', as] : []), '-f', '-'],
        { input: JSON.stringify(manifest), maxAttempts: 1 },
      )

    // Control: the SA CAN create an unlabeled pod (RBAC path is open)...
    // Retried: freshly-written VAP/RBAC objects can lag a moment.
    let denial = ''
    for (let i = 0; i < 20 && !denial; i++) {
      await applyAs(podManifest('faker-control', false), faker)
      // ...but a builder-labeled pod is rejected by the admission policy.
      try {
        await applyAs(podManifest('faker-builder', true), faker)
        // Propagation lag: the fake got through — remove it and retry.
        await kubectlWithRetry(['delete', 'pod', 'faker-builder', '-n', ns, '--ignore-not-found'])
        await new Promise((r) => setTimeout(r, 500))
      } catch (err) {
        denial = (err as { stderr?: string }).stderr ?? String(err)
      }
    }
    expect(denial).toContain(BUILDER_ROLE_GUARD_NAME)
    expect(denial).toContain('reserved')

    // The label also may not ride on a non-sandboxed pod, even for the
    // trusted admin identity.
    const runcDenial = await applyAs(podManifest('admin-runc-builder', true, false))
      .then(() => '')
      .catch((err: unknown) => (err as { stderr?: string }).stderr ?? String(err))
    expect(runcDenial).toContain('gvisor')

    await kubectlWithRetry(['delete', 'pod', 'faker-control', '-n', ns, '--ignore-not-found'])
  }, 120_000)

  it('builds untrusted layers in builder pods with cross-pod step cache', async () => {
    // --- First build: fresh project layer, built in a builder pod. ---
    await writeProjectDockerfile(DOCKERFILE_V1)
    const chain1 = await resolveImageChain(PROJECT_SLUG, TEST_IMAGE_PREFIX)
    const projectTag1 = chain1.layers.find((l) => l.name === 'project')?.tag
    expect(projectTag1).toBeTruthy()

    const final1 = await ensureImage(PROJECT_SLUG, TEST_IMAGE_PREFIX)
    expect(final1).toBe(projectTag1)
    // The product lives in the registry — and only there: the host store
    // never sees a cluster-pod tag.
    expect(await registryHasTag(projectTag1!)).toBe(true)
    expect(await imageExists(projectTag1!)).toBe(false)
    expect(buildLogFor(projectTag1!)).toContain('STEP')

    // --- Second build: one step appended + a user layer added. A FRESH
    // builder pod must cache-hit the unchanged instruction prefix from the
    // registry (--cache-from), then build the user layer in the same pod. ---
    await writeProjectDockerfile(DOCKERFILE_V2)
    await fs.mkdir(userBuildDir(), { recursive: true })
    await fs.writeFile(path.join(userBuildDir(), 'Dockerfile.user'), DOCKERFILE_USER)
    // A support file next to Dockerfile.user — the COPY source above.
    await writeBuildFile(userBuildDir(), 'nvim/note.txt', Buffer.from(`copied-${NONCE}\n`))
    const chain2 = await resolveImageChain(PROJECT_SLUG, TEST_IMAGE_PREFIX)
    const projectTag2 = chain2.layers.find((l) => l.name === 'project')?.tag
    const userTag = chain2.layers.find((l) => l.name === 'user')?.tag
    expect(projectTag2).toBeTruthy()
    expect(projectTag2).not.toBe(projectTag1)
    expect(userTag).toBeTruthy()

    const final2 = await ensureImage(PROJECT_SLUG, TEST_IMAGE_PREFIX)
    expect(final2).toBe(userTag)
    expect(await registryHasTag(projectTag2!)).toBe(true)
    expect(await registryHasTag(userTag!)).toBe(true)

    // The edited Dockerfile re-ran only its changed step: the unchanged
    // prefix came from the registry step cache in a pod that had never
    // built anything.
    expect(buildLogFor(projectTag2!)).toContain('Using cache')

    // --- The product is a runnable image: node containerd pulls the
    // delta-pushed manifest (parent blobs cross-repo-mounted by the pod). ---
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
    // The uploaded support file was streamed into the builder pod's
    // context and COPY'd into the image.
    expect(run.logs).toContain('copied-')

    // Editing a support file re-tags the user layer (context files are
    // part of the content hash) — resolution only, no third build needed.
    await writeBuildFile(userBuildDir(), 'nvim/note.txt', Buffer.from(`edited-${NONCE}\n`))
    const chain3 = await resolveImageChain(PROJECT_SLUG, TEST_IMAGE_PREFIX)
    const userTag3 = chain3.layers.find((l) => l.name === 'user')?.tag
    expect(userTag3).toBeTruthy()
    expect(userTag3).not.toBe(userTag)

    // --- No builder pods left behind (inline delete on release). ---
    const leftover = await kubectlGetJson<{
      items: Array<{ metadata: { name: string; deletionTimestamp?: string } }>
    }>(['get', 'pods', '-n', k8sNamespace(), '-l', 'yaac.role=builder'])
    const alive = (leftover?.items ?? []).filter((p) => !p.metadata.deletionTimestamp)
    expect(alive).toEqual([])
  }, 900_000)
})
