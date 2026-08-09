import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { seedClaudeJson, seedClaudeSettings } from '#features/worktrees/seed'

let dir: string
let file: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-claudejson-'))
  file = path.join(dir, 'claude.json')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function read(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
}

describe('seedClaudeJson', () => {
  it('seeds onboarding + trust flags', async () => {
    await seedClaudeJson(file)
    const j = await read()
    expect(j.hasCompletedOnboarding).toBe(true)
    expect(typeof j.lastOnboardingVersion).toBe('string')
    expect(j.projects).toMatchObject({
      '/workspace': { hasTrustDialogAccepted: true },
      '/repo': { hasTrustDialogAccepted: true },
    })
    expect((j.customApiKeyResponses as { approved: string[] }).approved).toContain('yaac-ph-api-key')
  })

  it('preserves claude-code own keys when merging', async () => {
    await fs.writeFile(file, JSON.stringify({ oauthAccount: { uuid: 'x' }, theme: 'dark' }))
    await seedClaudeJson(file)
    const j = await read()
    expect(j.oauthAccount).toEqual({ uuid: 'x' })
    expect(j.theme).toBe('dark')
    expect(j.hasCompletedOnboarding).toBe(true)
  })

  it('does not clobber an existing approved API key list', async () => {
    await fs.writeFile(file, JSON.stringify({
      customApiKeyResponses: { approved: ['other-key'], rejected: ['nope'] },
    }))
    await seedClaudeJson(file)
    const j = await read()
    const responses = j.customApiKeyResponses as { approved: string[]; rejected: string[] }
    expect(responses.approved).toContain('other-key')
    expect(responses.approved).toContain('yaac-ph-api-key')
    expect(responses.rejected).toEqual(['nope'])
  })

  it('starts fresh when the existing file is invalid JSON', async () => {
    await fs.writeFile(file, 'not json{')
    await seedClaudeJson(file)
    const j = await read()
    expect(j.hasCompletedOnboarding).toBe(true)
  })
})

describe('seedClaudeSettings', () => {
  it('sets skipDangerousModePermissionPrompt, preserving existing settings', async () => {
    const settings = path.join(dir, 'settings.json')
    await fs.writeFile(settings, JSON.stringify({ theme: 'dark' }))
    await seedClaudeSettings(settings)
    const j = JSON.parse(await fs.readFile(settings, 'utf8')) as Record<string, unknown>
    expect(j.skipDangerousModePermissionPrompt).toBe(true)
    expect(j.theme).toBe('dark')
  })

  it('creates the file when missing', async () => {
    const settings = path.join(dir, 'settings.json')
    await seedClaudeSettings(settings)
    const j = JSON.parse(await fs.readFile(settings, 'utf8')) as Record<string, unknown>
    expect(j.skipDangerousModePermissionPrompt).toBe(true)
  })

  it('retains transcripts for 100 years instead of the 30-day default', async () => {
    const settings = path.join(dir, 'settings.json')
    await seedClaudeSettings(settings)
    const j = JSON.parse(await fs.readFile(settings, 'utf8')) as Record<string, unknown>
    expect(j.cleanupPeriodDays).toBe(36500)
  })

  it('overrides a shorter existing cleanupPeriodDays', async () => {
    const settings = path.join(dir, 'settings.json')
    await fs.writeFile(settings, JSON.stringify({ cleanupPeriodDays: 30 }))
    await seedClaudeSettings(settings)
    const j = JSON.parse(await fs.readFile(settings, 'utf8')) as Record<string, unknown>
    expect(j.cleanupPeriodDays).toBe(36500)
  })
})
