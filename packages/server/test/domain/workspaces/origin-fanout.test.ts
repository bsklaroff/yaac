import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver, workspacePathsFixture } from '#test/support/fake-driver'
import type { RuntimeHandle } from '#drivers/contract'
import { propagateOrigin } from '#domain/workspaces'
import { clearPrewarmStateForTests, spareSettings } from '#domain/workspaces/prewarm'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { closeDb } from '#db/client'
import { repoDir } from '@yaac/shared/project-paths'
import { buildOriginRefreshExec } from '@yaac/shared/git'

const API = '0b0b0b0b-0000-4000-8000-000000000001'
const WEB = '0b0b0b0b-0000-4000-8000-000000000002'
const P = '0b0b0b0b-0000-4000-8000-0000000000a1'
const Q = '0b0b0b0b-0000-4000-8000-0000000000a2'

let tmpDir: string
const mockList = vi.fn<() => Promise<RuntimeHandle[]>>()
const mockExec = vi.fn<(jobName: string, cmd: string) => Promise<{ stdout: string; stderr: string }>>()

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  mockList.mockReset()
  mockExec.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
  installFakeWorkspaceDriver({ list: mockList, exec: mockExec })
})
afterEach(async () => {
  clearPrewarmStateForTests()
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

const running = (projectId: string, workspaceId: string): RuntimeHandle =>
  handleFixture({ jobName: `job-${workspaceId}`, workspaceId, projectId })
const refresh = (repoId: string, at: string): string =>
  buildOriginRefreshExec(`${repoDir(repoId)}/.git`, `${workspacePathsFixture().workspaceDir}${at}`)

describe('propagateOrigin', () => {
  it('refreshes origin in every running checkout of the repo, in any project and in a spare, where each sits', async () => {
    await recordWorkspaceCreated({ projectId: P, workspaceId: 'flat', repos: [{ repoId: API, path: '' }] })
    await recordWorkspaceCreated({ projectId: Q, workspaceId: 'nested', repos: [{ repoId: API, path: 'api' }, { repoId: WEB, path: 'web' }] })
    await recordWorkspaceCreated({ projectId: P, workspaceId: 'other', repos: [{ repoId: WEB, path: '' }] })
    await recordWorkspaceCreated({ projectId: P, workspaceId: 'going', repos: [{ repoId: API, path: '' }] })
    spareSettings.set('spare', { selection: { repos: [{ repo: API }], nested: true, cwd: '.' }, repos: [{ repoId: API, path: 'backend' }] })
    mockList.mockResolvedValue([
      running(P, 'flat'), running(Q, 'nested'), running(P, 'other'),
      { ...running(P, 'going'), terminating: true },
      { ...running(P, 'spare'), prewarmed: true },
    ])

    propagateOrigin(API)

    await vi.waitFor(() => expect(mockExec).toHaveBeenCalledTimes(3))
    expect(mockExec.mock.calls.map(([job, cmd]) => [job, cmd]).sort()).toEqual([
      ['job-flat', refresh(API, '')],
      ['job-nested', refresh(API, '/api')],
      ['job-spare', refresh(API, '/backend')],
    ].sort())
  })

  // A burst of fetches costs at most two rounds: the one running, and one
  // more for everything asked meanwhile.
  it('runs once more for requests that arrive during a round, however many', async () => {
    await recordWorkspaceCreated({ projectId: P, workspaceId: 'flat', repos: [{ repoId: API, path: '' }] })
    mockList.mockResolvedValue([running(P, 'flat')])
    let release = (): void => {}
    mockExec.mockImplementationOnce(() => new Promise((resolve) => { release = () => { resolve({ stdout: '', stderr: '' }) } }))

    propagateOrigin(API)
    await vi.waitFor(() => expect(mockExec).toHaveBeenCalledTimes(1))
    propagateOrigin(API)
    propagateOrigin(API)
    release()

    await vi.waitFor(() => expect(mockExec).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 50))
    expect(mockExec).toHaveBeenCalledTimes(2)
  })
})
