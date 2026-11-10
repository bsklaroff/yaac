import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { listWorkspaceLogs, readWorkspaceLog } from '#domain/workspaces/logs'
import { BUILT_IN_USER_ID } from '#db'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { closeDb } from '#db/client'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { DEMO_PROJECT_ID, seedProject } from '@yaac/test-utils/project-fixture'
import { terminalLogDir } from '@yaac/shared/project-paths'

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const execFileAsync = promisify(execFile)
const WS = 'w1'
const OLD = '2026-11-01T10-00-00.000Z'
const NEW = '2026-11-02T10-00-00.000Z'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  // Stopped: the logs read from the host, with nothing running.
  installFakeWorkspaceDriver({ find: () => Promise.resolve(undefined) })
  await seedProject()
  await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: WS })
  const root = terminalLogDir(DEMO_PROJECT_ID, WS)
  for (const life of [OLD, NEW]) await fs.mkdir(path.join(root, life), { recursive: true })
  await fs.writeFile(path.join(root, NEW, 'build.log'), 'one\ntwo\n')
  await fs.writeFile(path.join(root, NEW, 'build.log.1'), 'zero\n')
  await fs.writeFile(path.join(root, NEW, 'build.events'), 'start 0 t\n')
  await fs.writeFile(path.join(root, NEW, 'build.sh'), 'the script')
  await fs.writeFile(path.join(root, OLD, 'shell.log'), '$ ls\n')
  await fs.writeFile(path.join(root, NEW, 'claude-c09f7077.log'), '[acpd] listening on\n')
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('listWorkspaceLogs', () => {
  // An agent session's log is the chat pane's to offer once its agent
  // exits, so it is served but not listed.
  it('lists every life, newest first, with its log files and their sizes, leaving out an agent session\'s', async () => {
    expect(await listWorkspaceLogs(local, WS)).toEqual([
      { life: NEW, files: [{ name: 'build.events', size: 10 }, { name: 'build.log', size: 8 }, { name: 'build.log.1', size: 5 }] },
      { life: OLD, files: [{ name: 'shell.log', size: 5 }] },
    ])
    expect((await readWorkspaceLog(local, WS, NEW, 'claude-c09f7077.log')).data.toString()).toBe('[acpd] listening on\n')
  })
})

describe('readWorkspaceLog', () => {
  it('reads a log from an offset, answering where to read from next, and refuses a path that is not a log', async () => {
    const all = await readWorkspaceLog(local, WS, NEW, 'build.log')
    expect(all.data.toString()).toBe('one\ntwo\n')
    expect(all).toMatchObject({ next: 8, size: 8 })
    const tail = await readWorkspaceLog(local, WS, NEW, 'build.log', 4)
    expect(tail.data.toString()).toBe('two\n')
    expect((await readWorkspaceLog(local, WS, NEW, 'build.log', 100)).data.length).toBe(0)

    await expect(readWorkspaceLog(local, WS, NEW, 'nope.log')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    for (const [life, file] of [[NEW, 'build.sh'], ['..', 'build.log'], [NEW, '../x.log'], [NEW, 'hooks.conf']]) {
      await expect(readWorkspaceLog(local, WS, life, file), `${life}/${file}`).rejects.toMatchObject({ code: 'VALIDATION' })
    }
  })

  // The workspace writes the dir, so what it plants there is never followed:
  // a link to a server file is neither listed nor served, and a FIFO does
  // not hang the read.
  it('serves no link or FIFO the workspace planted', async () => {
    const dir = path.join(terminalLogDir(DEMO_PROJECT_ID, WS), NEW)
    const secret = path.join(tmpDir, 'secret.txt')
    await fs.writeFile(secret, 'server secret')
    await fs.symlink(secret, path.join(dir, 'leak.log'))
    await execFileAsync('mkfifo', [path.join(dir, 'fifo.log')])
    const files = (await listWorkspaceLogs(local, WS))[0].files.map((f) => f.name)
    expect(files).not.toContain('leak.log')
    expect(files).not.toContain('fifo.log')
    await expect(readWorkspaceLog(local, WS, NEW, 'leak.log')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(readWorkspaceLog(local, WS, NEW, 'fifo.log')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
