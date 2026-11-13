import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'

// Only the clone (a process boundary) is mocked, so a test can hold it open
// and feed it git's progress.
vi.mock('#domain/git', async (importOriginal) => ({
  ...(await importOriginal<typeof gitModule>()),
  cloneRepo: vi.fn(),
}))

import { cloneRepo } from '#domain/git'
import type * as gitModule from '#domain/git'
import { addProject, createHostedProject, dismissProjectAdd, listProjectAdds } from '#domain/projects'
import { systemPrincipal } from '#domain/access'
import { addHttpsCredential } from '#domain/auth'
import { BUILT_IN_USER_ID, closeDb, getProjectRow } from '#db'
import { _resetWorkspaceListChangedForTests, onWorkspaceListChanged } from '#lib/notify'
import type { GitProgress } from '@yaac/shared/types'

const mockClone = vi.mocked(cloneRepo)
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const ADDING = '3e2d1c0b-9a8f-4e7d-8c6b-5a4f3e2d1c0b'
const URL = 'https://github.com/acme/widgets.git'

let tmpDir: string
let token: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  installFakeWorkspaceDriver()
  token = (await addHttpsCredential(BUILT_IN_USER_ID, { name: 'default', token: 'ghp_default' })).id
  mockClone.mockReset()
})

afterEach(async () => {
  for (const add of listProjectAdds()) dismissProjectAdd(systemPrincipal, add.id)
  _resetWorkspaceListChangedForTests()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** Start an add whose clone waits for `finish`, reporting through
 *  `progress`. */
function heldAdd(): { done: Promise<unknown>; progress: (p: GitProgress) => void; finish: () => void } {
  const held = { progress: (_p: GitProgress): void => {}, finish: (): void => {} }
  mockClone.mockImplementationOnce(async (_url, dest, _cred, onProgress) => {
    await fs.mkdir(path.join(dest, '.git'), { recursive: true })
    held.progress = (p) => onProgress?.(p)
    await new Promise<void>((resolve) => { held.finish = resolve })
  })
  const done = addProject(URL, token, BUILT_IN_USER_ID, ADDING)
  return { done, progress: (p) => held.progress(p), finish: () => held.finish() }
}

describe('listProjectAdds', () => {
  it('lists an add from its start with the clone\'s progress, notifying at most twice a second within a phase, until it is a project', async () => {
    let notifies = 0
    onWorkspaceListChanged(() => { notifies++ })
    const add = heldAdd()
    await vi.waitFor(() => expect(mockClone).toHaveBeenCalledTimes(1))
    expect(listProjectAdds()).toEqual([{ id: ADDING, owner: BUILT_IN_USER_ID, name: 'widgets', remoteUrl: URL, hosted: false }])

    const before = notifies
    add.progress({ phase: 'Receiving objects', percent: 1, detail: '10 KiB' })
    add.progress({ phase: 'Receiving objects', percent: 45, detail: '1.20 MiB | 2.00 MiB/s' })
    expect(listProjectAdds()[0].progress).toEqual({ phase: 'Receiving objects', percent: 45, detail: '1.20 MiB | 2.00 MiB/s' })
    // The second line was too soon after the first to notify; a new phase
    // always does.
    expect(notifies - before).toBe(1)
    add.progress({ phase: 'Resolving deltas', percent: 0 })
    expect(notifies - before).toBe(2)

    // A hosted create lists too, after the add, with no progress to show.
    const created = createHostedProject('Gadgets', BUILT_IN_USER_ID)
    await vi.waitFor(() => expect(listProjectAdds()).toHaveLength(2))
    expect(listProjectAdds()[1]).toMatchObject({ name: 'gadgets', remoteUrl: '', hosted: true })
    await created

    add.finish()
    await add.done
    expect(listProjectAdds()).toEqual([])
    expect(await getProjectRow(ADDING)).toMatchObject({ name: 'widgets' })
  })
})

describe('dismissProjectAdd', () => {
  it('drops a failed add for its owner, and leaves one still running or another user\'s', async () => {
    const add = heldAdd()
    await vi.waitFor(() => expect(mockClone).toHaveBeenCalledTimes(1))
    // Still running: there is nothing to dismiss yet.
    dismissProjectAdd(local, ADDING)
    expect(listProjectAdds()).toHaveLength(1)

    mockClone.mockReset()
    add.finish()
    await add.done
    mockClone.mockRejectedValueOnce(new Error('fatal: repository not found'))
    const FAILED = '4f3e2d1c-0b9a-4f8e-9d7c-6b5a4f3e2d1c'
    await expect(addProject('https://github.com/acme/gone.git', token, BUILT_IN_USER_ID, FAILED)).rejects.toThrow()
    expect(listProjectAdds()).toMatchObject([{ id: FAILED, error: 'Failed to clone: fatal: repository not found' }])

    expect(() => dismissProjectAdd({ kind: 'local', userId: 'someone-else' }, FAILED))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    // Nor can another user take its id over with an add of their own.
    // (Refused before the credential is looked up.)
    await expect(addProject('https://github.com/acme/theirs.git', token, 'someone-else', FAILED))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    expect(listProjectAdds()).toMatchObject([{ id: FAILED, owner: BUILT_IN_USER_ID }])
    dismissProjectAdd(local, FAILED)
    expect(listProjectAdds()).toEqual([])
    // Idempotent.
    dismissProjectAdd(local, FAILED)
  })
})
