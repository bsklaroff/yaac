import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setDataDir, workspaceAttachmentsDir } from '@yaac/shared/project-paths'
import { testTmpBase } from '@yaac/test-utils/tmp'
import { handleFixture, installFakeWorkspaceDriver, workspacePathsFixture } from '@yaac/test-utils/fake-driver'
import { saveWorkspaceAttachment } from '#domain/workspaces/attachments'
import { BUILT_IN_USER_ID, closeDb, recordProject } from '#db'
import { DEMO_PROJECT_ID as PROJ } from '@yaac/test-utils/project-fixture'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const PNG = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.from('pixels')])

let dataDir: string

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(testTmpBase(), 'yaac-attachments-'))
  setDataDir(dataDir)
  await recordProject({ id: PROJ, name: 'demo', remoteUrl: 'https://github.com/o/r', addedAt: 'now' }, BUILT_IN_USER_ID)
  // A launch creates this directory along with its mount into the workspace.
  await fs.mkdir(workspaceAttachmentsDir(PROJ, 'wt-1'), { recursive: true })
  installFakeWorkspaceDriver({
    find: () => Promise.resolve(handleFixture({
      workspaceId: 'wt-1', projectId: PROJ, jobName: 'yaac-proj-wt-1', state: 'running',
    })),
    workspacePaths: () => workspacePathsFixture({ attachmentsDir: '/in/the/workspace' }),
  })
})

afterEach(async () => {
  await closeDb()
  await fs.rm(dataDir, { recursive: true, force: true })
})

describe('saveWorkspaceAttachment', () => {
  it('keeps an image where the workspace reads it, named by its bytes, and answers that path', async () => {
    const { path: pasted } = await saveWorkspaceAttachment(local, 'wt-1', PNG)

    // The path is the workspace's view; the bytes are on the server's side of
    // the same directory.
    expect(pasted).toMatch(/^\/in\/the\/workspace\/[0-9a-f]{32}\.png$/)
    const stored = path.join(workspaceAttachmentsDir(PROJ, 'wt-1'), path.basename(pasted))
    expect(await fs.readFile(stored)).toEqual(PNG)

    // The same image twice is one file, at one path.
    expect((await saveWorkspaceAttachment(local, 'wt-1', PNG)).path).toBe(pasted)
    expect(await fs.readdir(workspaceAttachmentsDir(PROJ, 'wt-1'))).toHaveLength(1)
  })

  it('refuses bytes that are not an image, and a workspace not running', async () => {
    await expect(saveWorkspaceAttachment(local, 'wt-1', Buffer.from('#!/bin/sh\n')))
      .rejects.toMatchObject({ code: 'VALIDATION' })

    installFakeWorkspaceDriver({
      find: () => Promise.resolve(handleFixture({ workspaceId: 'wt-1', state: 'stopped' })),
    })
    await expect(saveWorkspaceAttachment(local, 'wt-1', PNG)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
