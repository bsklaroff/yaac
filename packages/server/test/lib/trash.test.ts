import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import type * as childProcess from 'node:child_process'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { globalPath } from '@yaac/shared/paths'
import { globalTrashDir, serverLocalTrashDir } from '@yaac/shared/project-paths'
import { emptyTrash, moveToTrash } from '#lib/trash'

/*
 * `rm` runs for real. Setting `hold` makes the next spawn wait until the
 * test calls the release it leaves in `released`, so a case can trash
 * something while a run is in progress.
 */
const rm = vi.hoisted(() => ({ hold: false, released: undefined as (() => void) | undefined, calls: 0 }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>()
  const spawn = (cmd: string, args: string[], opts: childProcess.SpawnOptions): EventEmitter => {
    rm.calls++
    if (!rm.hold) return actual.spawn(cmd, args, opts)
    rm.hold = false
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
    rm.released = () => {
      actual.spawn(cmd, args, opts).on('close', (code) => child.emit('close', code))
    }
    return child
  }
  return { ...actual, spawn }
})

let tmp: string
beforeEach(async () => {
  tmp = await createTempDataDir()
  rm.calls = 0
})
afterEach(async () => { await cleanupTempDir(tmp) })

async function tree(dir: string): Promise<string> {
  await fs.mkdir(path.join(dir, 'a', 'b'), { recursive: true })
  await fs.writeFile(path.join(dir, 'a', 'b', 'file'), 'x')
  return dir
}

describe('moveToTrash', () => {
  it('takes a directory away at once and empties the trash behind it', async () => {
    const dir = await tree(globalPath('repos', 'doomed'))
    await moveToTrash(dir, globalTrashDir())
    await expect(fs.access(dir)).rejects.toThrow()
    // One already gone is not an error.
    await moveToTrash(dir, globalTrashDir())
    await emptyTrash()
    expect(await fs.readdir(globalTrashDir())).toEqual([])
  })
})

describe('emptyTrash', () => {
  it("removes what a crash left in either tier's trash, and what was trashed while it ran", async () => {
    await tree(path.join(globalTrashDir(), 'left-over'))
    await tree(path.join(serverLocalTrashDir(), 'left-over'))
    rm.hold = true
    const running = emptyTrash()
    await vi.waitFor(() => expect(rm.released).toBeDefined())
    await tree(path.join(serverLocalTrashDir(), 'meanwhile'))
    expect(emptyTrash()).toBe(running)
    rm.released!()
    await running
    expect(rm.calls).toBe(2)
    expect(await fs.readdir(globalTrashDir())).toEqual([])
    expect(await fs.readdir(serverLocalTrashDir())).toEqual([])
  })
})
