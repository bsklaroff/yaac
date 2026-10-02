import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'

// Mock kubectl. Both entry points are stubbed because `kubectlGetJson` calls
// its module's `kubectlWithRetry` directly, bypassing a partial mock.
const mockKubectl = vi.hoisted(() => vi.fn())
const mockGetJson = vi.hoisted(() => vi.fn())
const mockApply = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  kubectlWithRetry: mockKubectl,
  kubectlGetJson: mockGetJson,
  kubectlApply: mockApply,
}))

import { claimSpareWorkspace, registerWorkspace } from '#drivers/k8s/workspaces/claim'
import { LABEL_PREWARMED, LABEL_TOOL } from '#drivers/k8s/substrate/pods'
import { LABEL_NPM_CACHE } from '#drivers/k8s/substrate/proxy-constants'
import type { WorkspaceRegistration } from '#drivers/contract'

/** A workspace pod as the install-wide listing returns it. */
function rawPod(workspaceId: string, labels: Record<string, string> = {}): unknown {
  return {
    metadata: {
      name: `yaac-proj-${workspaceId}-abcde`,
      labels: {
        'batch.kubernetes.io/job-name': `yaac-proj-${workspaceId}`,
        'yaac.workspace-id': workspaceId,
        'yaac.project': 'proj',
        'yaac.project-id': '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c',
        'yaac.tool': 'claude',
        ...labels,
      },
      creationTimestamp: '2026-06-01T00:00:00Z',
    },
    status: { phase: 'Running' },
  }
}

/** Serve the workspace pods, and (for a claim) the npm cache's readiness. */
function serve(pods: unknown[], cacheServing = true): void {
  mockGetJson.mockImplementation((args: string[]) => Promise.resolve(
    args[1] === 'endpointslices'
      ? { items: [{ endpoints: [{ conditions: { ready: cacheServing } }] }] }
      : { items: pods },
  ))
}

/** The argv of the write, if one was made. */
function patchArgv(): string[] | undefined {
  const call = mockKubectl.mock.calls.find(([args]) => (args as string[])[0] === 'patch')
  return call ? call[0] as string[] : undefined
}

/** The value of a flag in the argv, e.g. `-l`. */
function flag(args: string[], name: string): string {
  return args[args.indexOf(name) + 1]
}

/** The JSON-patch document the claim sent. */
function patchOps(): Array<{ op: string; path: string; value?: string }> {
  return JSON.parse(flag(patchArgv()!, '-p')) as Array<{ op: string; path: string; value?: string }>
}

beforeEach(() => {
  mockKubectl.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
  mockGetJson.mockReset()
  serve([rawPod('other', { [LABEL_PREWARMED]: 'true' }), rawPod('s1', { [LABEL_PREWARMED]: 'true' })])
  mockApply.mockReset().mockResolvedValue(undefined)
})

describe('claimSpareWorkspace', () => {
  it('finds the spare by workspace id, so the caller never needs a pod name', async () => {
    await claimSpareWorkspace('s1', 'codex')
    expect(patchArgv()).toContain('yaac-proj-s1-abcde')
  })

  it('refuses when no spare is left to claim, rather than reporting a claim', async () => {
    serve([])
    await expect(claimSpareWorkspace('s1', 'codex')).rejects.toThrow(/no prewarmed spare/)
    // A pod that is no longer a spare is not one to claim either.
    serve([rawPod('s1')])
    await expect(claimSpareWorkspace('s1', 'codex')).rejects.toThrow(/no prewarmed spare/)
    expect(patchArgv()).toBeUndefined()
  })

  // A selector only filters the listing, so two claimants could both win.
  // The JSON-patch `test` op makes the API server reject the second.
  it('writes under a compare-and-swap on the spare still being one', async () => {
    await claimSpareWorkspace('s1', 'codex')

    const ops = patchOps()
    expect(patchArgv()).toContain('--type=json')
    expect(ops[0]).toEqual({
      op: 'test', path: `/metadata/labels/${LABEL_PREWARMED}`, value: 'true',
    })
  })

  it('drops the prewarmed mark and stamps the claimed tool in the same write', async () => {
    await claimSpareWorkspace('s1', 'codex')

    const ops = patchOps()
    expect(ops).toContainEqual({ op: 'remove', path: `/metadata/labels/${LABEL_PREWARMED}` })
    expect(ops).toContainEqual({
      op: 'add', path: `/metadata/labels/${LABEL_TOOL}`, value: 'codex',
    })
  })

  // Always stamped, since workspaces spawned from this one read it.
  it('stamps the tool even when it already matches', async () => {
    await claimSpareWorkspace('s1', 'claude')
    expect(patchOps()).toContainEqual({
      op: 'add', path: `/metadata/labels/${LABEL_TOOL}`, value: 'claude',
    })
  })

  // Losing the race fails the whole patch. It is not retried; the caller
  // falls back to a cold create.
  it('propagates the rejected compare-and-swap when another claim won', async () => {
    mockKubectl.mockRejectedValue(Object.assign(
      new Error('the server rejected our request'),
      { stderr: 'Unprocessable Entity: the test operation failed' },
    ))

    await expect(claimSpareWorkspace('s1', 'codex'))
      .rejects.toThrow(/rejected our request/)
  })

  it('propagates a failed lookup', async () => {
    mockGetJson.mockRejectedValue(new Error('apiserver down'))
    await expect(claimSpareWorkspace('s1', 'codex')).rejects.toThrow('apiserver down')
  })
})

describe('claimSpareWorkspace and the npm cache', () => {
  /** Serve the spare's pod (on the cache or not) and the cache's readiness. */
  function stage(opts: { admitted: boolean; serving: boolean }): void {
    serve([rawPod('s1', {
      [LABEL_PREWARMED]: 'true',
      ...(opts.admitted ? { 'yaac.npm-cache': 'true' } : {}),
    })], opts.serving)
  }
  const execArgv = (): string[] | undefined =>
    mockKubectl.mock.calls.map(([a]) => a as string[]).find((a) => a[0] === 'exec')

  // The cache may have gone down since the spare was warmed.
  it('re-decides a spare\'s registry against the cache as it is at claim time', async () => {
    stage({ admitted: true, serving: false })
    await claimSpareWorkspace('s1', 'codex')
    const down = execArgv()!
    expect(down).toEqual(expect.arrayContaining(['exec', 'yaac-proj-s1-abcde', '--']))
    // No URL: the script only removes the cache's line.
    expect(down.at(-1)).toBe('')
    expect(down.join(' ')).toContain('registry=http://yaac-npm-cache')

    mockKubectl.mockClear()
    stage({ admitted: true, serving: true })
    await claimSpareWorkspace('s1', 'codex')
    expect(execArgv()!.at(-1)).toMatch(/^http:\/\/yaac-npm-cache\..*:4873\/$/)
  })

  it('leaves a spare the cache does not admit alone, and never fails a claim over it', async () => {
    stage({ admitted: false, serving: true })
    await claimSpareWorkspace('s1', 'codex')
    expect(execArgv()).toBeUndefined()

    stage({ admitted: true, serving: true })
    mockKubectl.mockImplementation((args: string[]) => args[0] === 'exec'
      ? Promise.reject(new Error('container not running'))
      : Promise.resolve({ stdout: '', stderr: '' }))
    await expect(claimSpareWorkspace('s1', 'codex')).resolves.toBeUndefined()
  })
})

describe('registerWorkspace', () => {
  const reg = (o: Partial<WorkspaceRegistration> = {}): WorkspaceRegistration => ({
    workspaceId: 's1',
    projectSlug: 'proj',
    tool: 'codex',
    config: {},
    remoteUrl: 'https://github.com/example/repo.git',
    proxySecretRules: {},
    ...o,
  })
  /** The allowlist the registration handed the proxy. */
  const registeredHosts = (): string[] => {
    const cm = mockApply.mock.calls[0][0] as { data: { 'registration.json': string } }
    return (JSON.parse(cm.data['registration.json']) as { allowedHosts: string[] }).allowedHosts
  }
  const kubectlVerbs = (): string[] => mockKubectl.mock.calls.map(([a]) => (a as string[])[0])

  // If the cache still applies, only the registration is rewritten.
  it('writes the registration from the config it is handed', async () => {
    await registerWorkspace(reg({ config: { setAllowedUrls: ['*'] } }))

    expect(registeredHosts()).toEqual(['*'])
    expect(mockGetJson).not.toHaveBeenCalled()
    expect(mockKubectl).not.toHaveBeenCalled()
  })

  // The cache fetches outside the proxy, so a pod keeps npm access through
  // it until its cache label is removed.
  it('takes a pod off the npm cache once its allowlist stops admitting npmjs', async () => {
    serve([rawPod('other', { [LABEL_NPM_CACHE]: 'true' }), rawPod('s1', { [LABEL_NPM_CACHE]: 'true' })])
    await registerWorkspace(reg({ config: { setAllowedUrls: ['api.example.com'] } }))

    expect(registeredHosts()).toEqual(['api.example.com'])
    // ~/.npmrc first, so installs never use a cache the pod cannot reach.
    expect(kubectlVerbs()).toEqual(['exec', 'label'])
    const [exec, label] = mockKubectl.mock.calls.map(([a]) => a as string[])
    expect(exec).toEqual(expect.arrayContaining(['yaac-proj-s1-abcde', '--']))
    expect(exec.at(-1)).toBe('')
    expect(label).toEqual(expect.arrayContaining(['yaac-proj-s1-abcde', `${LABEL_NPM_CACHE}-`]))
  })

  it('revokes for a proxied npmjs secret too, and leaves a pod without the label alone', async () => {
    serve([rawPod('s1')])
    await registerWorkspace(reg({
      config: { setAllowedUrls: ['*'] },
      proxySecretRules: { NPM_TOKEN: { hosts: ['registry.npmjs.org'] } },
    }))

    expect(mockGetJson).toHaveBeenCalledTimes(1)
    expect(mockKubectl).not.toHaveBeenCalled()
  })

  it('propagates a failed revocation', async () => {
    serve([rawPod('s1', { [LABEL_NPM_CACHE]: 'true' })])
    mockKubectl.mockImplementation((args: string[]) => args[0] === 'label'
      ? Promise.reject(new Error('apiserver down'))
      : Promise.resolve({ stdout: '', stderr: '' }))
    await expect(registerWorkspace(reg({ config: { setAllowedUrls: ['api.example.com'] } })))
      .rejects.toThrow('apiserver down')
  })
})
