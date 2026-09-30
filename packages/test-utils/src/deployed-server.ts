import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import {
  SERVER_APP_NAME,
  SERVER_POD_PORT,
  SERVER_SA_NAME,
  k8sNamespace,
  kubectlApply,
  kubectlWithRetry,
  processIdentity,
} from '@yaac/server/drivers/k8s/substrate'
import { buildServerIngressNpManifest, ensureNamespace, nodeIpBlocks } from '@yaac/server/drivers/k8s/cluster'
import { registryHasTag, registryRef } from '@yaac/server/drivers/k8s/container'
import {
  buildServerClusterRoleBindingManifest,
  buildServerClusterRoleManifest,
  buildServerDeploymentManifest,
  buildServerServiceAccountManifest,
  ensureServerImage,
  resolveServerImageTag,
} from '@yaac/server/drivers/k8s/install/server-deploy'
import { readLock } from '@yaac/shared/lock'
import { registerServer } from '@yaac/shared/server-config'
import type { ServerLock } from '@yaac/shared/server-lock-file'
import { startKubectlForward, type KubectlForward } from '#kubectl-forward'
import { ensureTestStorageClaims } from '#storage-claims'
import { testTmpBase } from '#tmp'
import { TEST_CLI_DIR } from '#cli-bundle'
import { TEST_IMAGE_PREFIX } from '#setup'

const execFileAsync = promisify(execFile)

/**
 * The yaac server the k8s tiers use: a Deployment in the file's test
 * namespace, the same shape a real install runs (docs/server-in-cluster.md).
 * `spawnYaacServer` returns this for every non-containerless suite, with
 * the same `{ lock, stop }` as a host server.
 *
 * What the file's namespace needs that an install already has:
 *
 *  - **A reachable origin.** A `kubectl port-forward` per file. The
 *    returned lock reports its local port, not the pod's.
 *  - **RBAC.** A ServiceAccount and a ClusterRoleBinding named per
 *    namespace, so files don't share one.
 *  - **Storage.** The install's claim pair, bound to the file's own data
 *    dir (`#storage-claims`), plus one extra mount of the scratch base
 *    (`testTmpBase()`) at its own path, since test repos and mock-remote
 *    stores live beside the data dir rather than in a tier.
 */

/**
 * The image the test Deployment runs, content-hash tagged over the suite's
 * frozen copy of the bundle (see TEST_CLI_DIR) so it can't change mid-run.
 */
export async function testServerImageTag(): Promise<string> {
  return resolveServerImageTag(TEST_CLI_DIR, TEST_IMAGE_PREFIX)
}

/** Build the dev server image and push it — `test/global-setup.ts` only. */
export async function buildTestServerImage(): Promise<string> {
  return ensureServerImage(TEST_CLI_DIR, TEST_IMAGE_PREFIX)
}

export interface DeployedServer {
  /**
   * The pod's lock with its port replaced by this file's forward port.
   */
  lock: ServerLock
  stop: () => Promise<void>
}

export interface DeployTestServerOptions {
  /** Env the file wants the server to run with (the `YAAC_*` half is passed on). */
  env: NodeJS.ProcessEnv
}

/**
 * Apply the server Deployment for this test file and wait for it to answer.
 *
 * The other objects are re-applied idempotently on every call.
 */
export async function deployTestServer(opts: DeployTestServerOptions): Promise<DeployedServer> {
  const imageRef = await requirePrebuiltServerImage()

  await ensureNamespace()
  await ensureTestStorageClaims(imageRef)
  await kubectlApply(buildServerServiceAccountManifest())
  await kubectlApply(buildServerClusterRoleManifest())
  await kubectlApply(buildServerClusterRoleBindingManifest())
  // Only the node-side ingress rule, which admits the kubelet's readiness
  // probe. `kubectl port-forward` bypasses network policy.
  await kubectlApply(buildServerIngressNpManifest(await nodeIpBlocks()))
  await kubectlApply(testServerDeploymentManifest(imageRef, opts.env))
  try {
    await kubectlWithRetry([
      'rollout', 'status', `deployment/${SERVER_APP_NAME}`,
      '-n', k8sNamespace(), '--timeout=300s',
    ], { timeout: 310_000, maxAttempts: 2 })
  } catch (err) {
    // A timed-out rollout says nothing about why, and the namespace is
    // swept when the file ends, so collect the evidence now.
    throw new Error(
      `the test server Deployment never rolled out.\n${await describeServerPods()}`,
      { cause: err },
    )
  }

  const forward = await startForward(opts.env)
  const logs = opts.env.YAAC_TEST_DEBUG_SERVER === '1' ? streamPodLogs() : null

  let lock: ServerLock
  try {
    lock = await waitForServer(forward.port)
  } catch (err) {
    await forward.stop()
    logs?.kill()
    await deleteDeployment()
    throw err
  }

  // Point this file's CLI calls at the forward through `server.json`, as
  // `yaac cluster install` does for the published origin.
  await registerServer(forward.origin, 'k8s')

  return {
    lock: { ...lock, port: forward.port },
    stop: async (): Promise<void> => {
      await forward.stop()
      logs?.kill()
      await deleteDeployment()
    },
  }
}

/**
 * The image ref. A missing or stale tag is an error, never a rebuild, as for
 * every e2e image.
 */
async function requirePrebuiltServerImage(): Promise<string> {
  const tag = await testServerImageTag()
  if (!await registryHasTag(tag)) {
    throw new Error(
      `the dev server image ${tag} is not in the local registry. It is built `
      + 'once per run by test/global-setup.ts from dist-test/ — run the suite '
      + 'through vitest rather than invoking this fixture directly, and check '
      + 'that the registry is reachable.',
    )
  }
  return registryRef(tag)
}

/**
 * The production Deployment (from `buildServerDeploymentManifest`, so it
 * can't drift) with three changes: the file's env, an extra mount of the
 * scratch tree, and a smaller resource request.
 */
function testServerDeploymentManifest(
  imageRef: string,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  // This machine's uid, as on a kind install.
  const manifest = buildServerDeploymentManifest(imageRef, processIdentity()) as {
    spec: { template: { spec: {
      containers: Array<{
        env: Array<{ name: string; value: string }>
        resources: Record<string, unknown>
        volumeMounts: unknown[]
      }>
      volumes: unknown[]
    } } }
  }
  const podSpec = manifest.spec.template.spec
  const container = podSpec.containers[0]
  container.env = mergeEnv(testPassThrough(env), container.env)
  // Several files' namespaces can be alive at once on one node, so a
  // production-sized request would exhaust the scheduler. The limit is
  // unchanged.
  container.resources = {
    ...container.resources,
    requests: { cpu: '100m', memory: '256Mi' },
  }
  const base = testTmpBase()
  container.volumeMounts.push({ name: 'scratch', mountPath: base })
  podSpec.volumes.push({ name: 'scratch', hostPath: { path: base, type: 'DirectoryOrCreate' } })
  return manifest as unknown as Record<string, unknown>
}

/**
 * The part of a test file's env the pod gets: the `YAAC_*` vars that differ
 * from this worker's own environment (i.e. those `createYaacTestEnv` or the
 * file set), plus the redirected git config. Copying every `YAAC_*` var
 * would leak the outer shell's, such as a yaac workspace's
 * `YAAC_WORKSPACE_ID`.
 */
function testPassThrough(env: NodeJS.ProcessEnv): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = []
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === process.env[name]) continue
    if (name === 'GIT_CONFIG_GLOBAL' || name.startsWith('YAAC_')) out.push({ name, value })
  }
  return out
}

/** Later entries win — the Deployment's own answers override a passed-through one. */
function mergeEnv(
  ...lists: Array<Array<{ name: string; value: string }>>
): Array<{ name: string; value: string }> {
  const merged = new Map<string, string>()
  for (const list of lists) for (const { name, value } of list) merged.set(name, value)
  return [...merged].map(([name, value]) => ({ name, value }))
}

/**
 * Delete this file's server and wait for the pod to be gone.
 * `kubectl delete deployment --wait` returns while the pod still runs, and
 * a file that then writes to the database would race the old server's
 * PGlite.
 */
async function deleteDeployment(): Promise<void> {
  await kubectlWithRetry([
    'delete', 'deployment', SERVER_APP_NAME, '-n', k8sNamespace(),
    '--ignore-not-found', '--wait=true', '--timeout=120s',
  ], { timeout: 130_000, maxAttempts: 1 }).catch(() => {
    // The namespace delete in cluster-setup is the backstop.
  })
  await kubectlWithRetry([
    'wait', 'pod', '-n', k8sNamespace(), '-l', `app=${SERVER_APP_NAME}`,
    '--for=delete', '--timeout=120s',
  ], { timeout: 130_000, maxAttempts: 1 }).catch(() => {
  })
}

/** Everything a never-rolled-out Deployment can be asked about, as text. */
async function describeServerPods(): Promise<string> {
  const ns = k8sNamespace()
  const parts: string[] = []
  for (const args of [
    ['get', 'pods', '-n', ns, '-l', `app=${SERVER_APP_NAME}`, '-o', 'wide'],
    ['describe', 'pods', '-n', ns, '-l', `app=${SERVER_APP_NAME}`],
    ['get', 'events', '-n', ns, '--sort-by=.lastTimestamp'],
    ['describe', 'node'],
  ]) {
    const out = await execFileAsync('kubectl', args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
      .then((r) => r.stdout)
      .catch((err: unknown) => `(failed: ${err instanceof Error ? err.message : String(err)})`)
    parts.push(`--- kubectl ${args.join(' ')} ---\n${out}`)
  }
  return parts.join('\n')
}

/**
 * Delete the cluster-scoped RBAC for this namespace's server, which
 * namespace deletion doesn't remove.
 */
export async function deleteTestServerClusterRbac(namespace: string): Promise<void> {
  await execFileAsync('kubectl', [
    'delete', `clusterrole/${SERVER_SA_NAME}-${namespace}`,
    `clusterrolebinding/${SERVER_SA_NAME}-${namespace}`,
    '--ignore-not-found', '--wait=false',
  ], { timeout: 30_000 }).catch(() => { /* cluster gone — nothing to sweep */ })
}

/**
 * This file's forward into its server, on the env's `YAAC_SERVER_PORT`.
 * `yaac server start|restart` waits for the published origin, which that
 * variable names, so the forward acts as this install's published origin.
 */
function startForward(env: NodeJS.ProcessEnv): Promise<KubectlForward> {
  const wanted = Number.parseInt(env.YAAC_SERVER_PORT ?? '', 10)
  return startKubectlForward({
    namespace: k8sNamespace(),
    target: `deployment/${SERVER_APP_NAME}`,
    remotePort: SERVER_POD_PORT,
    ...(Number.isInteger(wanted) && wanted > 0 ? { localPort: wanted } : {}),
  })
}

/**
 * Wait until `/health` over the forward reports ready, then read the lock
 * the pod wrote. The lock's pid and port are the pod's, so they can't be
 * checked from here.
 */
async function waitForServer(port: number, timeoutMs = 120_000): Promise<ServerLock> {
  const deadline = Date.now() + timeoutMs
  let last = 'no attempt made'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (res.ok) {
        const body = await res.json() as { ready?: unknown }
        if (body.ready === true) {
          const lock = await readLock()
          if (lock) return lock
          last = 'ready, but has not written its lock yet'
        } else last = 'answered /health but is still initializing'
      } else last = `answered HTTP ${String(res.status)}`
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(
    `the test server Deployment never answered on 127.0.0.1:${String(port)} (${last}). `
    + `Try: kubectl logs -n ${k8sNamespace()} deployment/${SERVER_APP_NAME}`,
  )
}

/** With `YAAC_TEST_DEBUG_SERVER=1`, forward the pod's stdout. */
function streamPodLogs(): ChildProcess {
  const child = spawn('kubectl', [
    'logs', '-f', '--tail', '-1', '-n', k8sNamespace(), `deployment/${SERVER_APP_NAME}`,
  ], { stdio: ['ignore', 'pipe', 'ignore'] })
  child.stdout?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[server] ${chunk.toString()}`)
  })
  return child
}
