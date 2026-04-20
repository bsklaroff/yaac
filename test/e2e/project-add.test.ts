import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@test/helpers/setup'
import { bootInProcessDaemon, type InProcessDaemon } from '@test/helpers/daemon'
import { expandOwnerRepo, projectAdd, validateGithubHttpsUrl } from '@/commands/project-add'
import { exitOnClientError } from '@/lib/daemon-client'

// Stub the interactive auth-update flow the daemon-client invokes on
// AUTH_REQUIRED. In an e2e test with no stdin, the real readline prompt
// would hang the worker.
vi.mock('@/commands/auth-update', () => ({
  authUpdate: vi.fn().mockResolvedValue(undefined),
}))

describe('yaac project add', () => {
  let tmpDir: string
  let daemon: InProcessDaemon
  let exitSpy: MockInstance<(code?: number) => never>

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    daemon = await bootInProcessDaemon()
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`)
    }) as never)
  })

  afterEach(async () => {
    exitSpy.mockRestore()
    await daemon.stop()
    await cleanupTempDir(tmpDir)
  })

  async function run(input: string): Promise<{ errs: string[] }> {
    const errs: string[] = []
    const origErr = console.error
    console.error = (msg: string) => errs.push(msg)
    try {
      await projectAdd(input)
    } catch (err) {
      // Mirror the CLI entry point: surface thrown errors via
      // exitOnClientError so the exitSpy fires with code 1.
      try { exitOnClientError(err) } catch { /* exitSpy throws */ }
    }
    console.error = origErr
    return { errs }
  }

  it('rejects SSH-style git URLs with helpful message', async () => {
    const { errs } = await run('git@github.com:org/repo.git')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errs.join('\n')).toContain('HTTPS')
  })

  it('rejects non-HTTPS protocols', async () => {
    const { errs } = await run('http://github.com/org/repo')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errs.join('\n')).toContain('HTTPS')
  })

  it('rejects non-GitHub hosts', async () => {
    const { errs } = await run('https://gitlab.com/org/repo')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errs.join('\n')).toContain('GitHub')
  })

  it('rejects invalid URLs', async () => {
    const { errs } = await run('not-a-url')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errs.join('\n')).toContain('Invalid URL')
  })

  it('errors gracefully on duplicate slug (CONFLICT → exit 1)', async () => {
    // Pre-create the project directory to trigger CONFLICT from addProject.
    const projectsDir = path.join(getDataDir(), 'projects', 'repo')
    await fs.mkdir(projectsDir, { recursive: true })

    const { errs } = await run('https://github.com/org/repo')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errs.join('\n')).toContain('already exists')
  })

  it('expands owner/repo shorthand to GitHub HTTPS URL', () => {
    expect(expandOwnerRepo('acme/repo')).toBe('https://github.com/acme/repo')
    expect(expandOwnerRepo('my-user/my-project')).toBe('https://github.com/my-user/my-project')
  })

  it('does not expand full URLs', () => {
    expect(expandOwnerRepo('https://github.com/org/repo')).toBe('https://github.com/org/repo')
    expect(expandOwnerRepo('git@github.com:org/repo')).toBe('git@github.com:org/repo')
  })

  it('validates expanded owner/repo as valid GitHub URL', () => {
    const url = expandOwnerRepo('acme/repo')
    expect(() => validateGithubHttpsUrl(url)).not.toThrow()
  })

  it('errors when no matching token is configured (AUTH_REQUIRED → exit 1)', async () => {
    // No token configured; the daemon surfaces AUTH_REQUIRED which the
    // client normally retries via authUpdate. In a test shell we inject
    // a no-op onAuthRequired so the retry passes through and the second
    // AUTH_REQUIRED surfaces as an exit-1 error.
    const { errs } = await run('https://github.com/org/repo-no-token')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errs.join('\n')).toContain('No GitHub token configured')
  })

  it('rejects local file paths', async () => {
    const { errs } = await run('/tmp/some-local-repo')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errs.length).toBeGreaterThan(0)
  })
})
