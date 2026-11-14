import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('#lib/log', async (importOriginal) => ({ ...await importOriginal<typeof logModule>(), serverLog: vi.fn() }))
// The real write, made to fail once where a case asks.
vi.mock('#db', async (importOriginal) => {
  const actual = await importOriginal<typeof dbModule>()
  return { ...actual, setProjectConfig: vi.fn(actual.setProjectConfig) }
})

import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { PROJECT_CONFIG_DEFAULTS, recordTestProject } from '@yaac/test-utils/project-fixture'
import { projectConfigDir } from '@yaac/shared/project-paths'
import { applyWorkspaceEvent, BUILT_IN_USER_ID, getProjectRow, getWorkspaceRow, setProjectConfig } from '#db'
import type * as dbModule from '#db'
import { createWorkflow, importProjectConfigFiles, listInitWorkflows, resolveProjectConfig } from '#domain/projects'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { serverLog } from '#lib/log'
import type * as logModule from '#lib/log'

const FOO = 'acbd18db-4cc2-485c-8def-654fccc4a4d8'
const BAR = '37b51d19-4a75-43e4-8b56-f6524f2d51f2'
const BAZ = '73feffa4-b7f6-4bb6-8bd3-0e3a1d5a4c2a'
const OWNER = { kind: 'local' as const, userId: BUILT_IN_USER_ID }

let tmpDir: string

beforeEach(async () => {
  vi.clearAllMocks()
  tmpDir = await createTempDataDir()
  installFakeWorkspaceDriver({ kind: 'k8s' })
  for (const id of [FOO, BAR, BAZ]) await recordTestProject(id)
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

const file = (id: string, name = 'yaac-config.json'): string => path.join(projectConfigDir(id), name)
async function writeConfig(id: string, config: unknown): Promise<void> {
  await fs.mkdir(projectConfigDir(id), { recursive: true })
  await fs.writeFile(file(id), typeof config === 'string' ? config : JSON.stringify(config))
}
const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false)

/** A project's init workflows' graphs, by name. */
async function initSteps(projectId: string): Promise<Record<string, unknown>> {
  return Object.fromEntries((await listInitWorkflows(projectId)).map((w) => [w.name, w.workflow.steps]))
}

describe('importProjectConfigFiles', () => {
  it('moves every key onto the row and deletes the file', async () => {
    // Running since before the upgrade, so started with the file's scratch dirs.
    await applyWorkspaceEvent({ type: 'workspace-created', projectId: FOO, workspaceId: 'running' })
    await writeConfig(FOO, {
      portForward: [{ containerPort: 3000, hostPortStart: 13000 }],
      cacheVolumes: { pip: '/home/yaac/.cache/pip' },
      nestedContainers: true,
      npmCache: false,
      ephemeralModulesPaths: ['node_modules', 'web/node_modules/'],
      initCommands: ['pnpm install', 'pnpm build'],
      hideInitPane: true,
    })
    await writeConfig(BAR, { initCommands: [
      { name: 'backend', commands: ['pnpm dev:be'] },
      { name: 'frontend', commands: ['pnpm i', 'pnpm dev'], hidePane: true },
      // A name a step may not take, which the old file allowed, is renamed.
      { name: 'claude-setup', commands: ['a'] },
      { name: 'db.setup', commands: ['b'] },
    ] })

    await importProjectConfigFiles()

    expect(await resolveProjectConfig(FOO)).toEqual({
      portForwards: [{ containerPort: 3000, hostPortStart: 13000 }],
      cacheVolumes: { pip: '/home/yaac/.cache/pip' },
      npmCache: false,
    })
    const foo = await getProjectRow(FOO)
    expect(foo?.scratchDirs.dirs).toEqual([{ path: 'node_modules' }, { path: 'web/node_modules' }])
    expect((await getWorkspaceRow(FOO, 'running'))?.scratchDirs).toEqual(['node_modules', 'web/node_modules'])
    // Its init commands are a marked workflow named `init`.
    expect(await initSteps(FOO)).toEqual({ init: { init: { run: ['pnpm install', 'pnpm build'] } } })
    expect(await initSteps(BAR)).toEqual({ init: {
      backend: { run: ['pnpm dev:be'] },
      frontend: { run: ['pnpm i', 'pnpm dev'] },
      'claude-setup': { run: ['a'] },
      'init-db-setup': { run: ['b'] },
    } })
    expect(await exists(file(FOO))).toBe(false)

    // Once imported there is nothing left to import.
    await importProjectConfigFiles()
    expect(Object.keys(await initSteps(FOO))).toEqual(['init'])
  })

  it('imports what validates and keeps the file aside, logging no value, as it does a file that is not JSON', async () => {
    await createWorkflow(OWNER, FOO, { name: 'init', steps: { mine: { run: 'make' } } })
    // A project with an init workflow of its own, whatever its name, keeps it alone.
    await createWorkflow(OWNER, BAZ, { name: 'setup', steps: { mine: { run: 'make' } }, init: true })
    await writeConfig(BAZ, { initCommands: ['pnpm install'] })
    const foo = JSON.stringify({
      npmCache: false,
      portForward: [{ containerPort: 10300, hostPortStart: 1 }],
      initCommands: ['export GH_TOKEN=ghp_secret', 'pnpm install'],
      somethingElse: 'also-secret',
    })
    await writeConfig(FOO, foo)
    await writeConfig(BAR, '{ "initCommands": ["export GH_TOKEN=ghp_secret"')

    await importProjectConfigFiles()

    // A workflow named `init` that is no init workflow takes nothing from
    // the import's name: the commands become `init-steps`.
    expect(await resolveProjectConfig(FOO)).toEqual({ ...PROJECT_CONFIG_DEFAULTS, npmCache: false })
    expect(Object.keys(await initSteps(FOO))).toEqual(['init-steps'])
    expect(Object.keys(await initSteps(BAZ))).toEqual(['setup'])
    const logged = vi.mocked(serverLog).mock.calls.map(([m]) => m).join('\n')
    expect(logged).toContain('portForward (10300 is reserved')
    expect(logged).toContain('somethingElse (not a setting)')
    expect(logged).toContain('the file (not a JSON object)')
    expect(logged).toContain(`kept as ${file(FOO, 'yaac-config.json.unimported')}`)
    expect(logged).not.toContain('secret')
    expect(await exists(file(FOO))).toBe(false)
    expect(await fs.readFile(file(FOO, 'yaac-config.json.unimported'), 'utf8')).toBe(foo)
    expect(await exists(file(BAR))).toBe(false)
    expect(await exists(file(BAR, 'yaac-config.json.unimported'))).toBe(true)
  })

  it('leaves the file where it is when a write fails, and imports it at the next start', async () => {
    await writeConfig(FOO, { npmCache: false, ephemeralModulesPaths: ['deps'] })
    vi.mocked(setProjectConfig).mockRejectedValueOnce(new Error('Failed query: params: npm_cache=false', { cause: new Error('disk full') }))

    await importProjectConfigFiles()

    expect(await exists(file(FOO))).toBe(true)
    const logged = vi.mocked(serverLog).mock.calls.map(([m]) => m).join('\n')
    expect(logged).toContain('yaac-config.json not imported, retried at next start: disk full')
    expect(logged).not.toContain('npm_cache')

    await importProjectConfigFiles()

    expect(await resolveProjectConfig(FOO)).toEqual({ ...PROJECT_CONFIG_DEFAULTS, npmCache: false })
    expect((await getProjectRow(FOO))?.scratchDirs.dirs).toEqual([{ path: 'deps' }])
    expect(await exists(file(FOO))).toBe(false)
  })

  it('leaves out what a containerless server lacks', async () => {
    installFakeWorkspaceDriver({ kind: 'containerless' })
    await writeConfig(FOO, {
      portForward: [{ containerPort: 3000, hostPortStart: 3000 }],
      cacheVolumes: { pip: '/p' },
      nestedContainers: true,
      npmCache: false,
    })
    await importProjectConfigFiles()
    expect(await resolveProjectConfig(FOO))
      .toEqual({ ...PROJECT_CONFIG_DEFAULTS, portForwards: [{ containerPort: 3000, hostPortStart: 3000 }] })
    // They were never in effect here, so nothing is kept for them.
    expect(await exists(file(FOO))).toBe(false)
    expect(await exists(file(FOO, 'yaac-config.json.unimported'))).toBe(false)
  })
})
