import { describe, it, expect, vi, beforeEach } from 'vitest'

// kubectl is the only way this feature reaches the cluster or the node: the
// pod listing, the installer lookup and the exec all go through it, so
// everything below the boundary runs for real.
vi.mock('#drivers/k8s/substrate/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  dataDirHash: vi.fn(() => 'ddh0123456789abc'),
  k8sNamespace: vi.fn(() => 'test-ns'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn(),
}))

import { forceKillWorkspace } from '#drivers/k8s/worktrees'
import {
  FORCE_KILL_PREFIX,
  LABEL_DATA_DIR_HASH,
  LABEL_PROJECT,
  LABEL_TOOL,
  worktreeIdLabels,
} from '#drivers/k8s/substrate'
// Internal, for fixtures only: the kubelet's own job-name label.
import { JOB_NAME_LABEL } from '#drivers/k8s/substrate/pods'
import { kubectlGetJson, kubectlWithRetry } from '#drivers/k8s/substrate/kubectl'

const mockGetJson = vi.mocked(kubectlGetJson)
const mockKubectl = vi.mocked(kubectlWithRetry)

const UID = 'fb6d9922-62af-4356-841b-ef30e46506fd'
const target = { projectSlug: 'demo', workspaceId: 's1', unitName: 'yaac-demo-s1' }

function rawPod(opts: { terminating?: boolean; uid?: string | null; nodeName?: string } = {}): object {
  return {
    metadata: {
      name: 'yaac-demo-s1-x1y2z',
      labels: {
        [JOB_NAME_LABEL]: 'yaac-demo-s1',
        ...worktreeIdLabels('s1'),
        [LABEL_PROJECT]: 'demo',
        [LABEL_TOOL]: 'claude',
        [LABEL_DATA_DIR_HASH]: 'ddh0123456789abc',
      },
      creationTimestamp: '2026-06-01T00:00:00Z',
      ...(opts.terminating === false ? {} : { deletionTimestamp: '2026-06-01T00:10:00Z' }),
      ...(opts.uid === null ? {} : { uid: opts.uid ?? UID }),
    },
    spec: { nodeName: opts.nodeName ?? 'node-a' },
    status: { phase: 'Running' },
  }
}

function installers(...pods: Array<[namespace: string, name: string]>): object {
  return { items: pods.map(([namespace, name]) => ({ metadata: { name, namespace } })) }
}

/** The worktree listing answers the pod, the `-A` installer lookup the agents. */
function cluster(pod: object | null, agents: object): void {
  mockGetJson.mockImplementation((args) => Promise.resolve(
    args.includes('-A') ? agents : { items: pod ? [pod] : [] },
  ))
}

const KILLED = `${FORCE_KILL_PREFIX} sandbox pid=4242 id=eb1b\ngoroutine 1 [running]:\n${FORCE_KILL_PREFIX} killed pid=4242\n`

describe('forceKillWorkspace', () => {
  beforeEach(() => {
    mockGetJson.mockReset()
    mockKubectl.mockReset().mockResolvedValue({ stdout: KILLED, stderr: '' })
  })

  it('dumps the sandbox and kills it through the installer pod on the unit\'s node', async () => {
    cluster(rawPod(), installers(['yaac', 'yaac-gvisor-install-other'], ['test-ns', 'yaac-gvisor-install-own']))

    const outcome = await forceKillWorkspace(target)

    expect(outcome).toEqual({ forced: true, diagnostics: KILLED })
    // The installer is looked up by its label on the pod's own node, and
    // the one in this install's namespace is preferred over a borrowed one.
    expect(mockGetJson).toHaveBeenCalledWith([
      'get', 'pods', '-A', '-l', 'app=yaac-gvisor-install',
      '--field-selector', 'status.phase=Running,spec.nodeName=node-a',
    ])
    expect(mockKubectl).toHaveBeenCalledTimes(1)
    const [args, opts] = mockKubectl.mock.calls[0]
    expect(args.slice(0, 7)).toEqual([
      'exec', '-n', 'test-ns', 'yaac-gvisor-install-own', '--', 'sh', '-c',
    ])
    // The script is keyed by the pod's uid and nothing looser.
    expect(args[7]).toContain(`_${UID}/gvisor_panic.log`)
    expect(args[7]).toContain('kill -9')
    // One attempt: a kill is not something to retry behind the caller's back.
    expect(opts).toMatchObject({ maxAttempts: 1 })
  })

  it('refuses a unit whose delete has not been issued', async () => {
    cluster(rawPod({ terminating: false }), installers(['test-ns', 'agent']))

    const outcome = await forceKillWorkspace(target)

    expect(outcome).toEqual({ forced: false, reason: 'pod is not terminating' })
    expect(mockKubectl).not.toHaveBeenCalled()
  })

  it('answers unforced, without an exec, when there is no unit or no installer to reach it', async () => {
    cluster(null, installers(['test-ns', 'agent']))
    expect(await forceKillWorkspace(target)).toEqual({ forced: false, reason: 'no pod for the unit' })

    cluster(rawPod(), installers())
    expect((await forceKillWorkspace(target)).reason).toContain('no yaac-gvisor-install pod on node node-a')

    expect(mockKubectl).not.toHaveBeenCalled()
  })

  it('relays the script\'s own verdict when it found nothing to kill', async () => {
    cluster(rawPod(), installers(['test-ns', 'agent']))
    mockKubectl.mockResolvedValue({ stdout: `${FORCE_KILL_PREFIX} no sandbox process\n`, stderr: '' })

    const outcome = await forceKillWorkspace(target)

    expect(outcome.forced).toBe(false)
    expect(outcome.reason).toBe(`${FORCE_KILL_PREFIX} no sandbox process`)
  })

  it('never throws: a kubectl failure is an unforced outcome with the reason', async () => {
    cluster(rawPod(), installers(['test-ns', 'agent']))
    mockKubectl.mockRejectedValue(new Error('exec: connection refused'))

    await expect(forceKillWorkspace(target)).resolves.toEqual({
      forced: false, reason: 'exec: connection refused',
    })
  })
})
