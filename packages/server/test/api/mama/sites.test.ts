/**
 * `yaac-mama site …` (docs/public-sites.md): an agent builds and manages
 * its project's unpublished sites, and its deploy of a published one waits
 * for a person. The sites feature runs for real against the fake driver.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { publishSite } from '#domain/sites'
import type { MamaOutcome } from '#api/mama/commands'
import { runSiteCommand } from '#api/mama/sites'
import { callerAs } from '#test/support/mama'
import { createWorkflow } from '#domain/projects'
import { BUILT_IN_USER_ID, findSiteByName, updateSite } from '#db'
import { closeDb } from '#db/client'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import { git } from '@yaac/test-utils/git'
import { repoDir } from '@yaac/shared/project-paths'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import { DEMO_PROJECT_ID, seedProject } from '@yaac/test-utils/project-fixture'
import { workspaceDelegate } from '#test/support/delegate'

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const caller = callerAs(workspaceDelegate(BUILT_IN_USER_ID, 'w-agent', { projectId: DEMO_PROJECT_ID }))

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await seedProject()
  await createWorkflow(local, DEMO_PROJECT_ID, { name: 'app', steps: { app: { run: 'pnpm start', service: true } } })
  installFakeWorkspaceDriver({ syncSites: () => Promise.resolve() })
})

afterEach(async () => {
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

const run = (command: string, args: Record<string, string> = {}, body = ''): Promise<MamaOutcome> =>
  runSiteCommand(caller, { command, args, body })

async function output(command: string, args: Record<string, string> = {}): Promise<string> {
  const outcome = await run(command, args)
  if (!outcome.ok || !('output' in outcome)) throw new Error(`expected text, got ${JSON.stringify(outcome)}`)
  return outcome.output
}

describe('runSiteCommand', () => {
  it('builds, shows, edits and deletes an unpublished site, and asks a person to deploy a published one', async () => {
    expect(await output('site-list')).toBe('This project has no sites.')
    expect(await output('site-create', { name: 'shop', port: '3000', workflow: 'app', repos: '["demo@main"]', 'admin-port': '3001', follow: '1' }))
      .toContain('created site shop, unpublished')
    expect(await findSiteByName(DEMO_PROJECT_ID, 'shop')).toMatchObject({
      published: false, port: 3000, adminPort: 3001, follow: true, repos: [{ repo: DEMO_PROJECT_ID, branch: 'main' }],
    })
    expect(await output('site-list')).toMatch(/^shop\s+unpublished\s+port 3000\s+live -$/)
    expect(await output('site-edit', { name: 'shop', port: '4000', 'no-admin-port': '1', 'no-follow': '1', 'deploy-timeout': '2h' }))
      .toBe('updated site shop; its next deploy uses the change')
    expect(await findSiteByName(DEMO_PROJECT_ID, 'shop')).toMatchObject({ port: 4000, follow: false, deployTimeoutMinutes: 120 })
    for (const timeout of ['soon', '1d1m']) {
      await expect(run('site-edit', { name: 'shop', 'deploy-timeout': timeout })).rejects.toMatchObject({
        code: 'VALIDATION', message: `--deploy-timeout takes a duration from 1m to 1d, like 30m or 2h (got "${timeout}")`,
      })
    }
    expect(await output('site-show', { name: 'shop' })).toContain('workflow app; repos demo@main')
    expect(await output('site-show', { name: 'shop' })).toContain('; deploy timeout 2h')

    // Published by a person, its deploy is a person's to make.
    await publishSite(local, DEMO_PROJECT_ID, 'shop', { hostname: 'shop.example.com' })
    expect(await output('site-list')).toMatch(/^shop\s+published at https:\/\/shop\.example\.com\s+port 4000/)
    const head = (await git(repoDir(DEMO_PROJECT_ID), ['rev-parse', 'origin/main'])).trim()
    expect(await output('site-deploy', { name: 'shop', refs: JSON.stringify([head]) }))
      .toBe(`deploying ${head.slice(0, 8)} needs a person's approval: it is site shop's requested deploy until a person deploys it`)
    expect(await output('site-list')).toContain(`requested ${head.slice(0, 8)}, awaiting a person's approval`)
    await expect(run('site-stop', { name: 'shop' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(run('site-delete', { name: 'shop' })).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await updateSite((await findSiteByName(DEMO_PROJECT_ID, 'shop'))!.id, { published: false, hostname: null })
    expect(await output('site-stop', { name: 'shop' })).toBe('stopped site shop')
    expect(await output('site-delete', { name: 'shop' })).toBe('deleted site shop')
    expect(await output('site-list')).toBe('This project has no sites.')
  })

  it('refuses what it cannot parse before acting', async () => {
    const refusals: Array<[string, Record<string, string>, string]> = [
      ['site-create', { name: 'shop' }, 'site create needs --port, --workflow and at least one --repo <dir>@<branch or commit>'],
      ['site-show', {}, 'site show needs a site name'],
      ['site-edit', { name: 'shop' }, 'site edit needs something to change'],
      ['site-edit', { name: 'shop', follow: '1', 'no-follow': '1' }, 'give --follow or --no-follow, not both'],
      ['site-deploy', { name: 'shop', refs: '["main","dev"]' }, 'give one bare --ref, for a site of one repo; name each repo\'s as --ref <dir>@<ref>'],
    ]
    for (const [command, args, error] of refusals) expect(await run(command, args)).toEqual({ ok: false, error })
    expect(await run('site-list', {}, 'a prompt')).toEqual({ ok: false, error: 'site-list takes no prompt' })
    await expect(run('site-create', { name: 'shop', port: 'x', workflow: 'app', repos: '["demo@main"]' }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(run('site-create', { name: 'shop', port: '3000', workflow: 'app', repos: '["demo"]' }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
