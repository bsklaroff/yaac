import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setDataDir, workspaceAttachmentsDir } from '@yaac/shared/project-paths'
import { testTmpBase } from '@yaac/test-utils/tmp'
import { handleFixture, installFakeWorkspaceDriver, workspacePathsFixture } from '@yaac/test-utils/fake-driver'
import { saveWorkspaceAttachment } from '#domain/workspaces/attachments'

const PNG = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.from('pixels')])

let dataDir: string

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(testTmpBase(), 'yaac-attachments-'))
  setDataDir(dataDir)
  // What a launch makes, beside the mount that shows it to the workspace.
  await fs.mkdir(workspaceAttachmentsDir('proj', 'wt-1'), { recursive: true })
  installFakeWorkspaceDriver({
    find: () => Promise.resolve(handleFixture({
      workspaceId: 'wt-1', projectSlug: 'proj', jobName: 'yaac-proj-wt-1', state: 'running',
    })),
    workspacePaths: () => workspacePathsFixture({ attachmentsDir: '/in/the/workspace' }),
  })
})

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

describe('saveWorkspaceAttachment', () => {
  it('keeps an image where the workspace reads it, named by its bytes, and answers that path', async () => {
    const { path: pasted } = await saveWorkspaceAttachment('wt-1', PNG)

    // The path is the workspace's view; the bytes are on the server's side of
    // the same directory.
    expect(pasted).toMatch(/^\/in\/the\/workspace\/[0-9a-f]{32}\.png$/)
    const stored = path.join(workspaceAttachmentsDir('proj', 'wt-1'), path.basename(pasted))
    expect(await fs.readFile(stored)).toEqual(PNG)

    // The same image twice is one file, at one path.
    expect((await saveWorkspaceAttachment('wt-1', PNG)).path).toBe(pasted)
    expect(await fs.readdir(workspaceAttachmentsDir('proj', 'wt-1'))).toHaveLength(1)
  })

  it('refuses bytes that are not an image, a workspace launched without the mount, and one not running', async () => {
    await expect(saveWorkspaceAttachment('wt-1', Buffer.from('#!/bin/sh\n')))
      .rejects.toMatchObject({ code: 'VALIDATION' })

    // No directory means no mount: the path would name nothing the agent can
    // open, so the user is told to restart rather than handed it.
    await fs.rm(workspaceAttachmentsDir('proj', 'wt-1'), { recursive: true })
    await expect(saveWorkspaceAttachment('wt-1', PNG)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(saveWorkspaceAttachment('wt-1', PNG)).rejects.toThrow(/restart/)

    installFakeWorkspaceDriver({
      find: () => Promise.resolve(handleFixture({ workspaceId: 'wt-1', state: 'stopped' })),
    })
    await expect(saveWorkspaceAttachment('wt-1', PNG)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
