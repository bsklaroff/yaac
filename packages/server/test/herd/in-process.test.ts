import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The substrate is the boundary this file mocks, and the only one: every
// method under test runs for real against it, which is the point — this is
// where the server's vocabulary meets Kubernetes', and a translation that
// drifts is invisible to any test that stubs the herd.
vi.mock('#platform/k8s/pods', async (importOriginal) => ({
  ...(await importOriginal<typeof podsModule>()),
  listSessionPods: vi.fn(),
}))
vi.mock('#platform/k8s/cluster-cache', () => ({ getActiveClusterCache: vi.fn(() => null) }))
vi.mock('#features/image-engine/image-builds', () => ({
  listImageBuilds: vi.fn(() => []),
  getImageBuildLog: vi.fn(() => undefined),
  dismissImageBuild: vi.fn(),
}))
vi.mock('#features/images/image-prewarm', () => ({
  retryImageBuild: vi.fn(),
  reconcileImagePrewarm: vi.fn(),
}))

// One reconcile step per module, faked so a pass can be driven without a
// substrate. Which steps a pass owes is the thing under test, so what each
// one does is beside the point — that it ran, and in what order, is not.
vi.mock('#features/sessions/stale-sessions', () => ({ reconcileStaleSessions: vi.fn() }))
vi.mock('#features/sessions/spawn-reconcile', () => ({ reconcileSpawnRequests: vi.fn() }))
vi.mock('#features/sessions/prewarm-reconcile', () => ({ reconcilePrewarmPool: vi.fn() }))
vi.mock('#features/sessions/salvage-reconcile', () => ({ reconcileImageSalvage: vi.fn() }))
vi.mock('#features/sessions/agent-session-registry', () => ({ reconcileAgentSessions: vi.fn() }))
vi.mock('#features/images/builder-pod', () => ({ reconcileBuilderPodGc: vi.fn() }))
vi.mock('#features/images/build-cache-gc', () => ({ reconcileBuildCacheGc: vi.fn() }))
vi.mock('#features/image-engine/image-gc', () => ({ reconcileHostImageGc: vi.fn() }))
vi.mock('#features/egress/proxy-reconcile', () => ({ reconcileProxySshKeys: vi.fn() }))
vi.mock('#features/egress/vcluster-attribution', () => ({ reconcileVclusterAttribution: vi.fn() }))
vi.mock('#features/cluster/vcluster-reconcile', () => ({ reconcileVclusters: vi.fn() }))
vi.mock('#features/cluster/project-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof projectRegistryModule>()),
  reconcileProjectRegistryGc: vi.fn(),
}))
vi.mock('#features/cluster/redirect-claim-reconcile', () => ({ reconcileRedirectClaims: vi.fn() }))
vi.mock('#platform/k8s/tick-snapshot', () => ({ createTickSnapshot: vi.fn(() => ({})) }))
const { ensureRunning } = vi.hoisted(() => ({
  ensureRunning: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('#features/egress/proxy-client', () => ({ proxyClient: { ensureRunning } }))

import { LABEL_PREWARMED, listSessionPods, type SessionPod } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import { getActiveClusterCache } from '#platform/k8s/cluster-cache'
import {
  _resetDeferredClusterBootForTests,
  armDeferredClusterBoot,
  awaitDeferredClusterBoot,
} from '#platform/k8s/deferred-boot'
import { retryImageBuild, reconcileImagePrewarm } from '#features/images/image-prewarm'
import type * as projectRegistryModule from '#features/cluster/project-registry'
import { reconcileStaleSessions } from '#features/sessions/stale-sessions'
import { reconcileSpawnRequests } from '#features/sessions/spawn-reconcile'
import { reconcilePrewarmPool } from '#features/sessions/prewarm-reconcile'
import { reconcileAgentSessions } from '#features/sessions/agent-session-registry'
import { reconcileBuilderPodGc } from '#features/images/builder-pod'
import { reconcileHostImageGc } from '#features/image-engine/image-gc'
import { reconcileProxySshKeys } from '#features/egress/proxy-reconcile'
import { reconcileVclusters } from '#features/cluster/vcluster-reconcile'
import { reconcileImageSalvage } from '#features/sessions/salvage-reconcile'
import { reconcileBuildCacheGc } from '#features/images/build-cache-gc'
import { reconcileProjectRegistryGc } from '#features/cluster/project-registry'
import { reconcileRedirectClaims } from '#features/cluster/redirect-claim-reconcile'
import { reconcileVclusterAttribution } from '#features/egress/vcluster-attribution'
import { createInProcessHerd } from '#herd'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

const mockList = vi.mocked(listSessionPods)
const mockCache = vi.mocked(getActiveClusterCache)
const mockRetry = vi.mocked(retryImageBuild)

function pod(over: Partial<SessionPod> = {}): SessionPod {
  return {
    podName: 'yaac-proj-abc123-xyz',
    jobName: 'yaac-proj-abc123',
    sessionId: 'abc123def456',
    projectSlug: 'proj',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 1_700_000_000_000,
    labels: {},
    ...over,
  } as SessionPod
}

/** A cluster cache whose session-pods informer is connected and seeded. */
function healthyCache(pods: SessionPod[]): ReturnType<typeof getActiveClusterCache> {
  return {
    healthy: (source: string) => source === 'session-pods',
    sessionPods: () => pods,
  } as unknown as ReturnType<typeof getActiveClusterCache>
}

describe('createInProcessHerd', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _resetDeferredClusterBootForTests()
    mockList.mockReset().mockResolvedValue([])
    mockCache.mockReset().mockReturnValue(null)
    mockRetry.mockReset()
    ensureRunning.mockClear()
  })

  afterEach(async () => {
    _resetDeferredClusterBootForTests()
    await cleanupTempDir(tmpDir)
  })

  describe('workspaces.find', () => {
    it('describes a match in the contract’s vocabulary, not the substrate’s', async () => {
      mockList.mockResolvedValue([pod({ tool: 'Claude', labels: { [LABEL_PREWARMED]: 'true' } })])
      expect(await createInProcessHerd().workspaces.find('abc123')).toEqual({
        workspaceId: 'abc123def456',
        projectSlug: 'proj',
        jobName: 'yaac-proj-abc123',
        // Normalized here so nothing above the boundary has to know that a
        // pod carries a raw label string.
        tool: 'claude',
        running: true,
        state: 'running',
        labels: { [LABEL_PREWARMED]: 'true' },
        createdAtMs: 1_700_000_000_000,
        prewarmed: true,
      })
    })

    it('answers undefined for no match', async () => {
      expect(await createInProcessHerd().workspaces.find('nope')).toBeUndefined()
    })

    it('reports a non-running pod with its lowercased phase', async () => {
      mockList.mockResolvedValue([pod({ phase: 'Pending', running: false })])
      expect(await createInProcessHerd().workspaces.find('abc123')).toMatchObject({
        running: false, state: 'pending',
      })
    })

    // The whole point of the cache: a polled endpoint resolves without paying
    // for a `kubectl get pods` subprocess.
    it('answers from the informer cache without listing, when asked to', async () => {
      mockCache.mockReturnValue(healthyCache([pod()]))
      const found = await createInProcessHerd().workspaces.find('abc123', { preferCache: true })
      expect(found?.jobName).toBe('yaac-proj-abc123')
      expect(mockList).not.toHaveBeenCalled()
    })

    // A pod reaches the cache via a watch event, so a just-created workspace
    // can be missing from it for a moment. Concluding "not found" there would
    // break the PTY attach that runs immediately after a create.
    it('falls back to a live listing when the cache does not have it yet', async () => {
      mockCache.mockReturnValue(healthyCache([]))
      mockList.mockResolvedValue([pod()])
      const found = await createInProcessHerd().workspaces.find('abc123', { preferCache: true })
      expect(found?.jobName).toBe('yaac-proj-abc123')
      expect(mockList).toHaveBeenCalledTimes(1)
    })

    // An unseeded or disconnected informer cannot be trusted for presence
    // either, so it is bypassed entirely rather than consulted.
    it('ignores an unhealthy cache and lists live', async () => {
      mockCache.mockReturnValue({
        healthy: () => false,
        sessionPods: () => { throw new Error('must not read an unhealthy cache') },
      } as unknown as ReturnType<typeof getActiveClusterCache>)
      mockList.mockResolvedValue([pod()])
      const found = await createInProcessHerd().workspaces.find('abc123', { preferCache: true })
      expect(found?.jobName).toBe('yaac-proj-abc123')
    })

    // Without the flag the cache is not consulted at all: a restart and a
    // detail render must not read a sub-second-stale tool label.
    it('does not consult the cache unless asked', async () => {
      mockCache.mockReturnValue(healthyCache([pod()]))
      mockList.mockResolvedValue([pod({ jobName: 'yaac-proj-live' })])
      const found = await createInProcessHerd().workspaces.find('abc123')
      expect(found?.jobName).toBe('yaac-proj-live')
    })

    // Distinct from "no match": a caller with a recorded row to fall back on
    // catches this, and one without lets it through to the client.
    it('surfaces a listing failure as RUNTIME_UNAVAILABLE', async () => {
      mockList.mockRejectedValue(new Error('connection refused'))
      await expect(createInProcessHerd().workspaces.find('abc123')).rejects.toMatchObject({
        code: 'RUNTIME_UNAVAILABLE',
      })
    })
  })

  describe('workspaces.list', () => {
    it('scopes to one project and maps each pod', async () => {
      mockList.mockResolvedValue([pod(), pod({ sessionId: 'other', jobName: 'yaac-proj-other' })])
      const listed = await createInProcessHerd().workspaces.list('proj')
      expect(mockList).toHaveBeenCalledWith('proj')
      expect(listed.map((w) => w.workspaceId)).toEqual(['abc123def456', 'other'])
    })

    it('surfaces a listing failure as RUNTIME_UNAVAILABLE', async () => {
      mockList.mockRejectedValue(new Error('connection refused'))
      await expect(createInProcessHerd().workspaces.list()).rejects.toMatchObject({
        code: 'RUNTIME_UNAVAILABLE',
      })
    })
  })

  describe('workspaces.counts', () => {
    it('counts per project, ignoring spares and unlabelled pods', async () => {
      mockList.mockResolvedValue([
        pod({ projectSlug: 'foo' }),
        pod({ projectSlug: 'foo' }),
        pod({ projectSlug: 'bar' }),
        pod({ projectSlug: 'bar', labels: { [LABEL_PREWARMED]: 'true' } }),
        pod({ projectSlug: '' }),
      ])
      expect(await createInProcessHerd().workspaces.counts()).toEqual({ foo: 2, bar: 1 })
    })

    // Unlike `list`, a count is a display detail: an unreachable substrate
    // reports zero rather than failing the project listing that wanted it.
    it('reports nothing when the substrate is unavailable', async () => {
      mockList.mockRejectedValue(new Error('connection refused'))
      expect(await createInProcessHerd().workspaces.counts()).toEqual({})
    })

    // A nested server whose deferred attach hasn't finished has no pods by
    // construction, so holding the first snapshot on a call to a still-waking
    // vcluster would be pure latency.
    it('answers empty without a substrate call while a deferred attach is pending', async () => {
      const boot = vi.fn().mockResolvedValue(undefined)
      armDeferredClusterBoot(boot)

      expect(await createInProcessHerd().workspaces.counts()).toEqual({})
      expect(mockList).not.toHaveBeenCalled()

      // The short-circuit still fires the attach — it just doesn't wait.
      await awaitDeferredClusterBoot()
      expect(boot).toHaveBeenCalledTimes(1)
    })
  })

  describe('workspaces.count', () => {
    // Spares included, unlike `counts`: a project's own detail page reports
    // what the substrate is running for it, warmed or not.
    it('counts one project’s pods, and zero when the substrate is unavailable', async () => {
      mockList.mockResolvedValue([pod(), pod({ labels: { [LABEL_PREWARMED]: 'true' } })])
      expect(await createInProcessHerd().workspaces.count('proj')).toBe(2)
      expect(mockList).toHaveBeenCalledWith('proj')

      mockList.mockRejectedValue(new Error('connection refused'))
      expect(await createInProcessHerd().workspaces.count('proj')).toBe(0)
    })
  })

  describe('images.retryBuild', () => {
    it('relays the outcome and leaves a project build to the feature', async () => {
      mockRetry.mockReturnValue({ retried: true, infra: false })
      expect(await createInProcessHerd().images.retryBuild('b1')).toEqual({ retried: true, infra: false })
      expect(ensureRunning).not.toHaveBeenCalled()
    })

    // An infra build has no owning project to rebuild through, so the herd
    // drives the sidecar rebuild itself — detached, since the caller gets its
    // 202 either way.
    it('rebuilds the proxy sidecar for an infra build', async () => {
      mockRetry.mockReturnValue({ retried: true, infra: true })
      expect((await createInProcessHerd().images.retryBuild('b1')).retried).toBe(true)
      await Promise.resolve()
      expect(ensureRunning).toHaveBeenCalledTimes(1)
    })

    it('does nothing for an unknown id', async () => {
      mockRetry.mockReturnValue({ retried: false, infra: true })
      expect((await createInProcessHerd().images.retryBuild('nope')).retried).toBe(false)
      expect(ensureRunning).not.toHaveBeenCalled()
    })
  })

  describe('lifecycle.reconcile', () => {
    beforeEach(() => {
      for (const step of [
        reconcileStaleSessions, reconcileSpawnRequests, reconcilePrewarmPool,
        reconcileAgentSessions, reconcileBuilderPodGc, reconcileImagePrewarm,
        reconcileHostImageGc, reconcileProxySshKeys, reconcileVclusters,
        reconcileImageSalvage, reconcileBuildCacheGc, reconcileProjectRegistryGc,
        reconcileRedirectClaims, reconcileVclusterAttribution,
      ]) vi.mocked(step).mockReset().mockResolvedValue(undefined)
    })

    // The reaper is the destructive step, and the one a poll exists for:
    // in-pod tmux death is not a substrate event, so nothing else would ever
    // dirty it.
    it('runs only the steps a trigger owes', async () => {
      await createInProcessHerd().lifecycle.reconcile({
        triggers: new Set(['poll']), resync: false,
      })
      expect(reconcileStaleSessions).toHaveBeenCalledTimes(1)
      expect(reconcileSpawnRequests).toHaveBeenCalledTimes(1)
      expect(reconcileProxySshKeys).toHaveBeenCalledTimes(1)
      // Not owed by a poll: a pod delta drives the sweep, and the hygiene
      // steps are throttled internally off the resync.
      expect(reconcileAgentSessions).not.toHaveBeenCalled()
      expect(reconcileBuilderPodGc).not.toHaveBeenCalled()
    })

    // The conversation sweep is the only step that reads the watcher's live
    // set, and for `acp` that set is where a conversation's id first appears —
    // out of an in-pod handshake no informer can see. Without this trigger the
    // row (and the webapp's chat pane) waits for the next resync.
    it('runs the conversation sweep when the live agent set changes', async () => {
      await createInProcessHerd().lifecycle.reconcile({
        triggers: new Set(['live-agents']), resync: false,
      })
      expect(reconcileAgentSessions).toHaveBeenCalledTimes(1)
      // And nothing else — asserted over every step this file mocks, not just
      // the destructive ones, so a future edit that hangs another step off
      // `live-agents` fails here rather than shipping. A set change says
      // nothing about pods, and the reaper and the vcluster GC both delete.
      for (const step of [
        reconcileStaleSessions, reconcileSpawnRequests, reconcilePrewarmPool,
        reconcileBuilderPodGc, reconcileImagePrewarm, reconcileHostImageGc,
        reconcileProxySshKeys, reconcileVclusters, reconcileImageSalvage,
        reconcileBuildCacheGc, reconcileProjectRegistryGc, reconcileRedirectClaims,
        reconcileVclusterAttribution,
      ]) expect(step).not.toHaveBeenCalled()
    })

    it('runs every step on a resync, whatever dirtied the pass', async () => {
      await createInProcessHerd().lifecycle.reconcile({
        triggers: new Set(), resync: true,
      })
      for (const step of [
        reconcileStaleSessions, reconcileSpawnRequests, reconcileAgentSessions,
        reconcileBuilderPodGc, reconcileImagePrewarm, reconcileHostImageGc,
        reconcileVclusters,
      ]) expect(step).toHaveBeenCalledTimes(1)
    })

    // A leaked builder's memory reservation is what stops the next build
    // from scheduling, and a spare's create joins builds already running, so
    // these three are ordered rather than merely present.
    it('keeps the GC → prewarm → pool order', async () => {
      const order: string[] = []
      vi.mocked(reconcileBuilderPodGc).mockImplementation(() => {
        order.push('gc')
        return Promise.resolve()
      })
      vi.mocked(reconcileImagePrewarm).mockImplementation(() => {
        order.push('prewarm')
        return Promise.resolve()
      })
      vi.mocked(reconcilePrewarmPool).mockImplementation(() => {
        order.push('pool')
        return Promise.resolve()
      })
      await createInProcessHerd().lifecycle.reconcile({ triggers: new Set(), resync: true })
      expect(order).toEqual(['gc', 'prewarm', 'pool'])
    })

    // A herd that stopped converging on one bad GC would be worse than one
    // that logs and carries on.
    it('isolates a step failure from the rest of the pass', async () => {
      vi.mocked(reconcileStaleSessions).mockRejectedValue(new Error('apiserver down'))
      await expect(createInProcessHerd().lifecycle.reconcile({
        triggers: new Set(), resync: true,
      })).resolves.toBeUndefined()
      expect(reconcileAgentSessions).toHaveBeenCalledTimes(1)
    })

    // The configured default is a preference row; a herd never looks one up,
    // and claude is what a create falls back to.
    it('hands the server’s default tool down to the pool, defaulting to claude', async () => {
      const herd = createInProcessHerd()
      await herd.lifecycle.reconcile({ triggers: new Set(), resync: true, defaultTool: 'codex' })
      expect(vi.mocked(reconcilePrewarmPool).mock.calls[0][0]).toBe('codex')
      await herd.lifecycle.reconcile({ triggers: new Set(), resync: true })
      expect(vi.mocked(reconcilePrewarmPool).mock.calls[1][0]).toBe('claude')
    })
  })
})
