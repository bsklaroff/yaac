import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { setDataDir } from '@yaac/shared/paths'

import type * as hostModule from '#drivers/containerless/host'

const mockDescendants = vi.hoisted(() => vi.fn())
const mockListening = vi.hoisted(() => vi.fn())
vi.mock('#drivers/containerless/host', async (importOriginal) => ({
  ...(await importOriginal<typeof hostModule>()),
  descendantPids: mockDescendants,
  listeningPorts: mockListening,
}))
import {
  _resetPortsForTests,
  sweepPorts,
  workspacePorts,
} from '#drivers/containerless/ports'
import {
  _resetRegistryForTests,
  observeLiveness,
  rememberWorkspace,
} from '#drivers/containerless/registry'

const UUID = '4bfc59c6-1e83-4dd0-80f1-735294d5d2bb'
let dataDir: string

function running(): void {
  rememberWorkspace({
    projectSlug: 'demo', worktreeId: UUID, tool: 'claude', mode: 'tui',
    prewarm: false, createdAtMs: 1_000, tmuxPid: 4242,
  })
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-cl-ports-'))
  setDataDir(dataDir)
  _resetRegistryForTests()
  _resetPortsForTests()
  mockDescendants.mockReset()
  mockListening.mockReset()
  mockDescendants.mockResolvedValue([4242, 5150])
  mockListening.mockResolvedValue([])
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('sweepPorts', () => {
  it('scans only the worktree\'s own process tree, not the host\'s', async () => {
    running()
    await sweepPorts()
    // A worktree's ports are its own tree's: every other listener on the
    // machine belongs to someone else and must never surface as this
    // worktree's.
    expect(mockDescendants).toHaveBeenCalledWith([4242])
    expect(mockListening).toHaveBeenCalledWith([4242, 5150])
  })

  it('surfaces a detected listener as an identity mapping', async () => {
    running()
    mockListening.mockResolvedValue([3000])
    await sweepPorts()
    // The workspace bound the host port itself, so there is nothing to
    // relay — the "mapping" is the port reaching itself, which is what
    // makes the webapp's link work with no forwarder behind it.
    expect(workspacePorts(UUID)).toEqual([{ containerPort: 3000, hostPort: 3000 }])
  })

  it('withholds ports that are a step toward RCE or data exposure', async () => {
    running()
    mockListening.mockResolvedValue([22, 5432, 9229, 3000])
    await sweepPorts()
    expect(workspacePorts(UUID)).toEqual([{ containerPort: 3000, hostPort: 3000 }])
  })

  it('reports a change only when the set really moved', async () => {
    running()
    mockListening.mockResolvedValue([3000])
    expect(await sweepPorts()).toBe(true)
    // An unchanged sweep must push no snapshot, or an idle host would
    // broadcast one every few seconds forever.
    expect(await sweepPorts()).toBe(false)
    mockListening.mockResolvedValue([3000, 5173])
    expect(await sweepPorts()).toBe(true)
  })

  it('drops a dead workspace\'s ports', async () => {
    running()
    mockListening.mockResolvedValue([3000])
    await sweepPorts()
    observeLiveness(UUID, false, { reason: 'agent-exited' })
    expect(await sweepPorts()).toBe(true)
    expect(workspacePorts(UUID)).toEqual([])
  })

  it('reports nothing for a workspace whose tmux pid was never recorded', async () => {
    // Without a tree root there is nothing to walk; the worktree still runs
    // fine, its ports just go unreported.
    rememberWorkspace({
      projectSlug: 'demo', worktreeId: UUID, tool: 'claude', mode: 'tui',
      prewarm: false, createdAtMs: 1_000,
    })
    await sweepPorts()
    expect(mockListening).not.toHaveBeenCalled()
    expect(workspacePorts(UUID)).toEqual([])
  })
})
