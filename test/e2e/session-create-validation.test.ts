import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir, createTestRepo, addTestProject } from '@test/helpers/setup'
import { bootInProcessDaemon, type InProcessDaemon } from '@test/helpers/daemon'
import { exitOnClientError } from '@/lib/daemon-client'
import type * as gitModule from '@/lib/git'

// Provide a deterministic git identity so sessionCreate doesn't try to
// readline-prompt for it in the CI shell.
vi.mock('@/lib/git', async () => {
  const actual = await vi.importActual<typeof gitModule>('@/lib/git')
  return {
    ...actual,
    getGitUserConfig: vi.fn().mockResolvedValue({ name: 'Test', email: 't@x.io' }),
  }
})

describe('yaac session create — validation failures', () => {
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

  it('rejects unknown tool with VALIDATION', async () => {
    // Set up a project so sessionCreate gets past the projectDir() check.
    const repo = path.join(tmpDir, 'demo')
    await createTestRepo(repo)
    await addTestProject(repo)

    const { sessionCreate } = await import('@/commands/session-create')

    const errs: string[] = []
    const origErr = console.error
    console.error = (msg: string) => errs.push(msg)
    try {
      // Cast to bypass the AgentTool type check — at runtime we want to
      // drive the daemon-side validation.
      await sessionCreate('demo', { tool: 'mystery' as unknown as 'claude' })
    } catch (err) {
      try { exitOnClientError(err) } catch { /* exit spy throws */ }
    }
    console.error = origErr

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errs.join('\n').toLowerCase()).toContain('tool')
  })

  it('exits 1 when the project does not exist', async () => {
    const { sessionCreate } = await import('@/commands/session-create')

    // Suppress console output
    const origErr = console.error
    const origLog = console.log
    console.error = () => {}
    console.log = () => {}
    try {
      await sessionCreate('missing', {})
    } catch {
      // might or might not call exit depending on error path
    }
    console.error = origErr
    console.log = origLog

    // sessionCreate sets process.exitCode = 1 in this path (early return,
    // not a daemon call), so process.exit is not spied — assert exitCode.
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
    await fs.access(path.join(tmpDir, 'projects')).catch(() => {})
  })
})
