import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import {
  requirePodman,
  requireCluster,
  useTestNamespace,
} from '@yaac/test-utils/setup'
import { resolveTrustedLayers } from '@yaac/server/drivers/k8s/image-engine/image-builder'
import { ensureNamespace } from '@yaac/server/drivers/k8s/cluster/proxy-apply'
import { registryHasTag, registryRef } from '@yaac/server/drivers/k8s/container/registry'
import { buildPodJobManifest, k8sWorkspacePaths } from '@yaac/server/drivers/k8s/substrate'
import { CODEX_CONTAINER_HOME, codexHomeMounts } from '@yaac/server/domain/workspaces/codex-home'
import { e2eMkdtemp } from '@yaac/test-utils/tmp'
import { applyObject, deleteObject, k8sNamespace } from '@yaac/server/drivers/k8s/substrate/api'
import { kubectl } from '@yaac/test-utils/kubectl'

/**
 * codex's sandbox inside a workspace pod (docs/permission-modes.md). Every
 * codex posture but `bypass` runs commands through bubblewrap with the
 * network unshared. gVisor gives a new network namespace an `lo` that
 * bubblewrap cannot configure, so the image ships a patched `bwrap`
 * (dockerfiles/Dockerfile.tools) that codex must keep choosing over its
 * own. A broken sandbox fails closed, so without this test it would only
 * show up as codex quietly reporting failed commands.
 *
 * Both gVisor tiers run the real workspace pod spec (`buildPodJobManifest`)
 * with the checkout mounted at /workspace and one shared codex home
 * (`codexHomeMounts`). `codex sandbox` takes the same code path as an
 * agent's commands and needs no credentials.
 */

const WORKSPACE = k8sWorkspacePaths().workspaceDir
const RUN = crypto.randomBytes(4).toString('hex')

const TIERS = [
  { tier: 'gvisor', nested: false, pod: `yaac-codex-sandbox-${RUN}` },
  { tier: 'gvisor-nested', nested: true, pod: `yaac-codex-sandbox-nested-${RUN}` },
]

let restoreNamespace: (() => void) | null = null
/** The project's codex home, shared by both pods. */
let codexDir = ''

/** Run a shell command in a pod, returning its exit code with its output. */
async function sh(pod: string, script: string): Promise<{ exit: number; out: string }> {
  const { stdout } = await kubectl([
    'exec', '-n', k8sNamespace(), pod, '--',
    'sh', '-c', `${script} 2>&1; printf '\nEXIT:%s\n' "$?"`,
  ], { timeout: 60_000 })
  const m = /EXIT:(\d+)\s*$/.exec(stdout)
  return { exit: m ? Number(m[1]) : -1, out: stdout.replace(/\nEXIT:\d+\s*$/, '').trim() }
}

/**
 * What a command can do from inside `codex sandbox -P <profile>`, run from
 * the checkout. Each line is printed only if its action succeeded, and the
 * last is the number of network interfaces the command sees — 1 (`lo`) when
 * the network namespace really was unshared.
 */
const PROBE = [
  'echo ran',
  `touch ${WORKSPACE}/f && echo wrote-checkout`,
  'touch "$HOME/outside" && echo wrote-home',
  'python3 -c "import socket; socket.socket()" && echo opened-socket',
  'echo interfaces $(grep -c : /proc/net/dev)',
].join('\n')

async function inSandbox(pod: string, profile: string): Promise<string> {
  const { out } = await sh(
    pod,
    `rm -f ${WORKSPACE}/f "$HOME/outside"; `
    + `codex sandbox -P ${profile} -C ${WORKSPACE} -- sh "$HOME/probe.sh"`,
  )
  return out
}

/**
 * The pod a workspace Job would run, minus the proxy-CA volume: its
 * ConfigMap lives in the install namespace and would leave the pod stuck in
 * ContainerCreating.
 */
async function workspacePod(pod: string, nested: boolean): Promise<Record<string, unknown>> {
  const { tools, nestable } = await resolveTrustedLayers('yaac-test')
  const tag = nested ? nestable.tag : tools.tag
  if (!await registryHasTag(tag)) {
    throw new Error(`${tag} is not in the local registry — did test/global-setup.ts run?`)
  }
  interface Template {
    metadata: Record<string, unknown>
    spec: {
      volumes: Array<{ name: string }>
      containers: Array<{ volumeMounts: Array<{ name: string }> }>
    }
  }
  const job = buildPodJobManifest({
    jobName: pod,
    namespace: k8sNamespace(),
    labels: { 'yaac.test': 'true' },
    image: registryRef(tag),
    env: [`CODEX_HOME=${CODEX_CONTAINER_HOME}`],
    mounts: [
      { source: { kind: 'emptyDir' }, mountPath: WORKSPACE },
      ...codexHomeMounts('k8s', codexDir),
    ],
    memoryRequestBytes: 256 * 1024 ** 2,
    memoryLimitBytes: 2 * 1024 ** 3,
    cpuRequestMillis: 100,
    cpuLimitMillis: 2000,
    ephemeralStorageRequestBytes: 1024 ** 3,
    ephemeralStorageLimitBytes: 4 * 1024 ** 3,
    proxyHost: '10.96.0.10',
    nested,
  }) as unknown as { spec: { template: Template } }
  const { metadata, spec } = job.spec.template
  spec.volumes = spec.volumes.filter((v) => v.name !== 'proxy-ca')
  for (const c of spec.containers) {
    c.volumeMounts = c.volumeMounts.filter((m) => m.name !== 'proxy-ca')
  }
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { ...metadata, name: pod, namespace: k8sNamespace() },
    spec,
  }
}

beforeAll(async () => {
  await requirePodman()
  await requireCluster()
  restoreNamespace = useTestNamespace()
  await ensureNamespace()
  codexDir = await e2eMkdtemp('yaac-codex-home-')

  const probe = Buffer.from(PROBE).toString('base64')
  await Promise.all(TIERS.map(async ({ pod, nested }) => {
    await applyObject(await workspacePod(pod, nested))
    await kubectl(
      ['wait', '--for=condition=Ready', `pod/${pod}`, '-n', k8sNamespace(), '--timeout=300s'],
      { timeout: 320_000 },
    )
    const setup = await sh(pod, `echo ${probe} | base64 -d > "$HOME/probe.sh"`)
    expect(setup.exit, setup.out).toBe(0)
  }))
}, 600_000)

afterAll(async () => {
  await Promise.all(TIERS.map(({ pod }) =>
    deleteObject({ apiVersion: 'v1', kind: 'Pod', name: pod, namespace: k8sNamespace() }).catch(() => undefined)))
  restoreNamespace?.()
})

describe.each(TIERS)("codex's sandbox in a $tier workspace pod", ({ pod }) => {
  it('runs read-only commands, and refuses every write and the network', async () => {
    const out = await inSandbox(pod, ':read-only')
    expect(out).toContain('ran')
    expect(out).not.toContain('wrote-checkout')
    expect(out).not.toContain('wrote-home')
    expect(out).not.toContain('opened-socket')
    expect(out).toContain('interfaces 1')
  })

  it('lets workspace commands write the checkout, and nothing past it or the network', async () => {
    const out = await inSandbox(pod, ':workspace')
    expect(out).toContain('ran')
    expect(out).toContain('wrote-checkout')
    expect(out).not.toContain('wrote-home')
    expect(out).not.toContain('opened-socket')
    expect(out).toContain('interfaces 1')
  })

  it('still needs the patched bwrap: the one codex bundles fails here', async () => {
    // Tripwire for the Dockerfile.tools bwrap stage (docs/permission-modes.md).
    const glob = '"$(npm root -g)"/@openai/codex/node_modules/@openai/codex-linux-*'
      + '/vendor/*/codex-resources/bwrap'
    const found = await sh(pod, `ls ${glob}`)
    expect(found.out, `codex no longer bundles bwrap at ${glob}; update this glob`)
      .toMatch(/\/bwrap$/)
    const { exit, out } = await sh(pod, `${found.out} --unshare-user --unshare-net --ro-bind / / -- true`)
    expect(exit, "codex's bundled bwrap now starts under gVisor, so gVisor or bubblewrap "
      + 'has been fixed: delete the bwrap stage in Dockerfile.tools, this case, the pin '
      + 'comment that points here, and the patched-bubblewrap paragraph in '
      + `docs/permission-modes.md\n${out}`).not.toBe(0)
    expect(out).toContain('loopback: Failed RTM_NEWADDR')
  })
})

describe('a project\'s codex pods', () => {
  it('leave each other\'s sandbox helper in place', async () => {
    // Each running codex holds a lock on its helper dir under
    // $CODEX_HOME/tmp/arg0, and each codex start deletes every dir whose lock
    // it can take. gVisor locks are per sandbox, so over a shared home the
    // other pod would delete this one's dir unless tmp is pod-local. The
    // long-running app-server (what codex-acp drives) holds the lock here.
    const [a, b] = TIERS.map((t) => t.pod)
    const arg0 = `${CODEX_CONTAINER_HOME}/tmp/arg0`
    // Clear the unlocked dirs the cases above left behind.
    const started = await sh(a, `rm -rf ${arg0}/*; `
      + 'setsid sh -c "sleep 300 | codex app-server" >/dev/null 2>&1 </dev/null & '
      + `for i in $(seq 1 30); do ls ${arg0} 2>/dev/null | grep -q . && break; sleep 1; done; ls ${arg0}`)
    const helper = started.out.split('\n').find((l) => l.startsWith('codex-arg0'))
    expect(helper, `no codex helper dir appeared in ${a}:\n${started.out}`).toBeDefined()

    const other = await sh(b, 'codex --version')
    expect(other.exit, other.out).toBe(0)

    const after = await sh(a, `ls ${arg0}`)
    expect(after.out, `codex starting in ${b} deleted ${a}'s helper`).toContain(helper)
  })
})
