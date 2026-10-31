import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as childProcessModule from 'node:child_process'
import { apiError, fakeCluster } from '@yaac/test-utils/k8s-stub'

// `kubectl exec` (the ~/.npmrc rewrite) is the one child process.
type ExecCallback = (err: unknown, res?: { stdout: string; stderr: string }) => void
const execArgs: string[][] = []
const execFailure = vi.hoisted(() => ({ error: null as Error | null }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof childProcessModule>(),
  execFile: (_file: string, args: string[], _opts: unknown, cb: ExecCallback) => {
    execArgs.push(args)
    process.nextTick(() => { cb(execFailure.error, { stdout: '', stderr: '' }) })
  },
}))

import { claimSpareWorkspace, registerWorkspace, unmarkClaimedJobs } from '#drivers/k8s/workspaces/claim'
import { LABEL_INSTALL_ID, LABEL_PREWARMED, installId, k8sNamespace } from '#drivers/k8s/substrate'
import { LABEL_NPM_CACHE, NPM_CACHE_APP_NAME } from '#drivers/k8s/substrate/proxy-constants'
import type { WorkspaceRegistration } from '#drivers/contract'

/** A workspace pod of this install. */
function pod(workspaceId: string, labels: Record<string, string> = {}): Parameters<typeof fakeCluster.seed>[0] {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `yaac-proj-${workspaceId}-abcde`,
      namespace: k8sNamespace(),
      resourceVersion: '7',
      labels: {
        [LABEL_INSTALL_ID]: installId(),
        'batch.kubernetes.io/job-name': `yaac-proj-${workspaceId}`,
        'yaac.workspace-id': workspaceId,
        'yaac.project-id': '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c',
        ...labels,
      },
      creationTimestamp: '2026-06-01T00:00:00Z',
    },
    status: { phase: 'Running' },
  }
}

/** The spare's Job, which carries the pod's labels too. */
function job(workspaceId: string): Parameters<typeof fakeCluster.seed>[0] {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: `yaac-proj-${workspaceId}`,
      namespace: k8sNamespace(),
      labels: {
        [LABEL_INSTALL_ID]: installId(),
        [LABEL_PREWARMED]: 'true',
        'yaac.workspace-id': workspaceId,
        'yaac.project-id': '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c',
      },
      creationTimestamp: '2026-06-01T00:00:00Z',
    },
  }
}

/** The npm cache's EndpointSlice, ready or not. */
function cacheSlice(ready: boolean): Parameters<typeof fakeCluster.seed>[0] {
  return {
    apiVersion: 'discovery.k8s.io/v1',
    kind: 'EndpointSlice',
    metadata: {
      name: `${NPM_CACHE_APP_NAME}-x`,
      namespace: k8sNamespace(),
      labels: { 'kubernetes.io/service-name': NPM_CACHE_APP_NAME },
    },
    endpoints: [{ conditions: { ready } }],
  }
}

/** The merge patches written to pods. */
const podPatches = (): Array<{ name?: string; body?: Record<string, unknown> }> =>
  fakeCluster.callsOf('patch', 'Pod').map(({ name, body }) => ({ name, body }))

const labelsOf = (workspaceId: string, kind: 'Pod' | 'Job' = 'Pod'): Record<string, string> | undefined =>
  fakeCluster.get<{ metadata: { labels: Record<string, string> } }>(
    kind, kind === 'Pod' ? `yaac-proj-${workspaceId}-abcde` : `yaac-proj-${workspaceId}`,
  )?.metadata.labels

beforeEach(() => {
  execArgs.length = 0
  execFailure.error = null
  fakeCluster.seed(
    pod('other', { [LABEL_PREWARMED]: 'true' }), pod('s1', { [LABEL_PREWARMED]: 'true' }), job('other'), job('s1'),
    cacheSlice(true),
  )
})

describe('claimSpareWorkspace', () => {
  // The Job's mark outlives a dead pod, and a spare reap deletes the files
  // of a unit it finds marked, so the Job must lose it too.
  it('finds the spare by workspace id and drops its prewarmed mark from pod and Job', async () => {
    await claimSpareWorkspace('s1')
    for (const kind of ['Pod', 'Job'] as const) {
      expect(labelsOf('s1', kind)).not.toHaveProperty(LABEL_PREWARMED)
      // The other spare is untouched.
      expect(labelsOf('other', kind)?.[LABEL_PREWARMED]).toBe('true')
    }
  })

  it('refuses when no spare is left to claim, rather than reporting a claim', async () => {
    fakeCluster.reset()
    await expect(claimSpareWorkspace('s1')).rejects.toThrow(/no prewarmed spare/)
    // A pod that is no longer a spare is not one to claim either.
    fakeCluster.seed(pod('s1'))
    await expect(claimSpareWorkspace('s1')).rejects.toThrow(/no prewarmed spare/)
    expect(podPatches()).toEqual([])
  })

  // A selector only filters the listing, so two claimants could both win.
  // The fresh read and its resourceVersion make the API server reject the
  // second.
  it('writes under a compare-and-swap on the spare still being one', async () => {
    await claimSpareWorkspace('s1')
    expect(podPatches()).toEqual([{
      name: 'yaac-proj-s1-abcde',
      body: { metadata: { resourceVersion: '7', labels: { [LABEL_PREWARMED]: null } } },
    }])
  })

  // Losing the race fails the claim. It is not retried; the caller falls
  // back to a cold create.
  it('refuses a spare another claim took, whether before the read or at the write', async () => {
    fakeCluster.intercept((c) => {
      if (c.verb === 'read') fakeCluster.seed(pod('s1'))
    })
    await expect(claimSpareWorkspace('s1')).rejects.toThrow(/claimed by another caller/)

    fakeCluster.reset()
    fakeCluster.seed(pod('s1', { [LABEL_PREWARMED]: 'true' }), job('s1'))
    fakeCluster.intercept((c) => { if (c.verb === 'patch') throw apiError(409, 'the object has been modified') })
    await expect(claimSpareWorkspace('s1')).rejects.toThrow(/409/)
  })

  it('propagates a failed lookup', async () => {
    fakeCluster.intercept(() => { throw apiError(503, 'apiserver down') })
    await expect(claimSpareWorkspace('s1')).rejects.toThrow('apiserver down')
  })
})

describe('unmarkClaimedJobs', () => {
  // An older server's claim unlabelled only the pod. A Job with no pod left
  // could be a dead spare's, so only one whose pod reads as claimed loses
  // the label.
  it('unlabels the Job of a claimed pod, and leaves spares and podless Jobs alone', async () => {
    fakeCluster.seed(pod('claimed'), job('claimed'), job('podless'))

    await unmarkClaimedJobs()

    expect(labelsOf('claimed', 'Job')).not.toHaveProperty(LABEL_PREWARMED)
    for (const id of ['s1', 'other', 'podless']) expect(labelsOf(id, 'Job')?.[LABEL_PREWARMED]).toBe('true')
    await unmarkClaimedJobs()
    expect(fakeCluster.callsOf('patch', 'Job')).toHaveLength(1)
  })
})

describe('claimSpareWorkspace and the npm cache', () => {
  /** Seed the spare's pod (on the cache or not) and the cache's readiness. */
  function stage(opts: { admitted: boolean; serving: boolean }): void {
    fakeCluster.reset()
    execArgs.length = 0
    fakeCluster.seed(pod('s1', {
      [LABEL_PREWARMED]: 'true',
      ...(opts.admitted ? { [LABEL_NPM_CACHE]: 'true' } : {}),
    }), job('s1'), cacheSlice(opts.serving))
  }
  const execArgv = (): string[] | undefined => execArgs.find((a) => a[0] === 'exec')

  // The cache may have gone down since the spare was warmed.
  it('re-decides a spare\'s registry against the cache as it is at claim time', async () => {
    stage({ admitted: true, serving: false })
    await claimSpareWorkspace('s1')
    // In the background, off the claim's path.
    await vi.waitFor(() => expect(execArgv()).toBeDefined())
    const down = execArgv()!
    expect(down).toEqual(expect.arrayContaining(['exec', 'yaac-proj-s1-abcde', '--']))
    // No URL: the script only removes the cache's line.
    expect(down.at(-1)).toBe('')
    expect(down.join(' ')).toContain('registry=http://yaac-npm-cache')

    stage({ admitted: true, serving: true })
    await claimSpareWorkspace('s1')
    await vi.waitFor(() => expect(execArgv()!.at(-1)).toMatch(/^http:\/\/yaac-npm-cache\..*:4873\/$/))
  })

  it('leaves a spare the cache does not admit alone, and never fails a claim over it', async () => {
    stage({ admitted: false, serving: true })
    await claimSpareWorkspace('s1')
    await new Promise((r) => setTimeout(r, 20))
    expect(execArgv()).toBeUndefined()

    stage({ admitted: true, serving: true })
    execFailure.error = new Error('container not running')
    await expect(claimSpareWorkspace('s1')).resolves.toBeUndefined()
  })
})

describe('registerWorkspace', () => {
  const reg = (o: Partial<WorkspaceRegistration> = {}): WorkspaceRegistration => ({
    workspaceId: 's1',
    projectId: 'proj',
    owner: 'o',
    config: {},
    allowlist: { hosts: [], defaults: true },
    remoteUrl: 'https://github.com/example/repo.git',
    proxySecretRules: {},
    ...o,
  })
  /** The allowlist the registration handed the proxy. */
  const registeredHosts = (): string[] => {
    const cm = fakeCluster.callsOf('apply', 'ConfigMap')[0].body as { data: { 'registration.json': string } }
    return (JSON.parse(cm.data['registration.json']) as { allowedHosts: string[] }).allowedHosts
  }

  // If the cache still applies, only the registration is rewritten.
  it('writes the registration from the allowlist it is handed', async () => {
    await registerWorkspace(reg({ allowlist: { hosts: ['*'], defaults: false } }))

    expect(registeredHosts()).toEqual(['*'])
    expect(fakeCluster.callsOf('list')).toEqual([])
    expect(execArgs).toEqual([])
  })

  // The cache fetches outside the proxy, so a pod keeps npm access through
  // it until its cache label is removed.
  it('takes a pod off the npm cache once its allowlist stops admitting npmjs', async () => {
    fakeCluster.reset()
    fakeCluster.seed(pod('other', { [LABEL_NPM_CACHE]: 'true' }), pod('s1', { [LABEL_NPM_CACHE]: 'true' }))
    // ~/.npmrc first, so installs never use a cache the pod cannot reach.
    fakeCluster.intercept((c) => {
      if (c.verb === 'patch') expect(execArgs).toHaveLength(1)
    })
    await registerWorkspace(reg({ allowlist: { hosts: ['api.example.com'], defaults: false } }))

    expect(registeredHosts()).toEqual(['api.example.com'])
    const [exec] = execArgs
    expect(exec).toEqual(expect.arrayContaining(['yaac-proj-s1-abcde', '--']))
    expect(exec.at(-1)).toBe('')
    expect(labelsOf('s1')).not.toHaveProperty(LABEL_NPM_CACHE)
    expect(labelsOf('other')?.[LABEL_NPM_CACHE]).toBe('true')
  })

  it('revokes for a proxied npmjs secret too, and leaves a pod without the label alone', async () => {
    fakeCluster.reset()
    fakeCluster.seed(pod('s1'))
    await registerWorkspace(reg({
      allowlist: { hosts: ['*'], defaults: false },
      proxySecretRules: { NPM_TOKEN: { hosts: ['registry.npmjs.org'] } },
    }))

    expect(fakeCluster.callsOf('list', 'Pod')).toHaveLength(1)
    expect(podPatches()).toEqual([])
    expect(execArgs).toEqual([])
  })

  it('propagates a failed revocation', async () => {
    fakeCluster.reset()
    fakeCluster.seed(pod('s1', { [LABEL_NPM_CACHE]: 'true' }))
    fakeCluster.intercept((c) => { if (c.verb === 'patch') throw apiError(503, 'apiserver down') })
    await expect(registerWorkspace(reg({ allowlist: { hosts: ['api.example.com'], defaults: false } })))
      .rejects.toThrow('apiserver down')
  })
})
