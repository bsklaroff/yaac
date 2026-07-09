import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateAddDirs } from '@/commands/add-dirs'

describe('validateAddDirs', () => {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  let tmpDir: string

  beforeEach(async () => {
    errorSpy.mockClear()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-add-dirs-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('accepts absolute, existing paths in both addDir and addDirRw', async () => {
    await expect(validateAddDirs({ addDir: [tmpDir], addDirRw: [tmpDir] })).resolves.toBe(true)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('accepts empty options', async () => {
    await expect(validateAddDirs({})).resolves.toBe(true)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('rejects a relative path with an absolute-path error', async () => {
    await expect(validateAddDirs({ addDir: ['relative/path'] })).resolves.toBe(false)
    expect(errorSpy).toHaveBeenCalledWith('--add-dir path must be absolute: "relative/path"')
  })

  it('rejects an absolute path that does not exist', async () => {
    const missing = path.join(tmpDir, 'definitely-missing')
    await expect(validateAddDirs({ addDirRw: [missing] })).resolves.toBe(false)
    expect(errorSpy).toHaveBeenCalledWith(`--add-dir path not found: "${missing}"`)
  })
})
