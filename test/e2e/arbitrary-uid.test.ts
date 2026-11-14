import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import path from 'node:path'
import { requireCluster, useTestNamespace } from '@yaac/test-utils/setup'
import { requirePodman } from '#support/cluster'
import { e2eMkdtemp } from '@yaac/test-utils/tmp'
import { waitForPod } from '#support/test-pods'
import { stageWorkspaceBin, workspaceBinDir, WORKSPACE_INIT_SCRIPT }
  from '@yaac/server/domain/workspaces/workspace-bin'
import { resolveTrustedLayers } from '@yaac/server/drivers/k8s/cluster/image-tags'
import { ensureNamespace } from '@yaac/server/drivers/k8s/cluster/proxy-apply'
import { registryRef, registryTagState } from '@yaac/server/drivers/k8s/cluster/registry'
import { RUNTIME_CLASS_GVISOR } from '@yaac/server/drivers/k8s/substrate/pod-spec'
import { installSecurityContext } from '@yaac/server/drivers/k8s/substrate'
import { applyObject, deleteObject, k8sNamespace } from '@yaac/server/drivers/k8s/substrate/api'
import { kubectl } from '@yaac/test-utils/kubectl'

/**
 * Arbitrary-uid images end to end (docs/arbitrary-uid-images.md): a
 * workspace pod running as a uid its image doesn't know must still act as
 * `yaac`: own its home, sudo to root, and be found by name.
 *
 * Other tiers run on hosts with uid 1000, the uid the image bakes in, so
 * they never exercise this. Here the uid and gid belong to nobody, leaving
 * the supplementary group 0 as the only way to write the image's files.
 *
 * The pod runs the shipped `yaac-workspace-init` as its postStart hook, and
 * the script's `set -eu` keeps the pod from reaching Ready if any step fails.
 */

const ARBITRARY_UID = 4321
// Not 0 and not the image's 1000, so the primary group can't be what makes
// the home writable.
const ARBITRARY_GID = 4322

const POD = `yaac-arbitrary-uid-${crypto.randomBytes(4).toString('hex')}`

let restoreNamespace: (() => void) | null = null

/** Run a shell command in the pod, returning its exit code with its output. */
async function sh(script: string, timeout = 60_000): Promise<{ exit: number; out: string }> {
  const { stdout } = await kubectl([
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
 * The prebuilt tools image, from the registry the node pulls from — never
 * a build. `test/global-setup.ts` puts it there under the same content-hash
 * tag this resolves.
 */
async function toolsImageRef(): Promise<string> {
  const { tools } = await resolveTrustedLayers('yaac-test')
  if (await registryTagState(tools.tag) !== 'present') {
    throw new Error(
      `${tools.tag} is not in the local registry — did test/global-setup.ts run?`,
    )
  }
  return registryRef(tools.tag)
}

beforeAll(async () => {
  await requirePodman()
  await requireCluster()
  restoreNamespace = useTestNamespace()
  await ensureNamespace()

  // The real staged script, mounted where a workspace pod gets it.
  const binDir = await e2eMkdtemp('yaac-arbitrary-uid-')
  const staged = await stageWorkspaceBin(workspaceBinDir(), binDir)
  expect(staged).toContain(WORKSPACE_INIT_SCRIPT)

  await applyObject({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: POD,
      namespace: k8sNamespace(),
      labels: { 'yaac.test': 'true' },
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      runtimeClassName: RUNTIME_CLASS_GVISOR,
      securityContext: {
        seccompProfile: { type: 'RuntimeDefault' },
        ...installSecurityContext({ uid: ARBITRARY_UID, gid: ARBITRARY_GID }),
      },
      containers: [{
        name: 'workspace',
        image: await toolsImageRef(),
        imagePullPolicy: 'IfNotPresent',
        env: [
          { name: 'YAAC_TOOL', value: 'claude' },
          { name: 'YAAC_GIT_NAME', value: 'Arbitrary Uid' },
          { name: 'YAAC_GIT_EMAIL', value: 'arbitrary@example.com' },
          { name: 'YAAC_STATUS_RIGHT', value: 'arbitrary-uid' },
        ],
        lifecycle: {
          postStart: { exec: { command: [`/usr/local/bin/${WORKSPACE_INIT_SCRIPT}`] } },
        },
        volumeMounts: [
          {
            name: 'workspace-bin',
            mountPath: `/usr/local/bin/${WORKSPACE_INIT_SCRIPT}`,
            readOnly: true,
          },
          { name: 'tmux', mountPath: '/tmp/yaac-tmux' },
        ],
      }],
      volumes: [
        {
          name: 'workspace-bin',
          hostPath: { path: path.join(binDir, WORKSPACE_INIT_SCRIPT), type: 'File' },
        },
        // Stands in for the server's pre-created hostPath. The kubelet
        // creates it 0777, so no fsGroup is needed.
        { name: 'tmux', emptyDir: {} },
      ],
    },
  })
  // The postStart hook holds back Ready, not Running.
  await waitForPod(POD, { ready: true, timeoutMs: 300_000 })
}, 600_000)

afterAll(async () => {
  await deleteObject({ apiVersion: 'v1', kind: 'Pod', name: POD, namespace: k8sNamespace() })
    .catch(() => undefined)
  restoreNamespace?.()
})

describe('a workspace pod running as a uid no image knows', () => {
  it('answers to the yaac name, and to nothing else', async () => {
    expect(await ok('id -u')).toBe(String(ARBITRARY_UID))
    // A second `yaac` passwd line would send name lookups to the image's
    // entry, and every `chown yaac` would miss.
    expect(await ok('id -un')).toBe('yaac')
    expect(await ok('getent passwd yaac')).toContain(`yaac:x:${ARBITRARY_UID}:${ARBITRARY_GID}`)
    expect(await ok('grep -c "^yaac:" /etc/passwd')).toBe('1')
    expect(await ok('id -G')).toContain('0')
    expect(await ok('id -g')).toBe(String(ARBITRARY_GID))
  })

  it('sudos to root and resolves an ssh identity', async () => {
    // The image's NOPASSWD sudoers line names the user, so it needs the
    // passwd entry.
    expect(await ok('sudo -n id -u')).toBe('0')
    // Without a passwd entry ssh exits 255 ("No user exists for uid").
    await ok('ssh -G github.com >/dev/null')
  })

  it('owns its home: the shell, the agent CLIs and their config all work', async () => {
    await ok('touch ~/.arbitrary-uid-probe')
    await ok('mkdir -p ~/.cache/probe/nested && echo hi > ~/.cache/probe/nested/f')
    // npm writes ~/.npmrc 0600 regardless of umask.
    await ok('npm config set fund false')
    await ok('git config --global user.name probe')
    // node and zsh both read the identity through getpwuid, not $HOME.
    expect(await ok('node -e "console.log(require(\'os\').userInfo().username)"')).toBe('yaac')
    expect(await ok('zsh -ic "print -P %n"')).toContain('yaac')
    await ok('claude --version')
    await ok('codex --version')
    // rustup's proxies resolve the toolchain through RUSTUP_HOME, which any
    // uid can read.
    await ok('rustc --version && cargo --version && cargo clippy --version && cargo fmt --version')
  })

  it('leaves no directory in the image that the pod can neither own nor write', async () => {
    // A tool that sets its own modes (e.g. a 0700 ~/.claude/sessions from
    // the Claude installer) leaves a dir only uid 1000 can write, which no
    // uid-1000 dev host would notice.
    const stuck = await ok(
      `find "$HOME" -xdev -type d ! -perm -g+w ! -user ${ARBITRARY_UID} -printf '%M %p\\n'`,
      120_000,
    )
    expect(stuck).toBe('')
  })
})
