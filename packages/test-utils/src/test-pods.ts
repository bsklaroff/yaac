/**
 * Bare pods the k8s e2e tiers start to probe the egress datapath without a
 * full workspace: the workspace label the proxy and netd select on, the
 * proxy CA for `curl --cacert`, and DNS pointed at the proxy.
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { applyObject, k8sNamespace, readObject } from '@yaac/server/drivers/k8s/substrate/api'
import { runtimeClassSpec } from '@yaac/server/drivers/k8s/substrate/gvisor'
import { CA_CONFIGMAP_NAME } from '@yaac/server/drivers/k8s/substrate/pod-spec'
import { workspaceIdLabels } from '@yaac/server/drivers/k8s/substrate/pods'
import { baseImageHash } from '@yaac/server/drivers/k8s/image-engine/image-builder'
import { registryHasTag, registryRef } from '@yaac/server/drivers/k8s/container/registry'
import { DOCKERFILES_DIR } from '@yaac/shared/project-paths'
import { kubectl } from '#kubectl'

const execFileAsync = promisify(execFile)

/**
 * The in-cluster ref of the `yaac-test-base` image, prebuilt and pushed by
 * `test/global-setup.ts`. A missing tag fails fast rather than building.
 */
export async function resolveTestBaseImageRef(): Promise<string> {
  const dockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.default')
  const tag = `yaac-test-base:${await baseImageHash(dockerfile)}`
  if (!await registryHasTag(tag)) {
    throw new Error(
      `${tag} is not in the local registry — did test/global-setup.ts run `
      + 'with the registry reachable?',
    )
  }
  return registryRef(tag)
}

/**
 * Wait for a pod to be Running, or with `ready` to pass its Ready condition
 * (which a postStart hook or readiness probe holds back). A pod that ends
 * fails the wait at once. Either failure carries the pod's phase, container
 * states and events, since that is where a stuck pull, a crash or a failed
 * hook shows.
 */
export async function waitForPod(
  name: string,
  opts: { ready?: boolean; timeoutMs?: number; namespace?: string } = {},
): Promise<void> {
  const { timeoutMs = 180_000, namespace = k8sNamespace() } = opts
  const waitArgs = (condition: string): string[] => [
    'wait', 'pod', name, '-n', namespace, `--for=${condition}`, `--timeout=${String(timeoutMs / 1000)}s`,
  ]
  const stopWatching = new AbortController()
  // Settles only when the pod reaches `phase`; its own errors are ignored.
  const ended = (phase: string): Promise<never> =>
    execFileAsync('kubectl', waitArgs(`jsonpath={.status.phase}=${phase}`), { signal: stopWatching.signal })
      .then(() => { throw new Error(`reached terminal phase ${phase}`) }, () => new Promise<never>(() => {}))
  try {
    await Promise.race([
      kubectl(
        waitArgs(opts.ready ? 'condition=Ready' : 'jsonpath={.status.phase}=Running'),
        { timeout: timeoutMs + 30_000 },
      ),
      ended('Failed'),
      ended('Succeeded'),
    ])
  } catch (err) {
    interface RawPod { status?: { phase?: string; containerStatuses?: Array<{ name: string; state?: unknown }> } }
    const pod = await readObject<RawPod>({ apiVersion: 'v1', kind: 'Pod', name, namespace }).catch(() => null)
    const states = (pod?.status?.containerStatuses ?? []).map((c) => `${c.name}: ${JSON.stringify(c.state)}`)
    const events = await kubectl(
      ['get', 'events', '-n', namespace, '--field-selector', `involvedObject.name=${name}`],
      { timeout: 30_000 },
    ).catch((e: Error) => ({ stdout: `events failed: ${e.message}` }))
    throw new Error(
      `pod ${name} never became ${opts.ready ? 'Ready' : 'Running'} (phase ${pod?.status?.phase ?? 'unknown'}): `
      + `${String(err)}\n${states.join('\n')}\n${events.stdout}`,
    )
  } finally {
    stopWatching.abort()
  }
}

/**
 * Start a bare workspace pod on the default runtime tier, as real session
 * pods run, and wait for it to be Running. `netRaw` moves it to the nested
 * tier with NET_RAW/NET_ADMIN; `env` and `emptyDirs` (volume name to mount
 * path) add to the session container.
 */
export async function startWorkspacePod(
  name: string,
  workspaceId: string,
  proxyHost: string,
  opts: {
    netRaw?: boolean
    env?: Array<{ name: string; value: string }>
    emptyDirs?: Record<string, string>
  } = {},
): Promise<void> {
  const emptyDirs = Object.entries(opts.emptyDirs ?? {})
  await applyObject({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: k8sNamespace(),
      labels: { ...workspaceIdLabels(workspaceId), 'yaac.test': 'true' },
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      ...runtimeClassSpec({ nested: opts.netRaw }),
      dnsPolicy: 'None',
      dnsConfig: { nameservers: [proxyHost] },
      containers: [{
        name: 'session',
        image: await resolveTestBaseImageRef(),
        imagePullPolicy: 'IfNotPresent',
        // The base image's ENTRYPOINT keeps the pod alive.
        ...(opts.netRaw
          ? { securityContext: { capabilities: { add: ['NET_RAW', 'NET_ADMIN'] } } }
          : {}),
        env: opts.env ?? [],
        volumeMounts: [
          { name: 'proxy-ca', mountPath: '/etc/yaac/certs', readOnly: true },
          ...emptyDirs.map(([volume, mountPath]) => ({ name: volume, mountPath })),
        ],
      }],
      volumes: [
        { name: 'proxy-ca', configMap: { name: CA_CONFIGMAP_NAME } },
        ...emptyDirs.map(([volume]) => ({ name: volume, emptyDir: {} })),
      ],
    },
  })
  await waitForPod(name)
}
