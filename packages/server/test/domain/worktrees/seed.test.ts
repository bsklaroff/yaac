import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import {
  adoptLegacyClaudeJson,
  seedClaudeJson,
  seedClaudeSettings,
} from '#domain/worktrees/seed'

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
    await seedClaudeJson(file, ['/workspace', '/repo'])
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
    // A containerless worktree has no mount namespace, so the agent opens
    // the real checkout and a `/workspace` entry matches nothing it will
    // ever cd into — the file looks seeded and the trust dialog opens
    // anyway. Naming the roots at the call site is what makes that a
    // decision each driver states rather than a constant that is right for
    // one of them.
    const wt = path.join(dir, 'projects', 'demo', 'worktrees', 'abc')
    const repo = path.join(dir, 'projects', 'demo', 'repo')
    await seedClaudeJson(file, [wt, repo])
    const projects = (await read()).projects as Record<string, unknown>
    expect(projects[wt]).toEqual({ hasTrustDialogAccepted: true })
    expect(projects[repo]).toEqual({ hasTrustDialogAccepted: true })
    expect(projects['/workspace']).toBeUndefined()
  })

  it('accumulates worktree roots across creates instead of replacing them', async () => {
    // Every containerless worktree of a project is its own path, and they
    // share one claude.json — so the second create must not cost the first
    // its trust.
    const first = path.join(dir, 'worktrees', 'one')
    const second = path.join(dir, 'worktrees', 'two')
    await seedClaudeJson(file, [first])
    await seedClaudeJson(file, [second])
    const projects = (await read()).projects as Record<string, unknown>
    expect(projects[first]).toEqual({ hasTrustDialogAccepted: true })
    expect(projects[second]).toEqual({ hasTrustDialogAccepted: true })
  })

  it('preserves claude-code own keys when merging', async () => {
    await fs.writeFile(file, JSON.stringify({ oauthAccount: { uuid: 'x' }, theme: 'dark' }))
    await seedClaudeJson(file, ['/workspace', '/repo'])
    const j = await read()
    expect(j.oauthAccount).toEqual({ uuid: 'x' })
    expect(j.theme).toBe('dark')
    expect(j.hasCompletedOnboarding).toBe(true)
  })

  it('does not clobber an existing approved API key list', async () => {
    await fs.writeFile(file, JSON.stringify({
      customApiKeyResponses: { approved: ['other-key'], rejected: ['nope'] },
    }))
    await seedClaudeJson(file, ['/workspace', '/repo'])
    const j = await read()
    const responses = j.customApiKeyResponses as { approved: string[]; rejected: string[] }
    expect(responses.approved).toContain('other-key')
    expect(responses.approved).toContain('yaac-ph-api-key')
    expect(responses.rejected).toEqual(['nope'])
  })

  it('starts fresh when the existing file is invalid JSON', async () => {
    await fs.writeFile(file, 'not json{')
    await seedClaudeJson(file, ['/workspace', '/repo'])
    const j = await read()
    expect(j.hasCompletedOnboarding).toBe(true)
  })
})

describe('adoptLegacyClaudeJson', () => {
  it('carries a pre-move config to where claude reads it now', async () => {
    // The old file is all an install that predates the config-dir naming has:
    // claude's own oauthAccount and migration bookkeeping, plus trust roots
    // the seed does not name. Losing it looks like a brand-new worktree.
    const legacy = path.join(dir, 'claude.json')
    await fs.writeFile(legacy, JSON.stringify({
      oauthAccount: { uuid: 'x' },
      projects: { '/some/other/checkout': { hasTrustDialogAccepted: true } },
    }))
    await adoptLegacyClaudeJson(legacy, file)
    const j = await read()
    expect(j.oauthAccount).toEqual({ uuid: 'x' })
    expect(j.projects).toMatchObject({
      '/some/other/checkout': { hasTrustDialogAccepted: true },
    })
  })

  it('never walks a newer config backwards', async () => {
    // Runs on every create, so the destination has to win the moment it
    // exists — otherwise each create would overwrite what claude has written
    // since with whatever the pre-move file froze.
    const legacy = path.join(dir, 'claude.json')
    await fs.writeFile(legacy, JSON.stringify({ oauthAccount: { uuid: 'stale' } }))
    await fs.writeFile(file, JSON.stringify({ oauthAccount: { uuid: 'current' } }))
    await adoptLegacyClaudeJson(legacy, file)
    expect((await read()).oauthAccount).toEqual({ uuid: 'current' })
  })

  it('is a no-op on a fresh install, which is every install eventually', async () => {
    await adoptLegacyClaudeJson(path.join(dir, 'claude.json'), file)
    await expect(fs.access(file)).rejects.toThrow()
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
