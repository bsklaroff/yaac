import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setDataDir, worktreeAttachmentsDir } from '@yaac/shared/project-paths'
import { testTmpBase } from '@yaac/test-utils/tmp'
import { handleFixture, installFakeWorktreeDriver, workspacePathsFixture } from '@yaac/test-utils/fake-driver'
import { saveWorktreeAttachment } from '#domain/worktrees/attachments'

const PNG = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.from('pixels')])

let dataDir: string

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(testTmpBase(), 'yaac-attachments-'))
  setDataDir(dataDir)
  // What a launch makes, beside the mount that shows it to the workspace.
  await fs.mkdir(worktreeAttachmentsDir('proj', 'wt-1'), { recursive: true })
  installFakeWorktreeDriver({
    find: () => Promise.resolve(handleFixture({
      workspaceId: 'wt-1', projectSlug: 'proj', jobName: 'yaac-proj-wt-1', state: 'running',
    })),
    workspacePaths: () => workspacePathsFixture({ attachmentsDir: '/in/the/workspace' }),
  })
})

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

describe('saveWorktreeAttachment', () => {
  it('keeps an image where the workspace reads it, named by its bytes, and answers that path', async () => {
    const { path: pasted } = await saveWorktreeAttachment('wt-1', PNG)

    // The path is the workspace's view; the bytes are on the server's side of
    // the same directory.
    expect(pasted).toMatch(/^\/in\/the\/workspace\/[0-9a-f]{32}\.png$/)
    const stored = path.join(worktreeAttachmentsDir('proj', 'wt-1'), path.basename(pasted))
    expect(await fs.readFile(stored)).toEqual(PNG)

    // The same image twice is one file, at one path.
    expect((await saveWorktreeAttachment('wt-1', PNG)).path).toBe(pasted)
    expect(await fs.readdir(worktreeAttachmentsDir('proj', 'wt-1'))).toHaveLength(1)
  })

  it('refuses bytes that are not an image, a worktree launched without the mount, and one not running', async () => {
    await expect(saveWorktreeAttachment('wt-1', Buffer.from('#!/bin/sh\n')))
      .rejects.toMatchObject({ code: 'VALIDATION' })

    // No directory means no mount: the path would name nothing the agent can
    // open, so the user is told to restart rather than handed it.
    await fs.rm(worktreeAttachmentsDir('proj', 'wt-1'), { recursive: true })
    await expect(saveWorktreeAttachment('wt-1', PNG)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(saveWorktreeAttachment('wt-1', PNG)).rejects.toThrow(/restart/)

    installFakeWorktreeDriver({
      find: () => Promise.resolve(handleFixture({ workspaceId: 'wt-1', state: 'stopped' })),
    })
    await expect(saveWorktreeAttachment('wt-1', PNG)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
