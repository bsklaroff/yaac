import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import path from 'node:path'
import {
  requirePodman,
  requireCluster,
  useTestNamespace,
} from '@yaac/test-utils/setup'
import { e2eMkdtemp } from '@yaac/test-utils/tmp'
import { stageWorktreeBin, worktreeBinDir, WORKTREE_INIT_SCRIPT }
  from '@yaac/server/domain/worktrees/worktree-bin'
import { resolveTrustedLayers } from '@yaac/server/drivers/k8s/image-engine/image-builder'
import { ensureNamespace } from '@yaac/server/drivers/k8s/cluster/proxy-apply'
import { registryHasTag, registryRef } from '@yaac/server/drivers/k8s/container/registry'
import { runtimeClassSpec } from '@yaac/server/drivers/k8s/substrate/gvisor'
import { hostUidSecurityContext } from '@yaac/server/drivers/k8s/substrate'
// Setup values: the nested tier's volume, path and caps, so this pod is
// shaped like the one buildPodJobManifest emits without re-deriving them.
import {
  NESTED_ENGINE_CAPS,
  NESTED_GRAPHROOT_ANNOTATIONS,
  NESTED_GRAPHROOT_PATH,
  NESTED_GRAPHROOT_SIZELIMIT_BYTES,
  NESTED_GRAPHROOT_VOLUME,
} from '@yaac/server/drivers/k8s/substrate/pod-spec'
import {
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '@yaac/server/drivers/k8s/substrate/kubectl'

/**
 * The arbitrary-uid pattern, end to end (docs/arbitrary-uid-images.md): a
 * worktree pod running as a uid that appears nowhere in its image must still
 * be `yaac` in every way that matters — own its home, sudo to root, and be
 * found by name.
 *
 * This is the only automated evidence the machinery does anything. Every
 * other tier runs on a host whose uid is 1000, which is exactly the number
 * the image bakes, so the whole mechanism is a no-op there and a regression
 * would be invisible until someone installed on macOS. So the pod here is
 * pinned to a uid and gid that belong to NOBODY — not the image's 1000, not
 * group 0 — leaving the supplementary group 0 as the only thing that can
 * make the image's files writable.
 *
 * It runs the shipped `yaac-worktree-init` as its real postStart hook rather
 * than a copy of the interesting lines, so the passwd rewrite under test is
 * the one a worktree actually gets, and the hook's own `set -eu` means the
 * pod does not reach Ready unless the whole script survived at this uid.
 *
 * Nested, because the engine start is where the rewrite's subtlest property
 * shows up: it chowns the podman socket to `yaac` BY NAME, which lands on
 * the image's uid 1000 instead of on us if the entry were appended rather
 * than replaced.
 */

const ARBITRARY_UID = 4321
// Deliberately not 0 and not the image's 1000: if the pod could write its
// home through its primary group, this test would pass for the wrong reason.
const ARBITRARY_GID = 4322

const POD = `yaac-arbitrary-uid-${crypto.randomBytes(4).toString('hex')}`

let restoreNamespace: (() => void) | null = null

/** Run a shell command in the pod, returning its exit code with its output. */
async function sh(script: string, timeout = 60_000): Promise<{ exit: number; out: string }> {
  const { stdout } = await kubectlWithRetry([
    'exec', '-n', k8sNamespace(), POD, '--',
    'sh', '-c', `${script} 2>&1; printf '\nEXIT:%s\n' "$?"`,
  ], { timeout })
  const m = /EXIT:(\d+)\s*$/.exec(stdout)
  return { exit: m ? Number(m[1]) : -1, out: stdout.replace(/\nEXIT:\d+\s*$/, '').trim() }
}

/** Assert a command succeeded in the pod, and hand back its output. */
async function ok(script: string, timeout?: number): Promise<string> {
  const { exit, out } = await sh(script, timeout)
  expect(exit, `\`${script}\` failed in the pod:\n${out}`).toBe(0)
  return out
}

/**
 * The prebuilt nestable image, from the registry the node pulls from —
 * never a build. `test/global-setup.ts` puts it there under the same
 * content-hash tag this resolves.
 */
async function nestableImageRef(): Promise<string> {
  const { nestable } = await resolveTrustedLayers('yaac-test')
  if (!await registryHasTag(nestable.tag)) {
    throw new Error(
      `${nestable.tag} is not in the local registry — did test/global-setup.ts run?`,
    )
  }
  return registryRef(nestable.tag)
}

async function waitForPodReady(timeoutMs = 300_000): Promise<void> {
  interface RawPod {
    status?: {
      phase?: string
      conditions?: Array<{ type: string; status: string }>
      containerStatuses?: Array<{ state?: Record<string, { reason?: string; message?: string }> }>
    }
  }
  const deadline = Date.now() + timeoutMs
  let last = 'Pending'
  while (Date.now() < deadline) {
    const pod = await kubectlGetJson<RawPod>(['get', 'pod', POD, '-n', k8sNamespace()])
    last = pod?.status?.phase ?? 'Unknown'
    const ready = pod?.status?.conditions?.find((c) => c.type === 'Ready')
    // Ready is the gate, not Running: the postStart hook holds the Ready
    // transition, so this waits for yaac-worktree-init to have finished.
    if (ready?.status === 'True') return
    if (last === 'Failed' || last === 'Succeeded') {
      const state = JSON.stringify(pod?.status?.containerStatuses?.[0]?.state ?? {})
      throw new Error(`pod ${POD} reached ${last}: ${state}`)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  const events = await kubectlWithRetry(
    ['get', 'events', '-n', k8sNamespace(), '--field-selector', `involvedObject.name=${POD}`],
    { timeout: 30_000 },
  ).catch((err: Error) => ({ stdout: `events failed: ${err.message}` }))
  throw new Error(`pod ${POD} not Ready in ${timeoutMs}ms (phase ${last})\n${events.stdout}`)
}

beforeAll(async () => {
  await requirePodman()
  await requireCluster()
  restoreNamespace = useTestNamespace()
  await ensureNamespace()

  // The real staged script, mounted where a worktree pod gets it. Staging
  // is what a create does, and the File mount is how it lands on PATH.
  const binDir = await e2eMkdtemp('yaac-arbitrary-uid-')
  const staged = await stageWorktreeBin(worktreeBinDir(), binDir)
  expect(staged).toContain(WORKTREE_INIT_SCRIPT)

  await kubectlApply({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: POD,
      namespace: k8sNamespace(),
      labels: { 'yaac.test': 'true' },
      annotations: NESTED_GRAPHROOT_ANNOTATIONS,
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      ...runtimeClassSpec({ nested: true }),
      securityContext: {
        seccompProfile: { type: 'RuntimeDefault' },
        // The production identity, with the uid and gid swapped for ones
        // this cluster's host does not have. `supplementalGroups` is the
        // part under test and comes from the real helper.
        ...hostUidSecurityContext(),
        runAsUser: ARBITRARY_UID,
        runAsGroup: ARBITRARY_GID,
      },
      containers: [{
        name: 'worktree',
        image: await nestableImageRef(),
        imagePullPolicy: 'IfNotPresent',
        securityContext: { capabilities: { add: NESTED_ENGINE_CAPS } },
        env: [
          { name: 'YAAC_TOOL', value: 'claude' },
          { name: 'YAAC_GIT_NAME', value: 'Arbitrary Uid' },
          { name: 'YAAC_GIT_EMAIL', value: 'arbitrary@example.com' },
          { name: 'YAAC_STATUS_RIGHT', value: 'arbitrary-uid' },
          { name: 'YAAC_NESTED_ENGINE', value: '1' },
        ],
        lifecycle: {
          postStart: { exec: { command: [`/usr/local/bin/${WORKTREE_INIT_SCRIPT}`] } },
        },
        volumeMounts: [
          {
            name: 'worktree-bin',
            mountPath: `/usr/local/bin/${WORKTREE_INIT_SCRIPT}`,
            readOnly: true,
          },
          { name: NESTED_GRAPHROOT_VOLUME, mountPath: NESTED_GRAPHROOT_PATH },
          { name: 'tmux', mountPath: '/tmp/yaac-tmux' },
        ],
      }],
      volumes: [
        {
          name: 'worktree-bin',
          hostPath: { path: path.join(binDir, WORKTREE_INIT_SCRIPT), type: 'File' },
        },
        {
          name: NESTED_GRAPHROOT_VOLUME,
          emptyDir: { sizeLimit: String(NESTED_GRAPHROOT_SIZELIMIT_BYTES) },
        },
        // A real worktree gets a hostPath the server pre-created; an
        // emptyDir stands in, and the kubelet creates it 0777, so the tmux
        // socket dir needs no fsGroup. Leaving it off keeps this pod's
        // securityContext identical to what buildPodJobManifest stamps,
        // bar the two swapped ids.
        { name: 'tmux', emptyDir: {} },
      ],
    },
  })
  await waitForPodReady()
}, 600_000)

afterAll(async () => {
  await kubectlWithRetry(
    ['delete', 'pod', POD, '-n', k8sNamespace(), '--ignore-not-found', '--wait=false'],
    { timeout: 60_000 },
  ).catch(() => undefined)
  restoreNamespace?.()
})

describe('a worktree pod running as a uid no image knows', () => {
  it('answers to the yaac name, and to nothing else', async () => {
    expect(await ok('id -u')).toBe(String(ARBITRARY_UID))
    // getpwuid and getpwnam must resolve to each other. The rewrite REPLACES
    // the image's entry: a second `yaac` line would leave name lookups on
    // the first, and every `chown yaac` in the pod would miss.
    expect(await ok('id -un')).toBe('yaac')
    expect(await ok('getent passwd yaac')).toContain(`yaac:x:${ARBITRARY_UID}:${ARBITRARY_GID}`)
    expect(await ok('grep -c "^yaac:" /etc/passwd')).toBe('1')
    // The pod is in group 0 and NOT in the image's own group — group 0 is
    // doing all the work here.
    expect(await ok('id -G')).toContain('0')
    expect(await ok('id -g')).toBe(String(ARBITRARY_GID))
  })

  it('sudos to root and resolves an ssh identity', async () => {
    // The image's NOPASSWD line names the USER, so this is the passwd
    // rewrite's most load-bearing consumer: without it the agent cannot
    // install a package mid-worktree.
    expect(await ok('sudo -n id -u')).toBe('0')
    // ssh does not degrade without a passwd entry — it exits 255 with "No
    // user exists for uid", which would take out git over ssh entirely.
    await ok('ssh -G github.com >/dev/null')
  })

  it('owns its home: the shell, the agent CLIs and their config all work', async () => {
    await ok('touch ~/.arbitrary-uid-probe')
    await ok('mkdir -p ~/.cache/probe/nested && echo hi > ~/.cache/probe/nested/f')
    // npm writes ~/.npmrc 0600 regardless of umask, so this is a mode the
    // build had to fix rather than one the umask covered.
    await ok('npm config set fund false')
    await ok('git config --global user.name probe')
    // node and zsh both read the identity through getpwuid, not $HOME.
    expect(await ok('node -e "console.log(require(\'os\').userInfo().username)"')).toBe('yaac')
    expect(await ok('zsh -ic "print -P %n"')).toContain('yaac')
    // The agent CLIs are the reason the image exists.
    await ok('claude --version')
    await ok('codex --version')
  })

  it('leaves no directory in the image that the pod can neither own nor write', async () => {
    // The class of regression this guards: a tool that picks its own modes
    // (the Claude installer's 0700 ~/.claude/sessions did) leaves a
    // directory nothing can write at any uid but the image's own. It builds
    // fine and works on a uid-1000 host, which is every developer host.
    const stuck = await ok(
      `find "$HOME" -xdev -type d ! -perm -g+w ! -user ${ARBITRARY_UID} -printf '%M %p\\n'`,
      120_000,
    )
    expect(stuck).toBe('')
  })

  it('runs the nested engine, whose socket it is handed by name', async () => {
    // The engine is started by the hook in the background; the server gates
    // on `docker version` the same way.
    // `break`, never `exit`: the exec wrapper appends its own exit-code
    // marker, and an `exit` here would take the shell down before it printed.
    await ok(
      'for i in $(seq 1 60); do docker version >/dev/null 2>&1 && break; sleep 2; done; '
      + 'docker version >/dev/null',
      180_000,
    )
    // `chown yaac /run/podman/podman.sock` runs as root inside the engine
    // start script and resolves the NAME. It has to land on the uid this
    // pod is actually running as, which is only true because the rewrite
    // replaced the image's entry instead of adding one.
    expect(await ok('stat -c %u /run/podman/podman.sock')).toBe(String(ARBITRARY_UID))
  })
})
