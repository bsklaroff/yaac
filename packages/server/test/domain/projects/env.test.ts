import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DEMO_PROJECT_ID } from '@yaac/test-utils/project-fixture'
import fs from 'node:fs/promises'
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

const NOPE = '4101bef8-794f-4d98-8e95-dfb54850c68b'

/**
 * A project's environment above the store: validating what a client sends (a
 * valid shell name, a rule the proxy can act on), and never returning a
 * secret's value.
 */

let tmpDir: string

const RULE = { hosts: ['api.example.com'], header: 'x-api-key' }

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await fs.mkdir(projectDir(DEMO_PROJECT_ID), { recursive: true })
  await recordProject({ id: DEMO_PROJECT_ID, name: 'demo', remoteUrl: 'https://github.com/o/r.git', addedAt: 'now' })
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
    // Otherwise each fails later inside the proxy, where the credential
    // silently never arrives.
    expect(() => parseSecretProxyRule('K', NOPE)).toThrow(/needs a rule/)
    expect(() => parseSecretProxyRule('K', { hosts: [] })).toThrow(/non-empty list/)
    expect(() => parseSecretProxyRule('K', { hosts: ['a.com'], path: 5 })).toThrow(/path must be/)
    expect(() => parseSecretProxyRule('K', {
      hosts: ['a.com'], header: 'x', bodyParam: 'y',
    })).toThrow(/cannot have both/)
  })

  it('refuses a blank header or body param, which would send the secret elsewhere', () => {
    // The rule builder checks `if (rule.bodyParam)`, so a blank value falls
    // through to the default `authorization: Bearer <secret>` header. The UI
    // sends this when "Body parameter" is picked and the field left empty.
    expect(() => parseSecretProxyRule('K', { hosts: ['a.com'], bodyParam: '' }))
      .toThrow(/bodyParam cannot be empty/)
    expect(() => parseSecretProxyRule('K', { hosts: ['a.com'], bodyParam: '   ' }))
      .toThrow(/bodyParam cannot be empty/)
    expect(() => parseSecretProxyRule('K', { hosts: ['a.com'], header: '' }))
      .toThrow(/header cannot be empty/)
    // Absent still means the default authorization header.
    expect(parseSecretProxyRule('K', { hosts: ['a.com'] })).toEqual({ hosts: ['a.com'] })
  })
})

describe('setProjectEnvVar', () => {
  it('stores a plain variable and hands it straight back', async () => {
    expect(await setProjectEnvVar(DEMO_PROJECT_ID, { name: 'NODE_ENV', value: 'development' }))
      .toMatchObject({ name: 'NODE_ENV', value: 'development', secret: false, hasValue: true })
  })

  it('refuses a name no shell would take', async () => {
    await expect(setProjectEnvVar(DEMO_PROJECT_ID, { name: '9LIVES', value: 'x' }))
      .rejects.toThrow(/not a valid environment variable name/)
    await expect(setProjectEnvVar(DEMO_PROJECT_ID, { name: 'has space', value: 'x' }))
      .rejects.toThrow(/not a valid environment variable name/)
  })

  it('requires a value for a new secret, and a rule for any secret', async () => {
    // A valueless secret would show as saved but be skipped at create.
    await expect(setProjectEnvVar(DEMO_PROJECT_ID, { name: 'K', secret: true, rule: RULE }))
      .rejects.toThrow(/value is required for a new secret/)
    await expect(setProjectEnvVar(DEMO_PROJECT_ID, { name: 'K', value: 'v', secret: true }))
      .rejects.toThrow(/needs a rule/)
  })

  it('still demands a value for a secret imported without one', async () => {
    // The legacy importer stores an unresolvable secret as `''`, which
    // `resolveProjectEnv` drops, so a rule-only edit must not succeed.
    await upsertProjectEnvVar(DEMO_PROJECT_ID, { name: 'IMPORTED', value: '', secret: true, rule: RULE })

    await expect(setProjectEnvVar(DEMO_PROJECT_ID, { name: 'IMPORTED', secret: true, rule: RULE }))
      .rejects.toThrow(/value is required for a new secret/)
  })

  it('lets a rule be edited without the secret travelling again', async () => {
    await setProjectEnvVar(DEMO_PROJECT_ID, { name: 'K', value: 'sekrit', secret: true, rule: RULE })
    const saved = await setProjectEnvVar(DEMO_PROJECT_ID, {
      name: 'K',
      secret: true,
      rule: { hosts: ['other.example.com'], bodyParam: 'client_secret' },
    })

    expect(saved.hasValue).toBe(true)
    expect((await resolveProjectEnv(DEMO_PROJECT_ID)).secrets.K).toEqual({
      value: 'sekrit',
      rule: { hosts: ['other.example.com'], bodyParam: 'client_secret' },
    })
  })

  it('404s for a project that does not exist', async () => {
    await expect(setProjectEnvVar(NOPE, { name: 'A', value: '1' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('listProjectEnv', () => {
  it('gives a plain value back and a secret’s never', async () => {
    await setProjectEnvVar(DEMO_PROJECT_ID, { name: 'PLAIN', value: 'visible' })
    await setProjectEnvVar(DEMO_PROJECT_ID, { name: 'SECRET', value: 'sekrit', secret: true, rule: RULE })

    const vars = await listProjectEnv(DEMO_PROJECT_ID)
    expect(vars).toEqual([
      { id: expect.any(String) as string, name: 'PLAIN', secret: false, hasValue: true, value: 'visible' },
      { id: expect.any(String) as string, name: 'SECRET', secret: true, hasValue: true, rule: RULE },
    ])
    expect(JSON.stringify(vars)).not.toContain('sekrit')
  })

  it('says a secret has no usable value when its key is gone', async () => {
    // The UI asks to re-enter a value when `hasValue` is false, which covers
    // both "never supplied" and "no longer decrypts".
    await upsertProjectEnvVar(DEMO_PROJECT_ID, { name: 'BLANK', value: '', secret: true, rule: RULE })
    expect(await listProjectEnv(DEMO_PROJECT_ID)).toMatchObject([{ name: 'BLANK', hasValue: false }])
  })
})

describe('removeProjectEnvVar', () => {
  it('removes by id and 404s for one this project does not have', async () => {
    const saved = await setProjectEnvVar(DEMO_PROJECT_ID, { name: 'A', value: '1' })

    await expect(removeProjectEnvVar(DEMO_PROJECT_ID, '00000000-0000-4000-8000-000000000000'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })

    await removeProjectEnvVar(DEMO_PROJECT_ID, saved.id)
    expect(await listProjectEnv(DEMO_PROJECT_ID)).toEqual([])
  })
})

describe('resolveProjectEnv', () => {
  it('splits what a workspace gets from what the proxy injects', async () => {
    await setProjectEnvVar(DEMO_PROJECT_ID, { name: 'PLAIN', value: 'v' })
    await setProjectEnvVar(DEMO_PROJECT_ID, { name: 'SECRET', value: 'sekrit', secret: true, rule: RULE })

    expect(await resolveProjectEnv(DEMO_PROJECT_ID)).toEqual({
      plain: { PLAIN: 'v' },
      secrets: { SECRET: { value: 'sekrit', rule: RULE } },
    })
  })

  it('drops a secret with nothing behind it rather than injecting empty', async () => {
    // An empty header would fail upstream as a bad credential rather than a
    // missing one, which misleads debugging.
    await upsertProjectEnvVar(DEMO_PROJECT_ID, { name: 'BLANK', value: '', secret: true, rule: RULE })
    await upsertProjectEnvVar(DEMO_PROJECT_ID, { name: 'NO_RULE', value: 'v', secret: true })

    expect(await resolveProjectEnv(DEMO_PROJECT_ID)).toEqual({ plain: {}, secrets: {} })
  })
})
