import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { credentialsDir, projectConfigDir, projectDir } from '@yaac/shared/project-paths'
import { closeDb, listProjectEnvVars, recordProject } from '#db'
import { serverLog } from '#log'

vi.mock('#log', () => ({ serverLog: vi.fn() }))
import {
  importLegacyProjectConfig,
  legacySecretImportPending,
  listProjectEnv,
} from '#domain/projects'

/**
 * The one-shot move of a pre-upgrade install's environment settings out of
 * `yaac-config.json` and into rows (docs/legacy-compat-shims.md).
 *
 * Without it an install that upgrades silently loses its worktree
 * environment at the next create, with the config file still sitting there
 * looking like it says what should happen — which is why the keys are
 * stripped as well as read.
 */

let tmpDir: string

const configPath = (slug: string): string =>
  path.join(projectConfigDir(slug), 'yaac-config.json')

async function writeConfig(slug: string, config: object): Promise<void> {
  await fs.mkdir(projectConfigDir(slug), { recursive: true })
  await fs.writeFile(configPath(slug), JSON.stringify(config, null, 2) + '\n')
}

async function readConfig(slug: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(configPath(slug), 'utf8')) as Record<string, unknown>
}

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await fs.mkdir(projectDir('demo'), { recursive: true })
  await fs.writeFile(
    path.join(projectDir('demo'), 'project.json'),
    JSON.stringify({ slug: 'demo', remoteUrl: 'https://github.com/o/r.git', addedAt: 'now' }),
  )
  await recordProject({ slug: 'demo', remoteUrl: 'https://github.com/o/r.git', addedAt: 'now' })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('importLegacyProjectConfig', () => {
  it('moves literals and passthrough values into rows, and strips the keys', async () => {
    vi.stubEnv('LEGACY_FROM_HOST', 'from-the-shell')
    await writeConfig('demo', {
      env: { NODE_ENV: 'development' },
      envPassthrough: ['LEGACY_FROM_HOST', 'NOT_SET_ANYWHERE'],
      initCommands: ['pnpm install'],
    })

    await importLegacyProjectConfig()

    expect(await listProjectEnv('demo')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'NODE_ENV', value: 'development', secret: false }),
      expect.objectContaining({ name: 'LEGACY_FROM_HOST', value: 'from-the-shell' }),
    ]))
    // A passthrough name the server's own environment cannot answer for has
    // no value to move — which is the very problem the rows exist to fix.
    expect((await listProjectEnv('demo')).map((v) => v.name)).not.toContain('NOT_SET_ANYWHERE')
    // The file stops disagreeing with the settings page, and keeps the rest.
    expect(await readConfig('demo')).toEqual({ initCommands: ['pnpm install'] })
  })

  it('keeps a secret’s rule even when its value cannot be found', async () => {
    // The rule is the part the user cannot reconstruct from memory; the
    // value they can retype. Under `k8s` this is the ordinary case, since
    // the server pod's environment holds only what its Deployment states.
    await writeConfig('demo', {
      envSecretProxy: {
        MY_KEY: { hosts: ['api.example.com'], header: 'x-api-key' },
      },
    })

    await importLegacyProjectConfig()

    expect(await listProjectEnv('demo')).toEqual([expect.objectContaining({
      name: 'MY_KEY',
      secret: true,
      hasValue: false,
      rule: { hosts: ['api.example.com'], header: 'x-api-key' },
    })])
  })

  it('carries a secret’s value over when this server does have it', async () => {
    vi.stubEnv('MY_KEY', 'sekrit')
    await writeConfig('demo', {
      envSecretProxy: { MY_KEY: { hosts: ['api.example.com'] } },
    })

    await importLegacyProjectConfig()

    expect(await listProjectEnv('demo')).toEqual([expect.objectContaining({
      name: 'MY_KEY', hasValue: true,
    })])
    expect((await listProjectEnvVars('demo'))[0].value).toBe('sekrit')
  })

  it('never overwrites a value the user has since typed in', async () => {
    // The pass runs on every start, so a stale file must not undo an edit.
    vi.stubEnv('SHARED_NAME', 'stale-from-the-shell')
    await writeConfig('demo', { envPassthrough: ['SHARED_NAME'] })
    await importLegacyProjectConfig()

    await writeConfig('demo', { envPassthrough: ['SHARED_NAME'] })
    await importLegacyProjectConfig()

    expect(await listProjectEnv('demo')).toHaveLength(1)
  })

  it('is a no-op on a config with none of the retired keys', async () => {
    await writeConfig('demo', { initCommands: ['pnpm install'] })

    await importLegacyProjectConfig()

    expect(await listProjectEnv('demo')).toEqual([])
    // Untouched, trailing newline and all — nothing rewrote it.
    expect(await fs.readFile(configPath('demo'), 'utf8'))
      .toBe(JSON.stringify({ initCommands: ['pnpm install'] }, null, 2) + '\n')
  })

  it('leaves a config too broken to parse for the editor to repair', async () => {
    await fs.mkdir(projectConfigDir('demo'), { recursive: true })
    await fs.writeFile(configPath('demo'), '{not json')

    await importLegacyProjectConfig()

    expect(await fs.readFile(configPath('demo'), 'utf8')).toBe('{not json')
  })

  it('recovers a secret from the old proxy-secrets file, and leaves the file', async () => {
    // That file is the merged map of every value envSecretProxy ever
    // resolved, and it is the LAST copy: under k8s the server pod's own
    // environment answers for nothing, so importing valueless rows while
    // deleting it would lose them outright. Deleting it is a separate shim
    // with a different trigger — a proxy that has proved it no longer reads
    // it — because the pod still serving live worktrees during an upgrade is
    // the old one, resolving every injection out of exactly this file.
    await fs.mkdir(credentialsDir(), { recursive: true })
    const stale = path.join(credentialsDir(), 'proxy-secrets.json')
    await fs.writeFile(stale, JSON.stringify({ secrets: { MY_KEY: 'from-the-file' } }))
    await writeConfig('demo', {
      envSecretProxy: { MY_KEY: { hosts: ['api.example.com'] } },
    })

    await importLegacyProjectConfig()

    expect(await listProjectEnv('demo')).toEqual([expect.objectContaining({
      name: 'MY_KEY', hasValue: true,
    })])
    expect((await listProjectEnvVars('demo'))[0].value).toBe('from-the-file')
    await fs.access(stale)
  })

  it('prefers the file over the process environment', async () => {
    // The file is what the proxy actually resolved against; the environment
    // is the thing that only ever worked for a shell on the server's host.
    vi.stubEnv('MY_KEY', 'from-the-shell')
    await fs.mkdir(credentialsDir(), { recursive: true })
    await fs.writeFile(
      path.join(credentialsDir(), 'proxy-secrets.json'),
      JSON.stringify({ secrets: { MY_KEY: 'from-the-file' } }),
    )
    await writeConfig('demo', { envSecretProxy: { MY_KEY: { hosts: ['a.com'] } } })

    await importLegacyProjectConfig()

    expect((await listProjectEnvVars('demo'))[0].value).toBe('from-the-file')
  })

  it('names the passthrough values it had to drop', async () => {
    // The key is stripped from the file either way, so a name dropped in
    // silence is a setting that simply disappears — and under k8s, where the
    // pod's environment holds only what its Deployment states, that is all
    // of them.
    await writeConfig('demo', { envPassthrough: ['NOT_SET_ANYWHERE'] })

    await importLegacyProjectConfig()

    expect(await listProjectEnv('demo')).toEqual([])
    expect(vi.mocked(serverLog).mock.calls.map(([l]) => l).join('\n'))
      .toContain('NOT_SET_ANYWHERE')
  })

  it('leaves no torn overlay behind: the rewrite is atomic', async () => {
    // A bare writeFile that died mid-way would truncate the whole overlay —
    // initCommands, cacheVolumes, portForward, none of which this pass has
    // an opinion about — and the next start would report it as unparseable.
    await writeConfig('demo', {
      env: { A: '1' },
      initCommands: ['pnpm install'],
      cacheVolumes: { pip: '/home/yaac/.cache/pip' },
    })

    await importLegacyProjectConfig()

    expect(await readConfig('demo')).toEqual({
      initCommands: ['pnpm install'],
      cacheVolumes: { pip: '/home/yaac/.cache/pip' },
    })
    // No temp file left beside it.
    expect((await fs.readdir(projectConfigDir('demo'))).filter((f) => f.includes('.tmp')))
      .toEqual([])
  })
})

/**
 * What the runtime asks before deleting the old plaintext secrets file.
 *
 * The importer SKIPS an overlay it cannot parse, so "a start has run" does
 * not mean "everything has been imported" — and the file is the last place
 * the values that overlay's names refer to are written down.
 */
describe('legacySecretImportPending', () => {
  it('is false once nothing carries the key', async () => {
    await writeConfig('demo', { initCommands: ['pnpm install'] })
    expect(await legacySecretImportPending()).toBe(false)
  })

  it('is true while an overlay still names a proxied secret', async () => {
    await writeConfig('demo', { envSecretProxy: { K: { hosts: ['a.com'] } } })
    expect(await legacySecretImportPending()).toBe(true)

    await importLegacyProjectConfig()
    expect(await legacySecretImportPending()).toBe(false)
  })

  it('is true for an overlay that does not parse — the case it exists for', async () => {
    // The import leaves this one for the editor, so its secrets are still
    // only in the file the caller is about to delete.
    await fs.mkdir(projectConfigDir('demo'), { recursive: true })
    await fs.writeFile(configPath('demo'), '{not json')
    expect(await legacySecretImportPending()).toBe(true)
  })

  it('is false for a project with no overlay at all', async () => {
    expect(await legacySecretImportPending()).toBe(false)
  })
})
