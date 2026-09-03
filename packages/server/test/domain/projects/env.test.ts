import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { projectDir } from '@yaac/shared/project-paths'
import { closeDb, recordProject, upsertProjectEnvVar } from '#db'
import {
  listProjectEnv,
  parseSecretProxyRule,
  removeProjectEnvVar,
  resolveProjectEnv,
  setProjectEnvVar,
} from '#domain/projects'

/**
 * A project's environment as the layers above the store see it.
 *
 * The two things this owns and the store does not: what a client is allowed
 * to say (a name a shell will take, a rule the proxy can act on), and what a
 * client is allowed to LEARN — a secret's value goes in and never comes back.
 */

let tmpDir: string

const RULE = { hosts: ['api.example.com'], header: 'x-api-key' }

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
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('parseSecretProxyRule', () => {
  it('accepts the shapes the proxy can act on', () => {
    expect(parseSecretProxyRule('K', { hosts: ['a.com'] })).toEqual({ hosts: ['a.com'] })
    expect(parseSecretProxyRule('K', {
      hosts: ['a.com'], path: '/oauth/*', bodyParam: 'client_secret',
    })).toEqual({ hosts: ['a.com'], path: '/oauth/*', bodyParam: 'client_secret' })
    expect(parseSecretProxyRule('K', {
      hosts: ['a.com'], header: 'x-key', prefix: 'Token ',
    })).toEqual({ hosts: ['a.com'], header: 'x-key', prefix: 'Token ' })
  })

  it('refuses a rule that would be dropped silently inside the proxy', () => {
    // Each of these fails much later otherwise — inside the proxy, on a
    // request nobody is watching, with the credential simply not arriving.
    expect(() => parseSecretProxyRule('K', 'nope')).toThrow(/needs a rule/)
    expect(() => parseSecretProxyRule('K', { hosts: [] })).toThrow(/non-empty list/)
    expect(() => parseSecretProxyRule('K', { hosts: ['a.com'], path: 5 })).toThrow(/path must be/)
    expect(() => parseSecretProxyRule('K', {
      hosts: ['a.com'], header: 'x', bodyParam: 'y',
    })).toThrow(/cannot have both/)
  })

  it('refuses a blank header or body param, which would send the secret elsewhere', () => {
    // The dangerous case, not a harmless one: the rule builder asks
    // `if (rule.bodyParam)`, so a present-but-blank one falls through to the
    // default `authorization: Bearer <secret>` — the credential leaving in a
    // header nobody configured. The UI sends exactly this when "Body
    // parameter" is picked and the field left empty.
    expect(() => parseSecretProxyRule('K', { hosts: ['a.com'], bodyParam: '' }))
      .toThrow(/bodyParam cannot be empty/)
    expect(() => parseSecretProxyRule('K', { hosts: ['a.com'], bodyParam: '   ' }))
      .toThrow(/bodyParam cannot be empty/)
    expect(() => parseSecretProxyRule('K', { hosts: ['a.com'], header: '' }))
      .toThrow(/header cannot be empty/)
    // Absent still means "use the default authorization header".
    expect(parseSecretProxyRule('K', { hosts: ['a.com'] })).toEqual({ hosts: ['a.com'] })
  })
})

describe('setProjectEnvVar', () => {
  it('stores a plain variable and hands it straight back', async () => {
    expect(await setProjectEnvVar('demo', { name: 'NODE_ENV', value: 'development' }))
      .toMatchObject({ name: 'NODE_ENV', value: 'development', secret: false, hasValue: true })
  })

  it('refuses a name no shell would take', async () => {
    await expect(setProjectEnvVar('demo', { name: '9LIVES', value: 'x' }))
      .rejects.toThrow(/not a valid environment variable name/)
    await expect(setProjectEnvVar('demo', { name: 'has space', value: 'x' }))
      .rejects.toThrow(/not a valid environment variable name/)
  })

  it('requires a value for a new secret, and a rule for any secret', async () => {
    // A secret with no value is a row the create path skips: it would read as
    // "saved" on the settings page and behave as absent in the worktree.
    await expect(setProjectEnvVar('demo', { name: 'K', secret: true, rule: RULE }))
      .rejects.toThrow(/value is required for a new secret/)
    await expect(setProjectEnvVar('demo', { name: 'K', value: 'v', secret: true }))
      .rejects.toThrow(/needs a rule/)
  })

  it('still demands a value for a secret imported without one', async () => {
    // The legacy importer stores an unresolvable secret as `''`. A rule-only
    // edit on one must not report success while `resolveProjectEnv` goes on
    // dropping it — the row would read as saved and behave as absent.
    await upsertProjectEnvVar('demo', { name: 'IMPORTED', value: '', secret: true, rule: RULE })

    await expect(setProjectEnvVar('demo', { name: 'IMPORTED', secret: true, rule: RULE }))
      .rejects.toThrow(/value is required for a new secret/)
  })

  it('lets a rule be edited without the secret travelling again', async () => {
    await setProjectEnvVar('demo', { name: 'K', value: 'sekrit', secret: true, rule: RULE })
    const saved = await setProjectEnvVar('demo', {
      name: 'K',
      secret: true,
      rule: { hosts: ['other.example.com'], bodyParam: 'client_secret' },
    })

    expect(saved.hasValue).toBe(true)
    expect((await resolveProjectEnv('demo')).secrets.K).toEqual({
      value: 'sekrit',
      rule: { hosts: ['other.example.com'], bodyParam: 'client_secret' },
    })
  })

  it('404s for a project that does not exist', async () => {
    await expect(setProjectEnvVar('nope', { name: 'A', value: '1' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('listProjectEnv', () => {
  it('gives a plain value back and a secret’s never', async () => {
    await setProjectEnvVar('demo', { name: 'PLAIN', value: 'visible' })
    await setProjectEnvVar('demo', { name: 'SECRET', value: 'sekrit', secret: true, rule: RULE })

    const vars = await listProjectEnv('demo')
    expect(vars).toEqual([
      { id: expect.any(String) as string, name: 'PLAIN', secret: false, hasValue: true, value: 'visible' },
      { id: expect.any(String) as string, name: 'SECRET', secret: true, hasValue: true, rule: RULE },
    ])
    expect(JSON.stringify(vars)).not.toContain('sekrit')
  })

  it('says a secret has no usable value when its key is gone', async () => {
    // `hasValue: false` is what the UI turns into "enter it again", and it
    // has to cover both "never supplied" and "no longer decrypts".
    await upsertProjectEnvVar('demo', { name: 'BLANK', value: '', secret: true, rule: RULE })
    expect(await listProjectEnv('demo')).toMatchObject([{ name: 'BLANK', hasValue: false }])
  })
})

describe('removeProjectEnvVar', () => {
  it('removes by id and 404s for one this project does not have', async () => {
    const saved = await setProjectEnvVar('demo', { name: 'A', value: '1' })

    await expect(removeProjectEnvVar('demo', '00000000-0000-4000-8000-000000000000'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })

    await removeProjectEnvVar('demo', saved.id)
    expect(await listProjectEnv('demo')).toEqual([])
  })
})

describe('resolveProjectEnv', () => {
  it('splits what a worktree gets from what the proxy injects', async () => {
    await setProjectEnvVar('demo', { name: 'PLAIN', value: 'v' })
    await setProjectEnvVar('demo', { name: 'SECRET', value: 'sekrit', secret: true, rule: RULE })

    expect(await resolveProjectEnv('demo')).toEqual({
      plain: { PLAIN: 'v' },
      secrets: { SECRET: { value: 'sekrit', rule: RULE } },
    })
  })

  it('drops a secret with nothing behind it rather than injecting empty', async () => {
    // An empty header fails upstream as a BAD credential rather than a
    // missing one, which sends whoever debugs it after the wrong thing.
    await upsertProjectEnvVar('demo', { name: 'BLANK', value: '', secret: true, rule: RULE })
    await upsertProjectEnvVar('demo', { name: 'NO_RULE', value: 'v', secret: true })

    expect(await resolveProjectEnv('demo')).toEqual({ plain: {}, secrets: {} })
  })
})
