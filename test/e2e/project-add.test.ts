import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@test/helpers/setup'

// We test the validation logic directly since cloning real GitHub repos
// is not suitable for unit/e2e tests. The actual clone with token injection
// is tested via integration tests.

describe('yaac project add', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('rejects SSH-style git URLs with helpful message', async () => {
    const { projectAdd } = await import('@/commands/project-add')

    process.exitCode = undefined
    const errs: string[] = []
    const origErr = console.error
    console.error = (msg: string) => errs.push(msg)

    await projectAdd('git@github.com:org/repo.git')

    console.error = origErr
    expect(process.exitCode).toBe(1)
    expect(errs.join('\n')).toContain('HTTPS')
    process.exitCode = undefined
  })

  it('rejects non-HTTPS protocols', async () => {
    const { projectAdd } = await import('@/commands/project-add')

    process.exitCode = undefined
    const errs: string[] = []
    const origErr = console.error
    console.error = (msg: string) => errs.push(msg)

    await projectAdd('http://github.com/org/repo')

    console.error = origErr
    expect(process.exitCode).toBe(1)
    expect(errs.join('\n')).toContain('HTTPS')
    process.exitCode = undefined
  })

  it('rejects non-GitHub hosts', async () => {
    const { projectAdd } = await import('@/commands/project-add')

    process.exitCode = undefined
    const errs: string[] = []
    const origErr = console.error
    console.error = (msg: string) => errs.push(msg)

    await projectAdd('https://gitlab.com/org/repo')

    console.error = origErr
    expect(process.exitCode).toBe(1)
    expect(errs.join('\n')).toContain('GitHub')
    process.exitCode = undefined
  })

  it('rejects invalid URLs', async () => {
    const { projectAdd } = await import('@/commands/project-add')

    process.exitCode = undefined
    const errs: string[] = []
    const origErr = console.error
    console.error = (msg: string) => errs.push(msg)

    await projectAdd('not-a-url')

    console.error = origErr
    expect(process.exitCode).toBe(1)
    expect(errs.join('\n')).toContain('Invalid URL')
    process.exitCode = undefined
  })

  it('errors gracefully on duplicate slug', async () => {
    // Create the project directory to simulate an existing project
    const projectsDir = path.join(getDataDir(), 'projects', 'repo')
    await fs.mkdir(projectsDir, { recursive: true })

    const { projectAdd } = await import('@/commands/project-add')

    process.exitCode = undefined
    await projectAdd('https://github.com/org/repo')
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
  })
})
