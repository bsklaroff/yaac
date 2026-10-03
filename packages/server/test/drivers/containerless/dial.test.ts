import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { setDataDir } from '@yaac/shared/paths'
import { workspaceDir } from '@yaac/shared/project-paths'
import { dialCtrlStream } from '#drivers/containerless/dial'
import { containerlessJobName } from '#drivers/containerless/paths'

const UUID = '7d3c1f0a-5b2e-4c8d-9a6f-1e2b3c4d5e6f'
const JOB = containerlessJobName('demo', UUID)
let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-cl-dial-'))
  setDataDir(dataDir)
  fs.mkdirSync(workspaceDir('demo', UUID), { recursive: true })
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('dialCtrlStream', () => {
  it('survives a write to a child that stopped reading, reporting the end as exit', async () => {
    // The child closes its stdin but lives on, which is the window between
    // a tmux client dying and its exit being handled. A write there raises
    // EPIPE on stdin; unhandled, vitest fails the run as it would crash the
    // server.
    const child = dialCtrlStream(JOB, ['sh', '-c', 'exec 0<&-; sleep 0.3'])
    const exited = new Promise<unknown>((resolve) => child.on('exit', resolve))
    await new Promise((r) => setTimeout(r, 100))
    child.stdin?.write('list-windows\n')
    expect(await exited).toBe(0)
  })
})
