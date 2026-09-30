import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import {
  seedClaudeJson,
  seedClaudeSettings,
} from '#domain/workspaces/seed'
import { openRoot, type ConfinedRoot } from '#lib/confined-fs'

let dir: string
let file: string
/** The claude home as a sandboxing runtime opens it. */
let home: ConfinedRoot

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-claudejson-'))
  file = path.join(dir, '.claude.json')
  home = await openRoot(dir, 'no-links')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function read(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
}

describe('seedClaudeJson', () => {
  it('seeds onboarding + trust flags', async () => {
    await seedClaudeJson(home, ['/workspace', '/repo'])
    const j = await read()
    expect(j.hasCompletedOnboarding).toBe(true)
    expect(typeof j.lastOnboardingVersion).toBe('string')
    expect(j.projects).toMatchObject({
      '/workspace': { hasTrustDialogAccepted: true },
      '/repo': { hasTrustDialogAccepted: true },
    })
    expect((j.customApiKeyResponses as { approved: string[] }).approved).toContain('yaac-ph-api-key')
  })

  it('trusts the roots it is handed, not the pod layout', async () => {
    // A containerless agent runs in the real checkout, where a `/workspace`
    // entry would match nothing and the trust dialog would still open. Each
    // driver therefore passes its own roots.
    const wt = path.join(dir, 'projects', 'demo', 'workspaces', 'abc')
    const repo = path.join(dir, 'projects', 'demo', 'repo')
    await seedClaudeJson(home, [wt, repo])
    const projects = (await read()).projects as Record<string, unknown>
    expect(projects[wt]).toEqual({ hasTrustDialogAccepted: true })
    expect(projects[repo]).toEqual({ hasTrustDialogAccepted: true })
    expect(projects['/workspace']).toBeUndefined()
  })

  it('accumulates workspace roots across creates instead of replacing them', async () => {
    // A project's containerless workspaces have separate paths but share
    // one claude.json, so a second create must keep the first one trusted.
    const first = path.join(dir, 'workspaces', 'one')
    const second = path.join(dir, 'workspaces', 'two')
    await seedClaudeJson(home, [first])
    await seedClaudeJson(home, [second])
    const projects = (await read()).projects as Record<string, unknown>
    expect(projects[first]).toEqual({ hasTrustDialogAccepted: true })
    expect(projects[second]).toEqual({ hasTrustDialogAccepted: true })
  })

  it('preserves claude-code own keys when merging', async () => {
    await fs.writeFile(file, JSON.stringify({ oauthAccount: { uuid: 'x' }, theme: 'dark' }))
    await seedClaudeJson(home, ['/workspace', '/repo'])
    const j = await read()
    expect(j.oauthAccount).toEqual({ uuid: 'x' })
    expect(j.theme).toBe('dark')
    expect(j.hasCompletedOnboarding).toBe(true)
  })

  it('does not clobber an existing approved API key list', async () => {
    await fs.writeFile(file, JSON.stringify({
      customApiKeyResponses: { approved: ['other-key'], rejected: ['nope'] },
    }))
    await seedClaudeJson(home, ['/workspace', '/repo'])
    const j = await read()
    const responses = j.customApiKeyResponses as { approved: string[]; rejected: string[] }
    expect(responses.approved).toContain('other-key')
    expect(responses.approved).toContain('yaac-ph-api-key')
    expect(responses.rejected).toEqual(['nope'])
  })

  it('starts fresh when the existing file is invalid JSON', async () => {
    await fs.writeFile(file, 'not json{')
    await seedClaudeJson(home, ['/workspace', '/repo'])
    const j = await read()
    expect(j.hasCompletedOnboarding).toBe(true)
  })
})

describe('seedClaudeSettings', () => {
  it('sets skipDangerousModePermissionPrompt, preserving existing settings', async () => {
    const settings = path.join(dir, 'settings.json')
    await fs.writeFile(settings, JSON.stringify({ theme: 'dark' }))
    await seedClaudeSettings(home)
    const j = JSON.parse(await fs.readFile(settings, 'utf8')) as Record<string, unknown>
    expect(j.skipDangerousModePermissionPrompt).toBe(true)
    expect(j.theme).toBe('dark')
  })

  it('creates the file when missing', async () => {
    const settings = path.join(dir, 'settings.json')
    await seedClaudeSettings(home)
    const j = JSON.parse(await fs.readFile(settings, 'utf8')) as Record<string, unknown>
    expect(j.skipDangerousModePermissionPrompt).toBe(true)
  })

  it('retains transcripts for 100 years instead of the 30-day default', async () => {
    const settings = path.join(dir, 'settings.json')
    await seedClaudeSettings(home)
    const j = JSON.parse(await fs.readFile(settings, 'utf8')) as Record<string, unknown>
    expect(j.cleanupPeriodDays).toBe(36500)
  })

  it('overrides a shorter existing cleanupPeriodDays', async () => {
    const settings = path.join(dir, 'settings.json')
    await fs.writeFile(settings, JSON.stringify({ cleanupPeriodDays: 30 }))
    await seedClaudeSettings(home)
    const j = JSON.parse(await fs.readFile(settings, 'utf8')) as Record<string, unknown>
    expect(j.cleanupPeriodDays).toBe(36500)
  })

  it('replaces a link planted in its place, leaving what it named untouched', async () => {
    // A pod can plant a symlink in its tool home; following it would let
    // every create rewrite or clobber the file it points at.
    const target = path.join(dir, 'elsewhere.db')
    await fs.writeFile(target, 'not json, and not yours')
    const settings = path.join(dir, 'settings.json')
    await fs.symlink(target, settings)
    await seedClaudeSettings(home)
    expect(await fs.readFile(target, 'utf8')).toBe('not json, and not yours')
    expect((await fs.lstat(settings)).isFile()).toBe(true)
    expect(JSON.parse(await fs.readFile(settings, 'utf8'))).toMatchObject({ skipDangerousModePermissionPrompt: true })
  })
})
