import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { listWorkspaceLogs, readWorkspaceLog, workspaceSteps } from '#domain/workspaces/logs'
import { BUILT_IN_USER_ID, applyWorkspaceEvent, getWorkspaceRow, insertAddedSteps } from '#db'
import { createWorkflow, editWorkflow, resolveWorkflow } from '#domain/projects'
import { lifeDirName, parseStepGraph } from '@yaac/shared/steps'
import type { WorkspaceLogLife } from '@yaac/shared/types'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { closeDb } from '#db/client'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { DEMO_PROJECT_ID, seedProject } from '@yaac/test-utils/project-fixture'
import { terminalLogDir } from '@yaac/shared/project-paths'

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const execFileAsync = promisify(execFile)
const WS = 'w1'
const OLD_AT = new Date('2026-11-01T10:00:00.000Z')
const OLD = lifeDirName(OLD_AT)
const NEW_AT = new Date('2026-11-02T10:00:00.000Z')
const NEW = lifeDirName(NEW_AT)

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
  // exits, so it is served but not listed. Each life carries the specs its
  // workflows ran, an added one's included, which an edit to the named
  // workflow since leaves. The old life is from before steps had
  // workflows, so its steps are under ''. A workflow named after an
  // Object.prototype member is listed like any other.
  it('lists every life, newest first, with its log files, their sizes and the graphs it ran, leaving out an agent session\'s', async () => {
    const steps = { build: { run: 'make' }, test: { run: 'make test', needs: ['build'] } }
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'ci', steps })
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'constructor', steps: { keys: { run: 'true' } } })
    const id = async (name: string): Promise<string> => (await resolveWorkflow(DEMO_PROJECT_ID, name)).workflow.id
    const start = (at: Date, startSteps: Array<{ id: string; name: string; steps: ReturnType<typeof parseStepGraph> }>): Promise<void> =>
      applyWorkspaceEvent({ type: 'workspace-life-started', projectId: DEMO_PROJECT_ID, workspaceId: WS, at, startSteps })
    await start(OLD_AT, [{ id: await id('ci'), name: '', steps: parseStepGraph({ setup: { run: 'make setup' } }) }])
    await start(NEW_AT, [
      { id: await id('ci'), name: 'ci', steps: parseStepGraph(steps) },
      { id: await id('constructor'), name: 'constructor', steps: parseStepGraph({ keys: { run: 'true' } }) },
    ])
    await insertAddedSteps(DEMO_PROJECT_ID, WS, NEW_AT, { id: await id('ci'), name: 'extra' }, parseStepGraph({ lint: { run: 'make lint' } }))
    await editWorkflow(local, DEMO_PROJECT_ID, 'ci', { steps: { other: { run: 'true' } } })
    expect(await listWorkspaceLogs(local, WS)).toEqual<WorkspaceLogLife[]>([
      {
        life: NEW,
        files: [{ name: 'build.events', size: 10 }, { name: 'build.log', size: 8 }, { name: 'build.log.1', size: 5 }],
        workflows: {
          ci: { build: { run: ['make'] }, test: { run: ['make test'], needs: ['build'] } },
          constructor: { keys: { run: ['true'] } },
          extra: { lint: { run: ['make lint'] } },
        },
      },
      { life: OLD, files: [{ name: 'shell.log', size: 5 }], workflows: { '': { setup: { run: ['make setup'] } } } },
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

describe('workspaceSteps', () => {
  it("lists each life's steps, newest first, with their states and log sizes, and where the workspace stands", async () => {
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'ci', steps: { build: { run: 'make' } } })
    const id = (await resolveWorkflow(DEMO_PROJECT_ID, 'ci')).workflow.id
    const start = (at: Date, steps: Parameters<typeof parseStepGraph>[0]): Promise<void> => applyWorkspaceEvent({
      type: 'workspace-life-started', projectId: DEMO_PROJECT_ID, workspaceId: WS, at, startSteps: [{ id, name: 'ci', steps: parseStepGraph(steps) }],
    })
    await start(OLD_AT, { setup: { run: 'make setup' } })
    await start(NEW_AT, { build: { run: 'make' }, serve: { run: 'make serve', needs: ['build'], service: true } })
    const root = terminalLogDir(DEMO_PROJECT_ID, WS)
    await fs.writeFile(path.join(root, NEW, 'ci.build.log'), 'one\ntwo\n')
    await fs.writeFile(path.join(root, NEW, 'ci.build.log.1'), 'zero\n')

    expect(await workspaceSteps('w')).toEqual({
      workspaceId: WS,
      // Its row's current life, which names the dir its logs go in.
      life: lifeDirName((await getWorkspaceRow(DEMO_PROJECT_ID, WS))!.lifeStartedAt),
      lives: [
        {
          life: NEW,
          steps: [
            { name: 'ci.build', step: 'build', state: 'pending', needs: [], started: false, logs: [{ file: 'ci.build.log.1', size: 5 }, { file: 'ci.build.log', size: 8 }] },
            { name: 'ci.serve', step: 'serve', state: 'pending', needs: ['build'], service: true, started: false, logs: [{ file: 'ci.serve.log.1', size: 0 }, { file: 'ci.serve.log', size: 0 }] },
          ],
        },
        // A new life interrupts what the last left unsettled.
        { life: OLD, steps: [expect.objectContaining({ name: 'ci.setup', state: 'interrupted' })] },
      ],
    })
    await applyWorkspaceEvent({ type: 'workspace-stopped', projectId: DEMO_PROJECT_ID, workspaceId: WS })
    expect(await workspaceSteps(WS)).toMatchObject({ stopped: true })
    await expect(workspaceSteps('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
