import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import {
  SERVER_APP_NAME,
  SERVER_POD_PORT,
  SERVER_SA_NAME,
  k8sNamespace,
  kubectlApply,
  kubectlWithRetry,
} from '@yaac/server/drivers/k8s/substrate'
import { buildServerIngressNpManifest, clusterPodCidrs, ensureNamespace } from '@yaac/server/drivers/k8s/cluster'
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
import { readServerConfig, registerServer } from '@yaac/shared/server-config'
import type { ServerLock } from '@yaac/shared/server-lock-file'
import { startKubectlForward, type KubectlForward } from '#kubectl-forward'
import { testTmpBase } from '#tmp'
import { TEST_CLI_DIR } from '#cli-bundle'
import { TEST_IMAGE_PREFIX } from '#setup'

const execFileAsync = promisify(execFile)

/**
 * The yaac server the k8s tiers drive: a Deployment in the file's own test
 * namespace, exactly the shape a real install runs (docs/server-in-cluster.md).
 *
 * There is no host-process k8s server to spawn any more, so this is what
 * `spawnYaacServer` resolves to for every suite that is not containerless.
 * It answers the same `{ lock, stop }` the host spawn did, and that is the
 * whole seam: a test file asks for a server, gets a loopback origin and a
 * bearer, and never learns which side of the cluster boundary it is on.
 *
 * Three things the host process got for free have to be handed to a pod:
 *
 *  - **A reachable origin.** The lock the pod writes carries the port it
 *    binds INSIDE the pod, which is nothing on this machine. A
 *    `kubectl port-forward` per file supplies one, and — being loopback —
 *    satisfies the server's DNS-rebind Host guard the way the published
 *    NodePort does in production. The returned lock reports the LOCAL port,
 *    never the pod's.
 *  - **RBAC in this namespace.** Install binds the server's ClusterRole to
 *    a ServiceAccount in the install namespace; an e2e file's namespace is
 *    `yaac-test-<run-id>` and has neither. Both are applied here, under the
 *    namespace-suffixed cluster-scoped name so files never fight over one
 *    binding.
 *  - **Its scratch.** Production mounts the data dir; a test file's data
 *    dir is one directory under `testTmpBase()`, and the git config, source
 *    repos and mock-remote stores it also has to see are siblings of it. So
 *    the mount is that base, at its own absolute path — which the same
 *    host==node contract `yaac cluster check` proves is what makes every
 *    other e2e hostPath work.
 */

/**
 * The image the test Deployment runs: the same content-hash contract as
 * every other yaac-shipped image, over the suite's FROZEN copy of the
 * bundle rather than `dist/` itself. `pnpm watch` rewrites `dist/` on every
 * save, so hashing it would re-tag mid-run and leave workers looking up an
 * image nobody built.
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
   * The pod's lock with its port rewritten to this file's forward. Never
   * the port the pod wrote: that one is on another loopback entirely.
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
 * Every object except the Deployment is idempotent and namespace-scoped, so
 * a file that stops and starts its server several times re-applies them for
 * nothing rather than having to track what it already made.
 */
export async function deployTestServer(opts: DeployTestServerOptions): Promise<DeployedServer> {
  const imageRef = await requirePrebuiltServerImage()

  await ensureNamespace()
  await kubectlApply(buildServerServiceAccountManifest())
  await kubectlApply(buildServerClusterRoleManifest())
  await kubectlApply(buildServerClusterRoleBindingManifest())
  await kubectlApply(buildServerIngressNpManifest(await clusterPodCidrs()))
  await kubectlApply(testServerDeploymentManifest(imageRef, opts.env))
  try {
    await kubectlWithRetry([
      'rollout', 'status', `deployment/${SERVER_APP_NAME}`,
      '-n', k8sNamespace(), '--timeout=300s',
    ], { timeout: 310_000, maxAttempts: 2 })
  } catch (err) {
    // A rollout that never completes is the one failure here with no useful
    // message of its own — "timed out waiting for the condition" says
    // nothing about whether the pod was unschedulable, stuck pulling, or
    // simply slow to report ready. The suite runs unattended and the
    // namespace is swept when the file ends, so the evidence has to be
    // collected NOW or it is gone.
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

  // Point this file's CLI invocations at the forward, the way `yaac cluster
  // install` points a real machine's at the published origin: through
  // `server.json`, which is the only thing `resolveServerTarget` reads —
  // and has to be, because the lock on this shared data dir was written by
  // a pod.
  //
  // A DURABLE token, minted the same way install mints one, and for the same
  // reason: the lock secret is per BOOT, so the moment a file restarts its
  // server (`yaac server restart`, or a stop-then-start) every later command
  // would be answered BAD_BEARER by the pod that replaced it. A durable
  // token lives in the database, which is on the data dir both pods share.
  await bootstrapRemote(forward.origin)

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
 * Register this file's server the way `yaac cluster install` registers a
 * real one — the whole of "the CLI can find this server".
 *
 * The empty-token degradation that is right in production (a
 * credential-optional install needs none) is a hard failure here: these
 * suites run auth-on, so a tokenless config means every CLI call in the
 * file is answered BAD_BEARER the first time the server rolls.
 */
async function bootstrapRemote(origin: string): Promise<void> {
  await registerServer(origin, 'k8s')
  const cfg = await readServerConfig()
  if (cfg?.token === undefined || cfg.token === '') {
    throw new Error(
      `could not mint a durable token against ${origin}: the test server is up `
      + 'but would not issue one, so every CLI call in this file would be '
      + 'answered BAD_BEARER the first time the server rolls.',
    )
  }
}

/**
 * The image ref, or a failure that names the build. Same contract as every
 * other e2e image (`requirePrebuilt`): a worker must never race a podman
 * build, so a missing or stale tag is a hard error here rather than a
 * silent rebuild inside a test.
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
 * The production Deployment, with the three things a test file changes: the
 * env it wants the server to have, a mount wide enough to cover the scratch
 * tree its data dir hangs off, and a request small enough that a node
 * running several files' namespaces at once can fit them all.
 *
 * Derived from `buildServerDeploymentManifest` rather than written out, so
 * the pod these suites exercise cannot drift from the pod an install
 * deploys — a probe, a security context or a priority class that changed
 * there changes here.
 */
function testServerDeploymentManifest(
  imageRef: string,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const manifest = buildServerDeploymentManifest(imageRef) as {
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
  // A production server asks for room to run an install; a test server runs
  // one FILE. The suite keeps several namespaces alive at once — a finished
  // file's namespace drains in the background while the next one starts —
  // so a production-sized request per file is what the scheduler runs out
  // of first, on the same node that also has to fit worktree pods, builder
  // pods and a proxy per namespace. The limit is left alone: it is not
  // scheduled against, and PGlite still lives in this process.
  container.resources = {
    ...container.resources,
    requests: { cpu: '100m', memory: '256Mi' },
  }
  const base = testTmpBase()
  container.volumeMounts = [{ name: 'scratch', mountPath: base }]
  podSpec.volumes = [{ name: 'scratch', hostPath: { path: base, type: 'DirectoryOrCreate' } }]
  return manifest as unknown as Record<string, unknown>
}

/**
 * What of a test file's environment the pod is given: the `YAAC_*` knobs the
 * SUITE set, plus the redirected git config.
 *
 * "The suite set" is the whole rule, and it is read as "differs from this
 * worker's own environment" — because `createYaacTestEnv` builds its env by
 * spreading `process.env` and overriding, so the difference IS the set of
 * deliberate choices (the data dir, the namespace, the image prefix, the
 * prewarm sizes, the auth requirement, plus whatever one file adds for
 * itself).
 *
 * Copying every `YAAC_*` instead would hand the pod the environment of
 * whatever shell started vitest — which, when that shell is a yaac worktree,
 * includes `YAAC_WORKTREE_ID` (the server would then read itself as running
 * INSIDE a session and stop requiring a credential) and the tailnet
 * `YAAC_ALLOWED_HOSTS` of an unrelated install. Copying the whole
 * environment would be worse still: `HOME`, `PATH` and `KUBECONFIG` name
 * nothing inside a container.
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
 * Delete this file's server and wait for the POD to be gone.
 *
 * The pod, not the Deployment: `kubectl delete deployment --wait` uses
 * background propagation, so it returns while the pod is still running —
 * and a file that stops its server to write into the database itself (the
 * `--stopped` listings seed rows that way) would then race a PGlite the
 * departing server still holds open.
 */
async function deleteDeployment(): Promise<void> {
  await kubectlWithRetry([
    'delete', 'deployment', SERVER_APP_NAME, '-n', k8sNamespace(),
    '--ignore-not-found', '--wait=true', '--timeout=120s',
  ], { timeout: 130_000, maxAttempts: 1 }).catch(() => {
    // The namespace drop in cluster-setup takes it either way; a slow
    // delete must not fail the file that was only tidying up.
  })
  await kubectlWithRetry([
    'wait', 'pod', '-n', k8sNamespace(), '-l', `app=${SERVER_APP_NAME}`,
    '--for=delete', '--timeout=120s',
  ], { timeout: 130_000, maxAttempts: 1 }).catch(() => {
    // Same: a wedged pod must not fail a teardown, and the namespace drop
    // is the backstop.
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
 * Delete the cluster-scoped RBAC this run's servers were bound through.
 * Namespace deletion does not cascade to it (netd's has the same problem),
 * so the per-file teardown and the global sweep both call it.
 */
export async function deleteTestServerClusterRbac(namespace: string): Promise<void> {
  await execFileAsync('kubectl', [
    'delete', `clusterrole/${SERVER_SA_NAME}-${namespace}`,
    `clusterrolebinding/${SERVER_SA_NAME}-${namespace}`,
    '--ignore-not-found', '--wait=false',
  ], { timeout: 30_000 }).catch(() => { /* cluster gone — nothing to sweep */ })
}

/**
 * This file's forward into its server, bound on the port the file's env
 * names as `YAAC_SERVER_PORT`.
 *
 * Not a detail. `yaac server start|restart` against a Deployment waits for
 * the PUBLISHED origin to answer, and the published origin is
 * `127.0.0.1:<resolveServerPort()>` — that same variable, read in the CLI
 * child. Binding the forward there is what makes the forward this test
 * install's published origin, and what lets those verbs be exercised at all
 * rather than being told the cluster never published a server.
 *
 * The port is per worker (see `TEST_SERVER_PORT_BASE`), so files racing in
 * parallel workers cannot collide; files sharing a worker run one at a time
 * and the previous one's `stop()` has already waited out its child.
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
 * Wait until the forwarded origin reports a READY server, then read the
 * lock the pod wrote into the shared data dir.
 *
 * Readiness comes from `/health` over the forward rather than from the lock,
 * for the reason `isLockReady` refuses to answer here at all: a lock written
 * on the other side of a container boundary has a pid in another namespace
 * and a port on another loopback. The forward is the one signal that means
 * what it says.
 */
async function waitForServer(port: number, timeoutMs = 120_000): Promise<ServerLock> {
  const deadline = Date.now() + timeoutMs
  let last = 'no attempt made'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/health`, {
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

/** `YAAC_TEST_DEBUG_SERVER=1` — the pod's stdout, the way the host spawn forwarded stderr. */
function streamPodLogs(): ChildProcess {
  const child = spawn('kubectl', [
    'logs', '-f', '--tail', '-1', '-n', k8sNamespace(), `deployment/${SERVER_APP_NAME}`,
  ], { stdio: ['ignore', 'pipe', 'ignore'] })
  child.stdout?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[server] ${chunk.toString()}`)
  })
  return child
}
