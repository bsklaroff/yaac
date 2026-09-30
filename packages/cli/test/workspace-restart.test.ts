import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installRealWorkspaceDriver } from '@yaac/test-utils/real-driver'

// The CLI shim's own collaborators. Only the `workspaceRestart` describe below
// uses these; the pipeline describes drive the server modules directly.
// Hoisted with the vi.mock calls, which run before any import.
const { attachSpy, postSpy, consumeSpy } = vi.hoisted(() => ({
  attachSpy: vi.fn().mockResolvedValue(undefined),
  postSpy: vi.fn().mockResolvedValue({}),
  consumeSpy: vi.fn(),
}))
vi.mock('#commands/ws-terminal', () => ({ attachWorkspacePty: attachSpy }))
vi.mock('#commands/api', () => ({ api: { workspace: { restart: { $post: postSpy } } } }))
vi.mock('@yaac/shared/ndjson', () => ({ consumeNdjsonStream: consumeSpy }))
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import * as pods from '@yaac/server/drivers/k8s/substrate/pods'
import * as cleanup from '@yaac/server/domain/workspaces/cleanup'
import * as workspaceCreate from '@yaac/server/domain/workspaces/create'
import { resolveRestartTarget, restartWorkspace } from '@yaac/server/domain/workspaces/restart'
import { recordWorkspaceCreated } from '@yaac/server/db/workspace-store'
import { createWorkspaceGroup } from '@yaac/server/db/group-store'
import { recordAgentSessions, setActiveAgentSessions } from '@yaac/server/db/agent-session-store'
import { closeDb } from '@yaac/server/db/client'
import { workspaceRestart } from '#commands/workspace-restart'
import { clearAllProvisioningForTests } from '@yaac/server/domain/workspaces/provisioning'

import type { PodInfo } from '@yaac/server/drivers/k8s/substrate/pods'

/**
 * Unit coverage for the session-restart pipeline: target resolution
 * (live workspace first, recorded row for reaped ones) and the handoff to
 * teardown + create. The real implementations stand behind the
 * boundary so the whole pipeline runs; only its substrate leaves are mocked,
 * so we don't need a cluster.
 */
function pod(overrides: Partial<PodInfo> = {}): PodInfo {
  return {
    jobName: 'yaac-demo-abcd1234',
    podName: 'yaac-demo-abcd1234-p0d42',
    workspaceId: 'abcd1234',
    projectSlug: 'demo',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 1_700_000_000_000,
    labels: {},
    ...overrides,
  }
}

describe('resolveRestartTarget', () => {
  let tmpDir: string
  let listSpy: ReturnType<typeof vi.fn<() => Promise<PodInfo[]>>>

  beforeEach(async () => {
    // The real driver, with only its pod listing mocked: this file is about
    // the resolve-then-restart pipeline, so nothing in it may be faked.
    installRealWorkspaceDriver()
    tmpDir = await createTempDataDir()
    listSpy = vi.fn()
    vi.spyOn(pods, 'listWorkspacePods').mockImplementation(
      listSpy as unknown as typeof pods.listWorkspacePods,
    )
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('resolves from a live pod by exact session id', async () => {
    listSpy.mockResolvedValueOnce([pod()])
    const info = await resolveRestartTarget('abcd1234')
    expect(info).toEqual({
      projectSlug: 'demo',
      workspaceId: 'abcd1234',
      tool: 'claude',
      jobName: 'yaac-demo-abcd1234',
    })
  })

  it('resolves tool=codex from the pod label', async () => {
    listSpy.mockResolvedValueOnce([pod({ tool: 'codex' })])
    const info = await resolveRestartTarget('abcd1234')
    expect(info.tool).toBe('codex')
  })

  it('resolves tool=opencode from the pod label', async () => {
    listSpy.mockResolvedValueOnce([pod({ tool: 'opencode' })])
    const info = await resolveRestartTarget('abcd1234')
    expect(info.tool).toBe('opencode')
  })

  it('resolves from a live pod by a workspace-id prefix its row expands', async () => {
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'abcd1234' })
    listSpy.mockResolvedValueOnce([pod()])
    const info = await resolveRestartTarget('abcd')
    expect(info.workspaceId).toBe('abcd1234')
    expect(info.jobName).toBe('yaac-demo-abcd1234')
  })

  it('falls back to the recorded session row for a reaped session', async () => {
    listSpy.mockResolvedValueOnce([])
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'deadbeefdeadbeef' })
    const info = await resolveRestartTarget('deadbeefdeadbeef')
    expect(info).toEqual({
      projectSlug: 'demo',
      workspaceId: 'deadbeefdeadbeef',
      tool: 'claude',
      jobName: null,
    })
  })

  it('takes the tool from the row, for a tool that leaves no transcript', async () => {
    listSpy.mockResolvedValueOnce([])
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'ocsess' })
    // The tool comes from the workspace's first conversation, which create
    // records alongside the row — a workspace has no tool of its own.
    await recordAgentSessions('demo', 'ocsess', [
      { tool: 'opencode', agentSessionId: 'ocsess' },
    ])
    const info = await resolveRestartTarget('ocsess')
    expect(info.tool).toBe('opencode')
    expect(info.jobName).toBeNull()
  })

  it('resolves a recorded session by id prefix, across projects', async () => {
    listSpy.mockResolvedValueOnce([])
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'abcd1234ffff' })
    const info = await resolveRestartTarget('abcd')
    expect(info.workspaceId).toBe('abcd1234ffff')
    expect(info.projectSlug).toBe('demo')
  })

  // The sidebar group is the row's, never the pod's — the substrate knows
  // nothing about it — and the restart carries it so the provisioning row
  // renders in that section instead of at the top of the list.
  it('carries the group the recorded row is filed under', async () => {
    listSpy.mockResolvedValueOnce([])
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'grouped1' })
    const group = await createWorkspaceGroup('demo', 'Reviews', 'grouped1')
    const info = await resolveRestartTarget('grouped1')
    expect(info.groupId).toBe(group.groupId)
  })

  it('throws NOT_FOUND when no pod and no recorded session match', async () => {
    listSpy.mockResolvedValueOnce([])
    await expect(resolveRestartTarget('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('falls through to the recorded row when the cluster is unavailable', async () => {
    listSpy.mockRejectedValueOnce(new Error('connection refused'))
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'xyz' })
    const info = await resolveRestartTarget('xyz')
    expect(info).toEqual({
      projectSlug: 'demo',
      workspaceId: 'xyz',
      tool: 'claude',
      jobName: null,
    })
  })
})

describe('restartWorkspace', () => {
  let tmpDir: string
  let listSpy: ReturnType<typeof vi.fn<() => Promise<PodInfo[]>>>
  let cleanupSpy: ReturnType<typeof vi.fn>
  let createSpy: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    installRealWorkspaceDriver()
    clearAllProvisioningForTests()
    tmpDir = await createTempDataDir()
    listSpy = vi.fn()
    cleanupSpy = vi.fn().mockResolvedValue(undefined)
    createSpy = vi.fn().mockResolvedValue({
      workspaceId: 'abcd1234',
      jobName: 'yaac-demo-abcd1234',
      forwardedPorts: [],
      tool: 'claude',
    })
    vi.spyOn(pods, 'listWorkspacePods').mockImplementation(
      listSpy as unknown as typeof pods.listWorkspacePods,
    )
    vi.spyOn(cleanup, 'teardownForRestart').mockImplementation(
      cleanupSpy as unknown as typeof cleanup.teardownForRestart,
    )
    vi.spyOn(workspaceCreate, 'createWorkspace').mockImplementation(
      createSpy as unknown as typeof workspaceCreate.createWorkspace,
    )
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    // A restart holds its id against the reaper for the whole of itself, so
    // the entry outlives a case that stopped short of the create returning.
    clearAllProvisioningForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('kills the live job first, then creates a resumed session', async () => {
    listSpy.mockResolvedValueOnce([pod()])

    const progress: string[] = []
    await restartWorkspace('abcd1234', { onProgress: (m) => progress.push(m) })

    expect(cleanupSpy).toHaveBeenCalledWith({
      jobName: 'yaac-demo-abcd1234',
      projectSlug: 'demo',
      workspaceId: 'abcd1234',
    })
    expect(createSpy).toHaveBeenCalledWith('demo', expect.objectContaining({
      resume: true,
      workspaceId: 'abcd1234',
      tool: 'claude',
      // Nothing was recorded as active, so there is nothing to resume by id —
      // the workspace comes back with one fresh conversation.
      resumeAgentSessions: [],
    }))
    expect(progress.some((m) => m.includes('Stopping session job yaac-demo-abcd1234'))).toBe(true)
  })

  it('has nothing to tear down when no pod exists, and falls back to the recorded row', async () => {
    listSpy.mockResolvedValueOnce([])
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'deadbeef' })

    await restartWorkspace('deadbeef')

    // Still one teardown call, with no Job to delete: the reuse-blocking
    // marks have to be cleared either way or the fresh session renders as
    // "stopping…".
    expect(cleanupSpy).toHaveBeenCalledWith({
      jobName: null, projectSlug: 'demo', workspaceId: 'deadbeef',
    })
    expect(createSpy).toHaveBeenCalledWith('demo', expect.objectContaining({
      resume: true,
      workspaceId: 'deadbeef',
      tool: 'claude',
    }))
  })

  it('hands create every active conversation in window order, codex\'s pin included', async () => {
    // Dropping the pin here would shift conv-2 into the `yaac:codex` primary
    // window; create is what knows never to `codex resume` it.
    listSpy.mockResolvedValueOnce([])
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'cafe1234' })
    const sessions = [
      { tool: 'codex' as const, agentSessionId: 'cafe1234' },
      { tool: 'claude' as const, agentSessionId: 'conv-2' },
    ]
    await recordAgentSessions('demo', 'cafe1234', sessions)
    await setActiveAgentSessions('demo', 'cafe1234', sessions)

    await restartWorkspace('cafe1234')

    expect(createSpy).toHaveBeenCalledWith('demo', expect.objectContaining({
      tool: 'codex',
      resumeAgentSessions: [
        expect.objectContaining({ tool: 'codex', agentSessionId: 'cafe1234' }),
        expect.objectContaining({ tool: 'claude', agentSessionId: 'conv-2' }),
      ],
    }))
  })
})

describe('workspaceRestart (CLI shim)', () => {
  beforeEach(() => {
    attachSpy.mockClear()
    postSpy.mockClear()
  })

  it('attaches a terminal to a restarted tui workspace', async () => {
    consumeSpy.mockResolvedValueOnce({ workspaceId: 'w1', jobName: 'j1', mode: 'tui' })
    await expect(workspaceRestart('w1')).resolves.toBe('w1')
    expect(attachSpy).toHaveBeenCalledWith('w1', 'native')
  })

  it('does not attach a terminal to a restarted acp workspace', async () => {
    // An ACP workspace's agent window runs acpd, so attaching drops the user
    // into the supervisor's stdio and sits there — create already refuses for
    // this reason, and a restart has to refuse identically or the CLI hangs
    // until the attach times out.
    consumeSpy.mockResolvedValueOnce({ workspaceId: 'w2', jobName: 'j2', mode: 'acp' })
    await expect(workspaceRestart('w2')).resolves.toBe('w2')
    expect(attachSpy).not.toHaveBeenCalled()
  })

  it('attaches when the server reports no mode at all', async () => {
    // A server that predates the field: tui is what every pre-ACP workspace
    // ran, so the old behaviour is the right fallback.
    consumeSpy.mockResolvedValueOnce({ workspaceId: 'w3', jobName: 'j3' })
    await expect(workspaceRestart('w3')).resolves.toBe('w3')
    expect(attachSpy).toHaveBeenCalledWith('w3', 'native')
  })
})
