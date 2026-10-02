import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getProjectsDir } from '@yaac/shared/paths'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'

// /workspace/create streams NDJSON, so the `api` client returns the raw
// Response for `consumeNdjsonStream`.
const { mockPost, mockAttach } = vi.hoisted(() => ({ mockPost: vi.fn(), mockAttach: vi.fn() }))
vi.mock('#commands/api', () => ({
  api: { workspace: { create: { $post: mockPost } } },
}))
vi.mock('#commands/ws-terminal', () => ({ attachWorkspacePty: mockAttach }))

import { workspaceCreate } from '#commands/workspace-create'

function streamingResponse(events: object[]): { ok: true; body: ReadableStream<Uint8Array> } {
  const enc = new TextEncoder()
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const e of events) controller.enqueue(enc.encode(JSON.stringify(e) + '\n'))
        controller.close()
      },
    }),
  }
}

/**
 * The CLI shim: it POSTs the request, prints the server's progress, and
 * attaches to a tui workspace. What the server does with the request is
 * covered by the server's own tests.
 */
describe('workspaceCreate', () => {
  let tmpDir: string
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    // The CLI checks the project exists before any round-trip.
    await fs.mkdir(path.join(getProjectsDir(), 'demo'), { recursive: true })
    logSpy.mockClear()
    mockAttach.mockReset().mockResolvedValue(undefined)
    mockPost.mockReset().mockResolvedValue(streamingResponse([
      { type: 'progress', message: 'Fetching latest from remote...' },
      { type: 'progress', message: 'Creating session job yaac-demo-sess-123...' },
      { type: 'result', result: { workspaceId: 'sess-123', jobName: 'yaac-demo-sess-123', forwardedPorts: [], tool: 'claude' } },
    ]))
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('POSTs the request with unset options omitted, prints progress, and attaches', async () => {
    await workspaceCreate('demo', {})

    const [{ json }] = mockPost.mock.calls[0] as [{ json: Record<string, unknown> }]
    // Omitted so the server picks from what the project last used. The git
    // identity is a server setting, not a request field.
    expect(json).toMatchObject({ project: 'demo', tool: undefined })
    expect(json.gitUser).toBeUndefined()
    const logged = logSpy.mock.calls.map((args) => args[0] as unknown)
    expect(logged).toEqual(expect.arrayContaining([
      'Fetching latest from remote...', 'Creating session job yaac-demo-sess-123...',
    ]))
    expect(mockAttach).toHaveBeenCalledWith('sess-123', 'native')
  })

  it('forwards an explicit --tool, and does not attach to an acp workspace', async () => {
    // Its tmux window only runs acpd; attaching would show its log. The
    // server's answer decides, not the request.
    mockPost.mockResolvedValue(streamingResponse([
      { type: 'result', result: { workspaceId: 'sess-acp', jobName: 'j', forwardedPorts: [], tool: 'codex', mode: 'acp' } },
    ]))
    await workspaceCreate('demo', { tool: 'codex', mode: 'acp' })
    expect(mockPost.mock.calls[0]?.[0]).toMatchObject({ json: { tool: 'codex', mode: 'acp' } })
    expect(mockAttach).not.toHaveBeenCalled()
  })

  it('throws with the server error message when the stream carries an error event', async () => {
    mockPost.mockResolvedValue(streamingResponse([
      { type: 'progress', message: 'Fetching latest from remote...' },
      { type: 'error', error: { code: 'VALIDATION', message: 'no github token' } },
    ]))
    await expect(workspaceCreate('demo', {})).rejects.toThrow('no github token')
  })
})
