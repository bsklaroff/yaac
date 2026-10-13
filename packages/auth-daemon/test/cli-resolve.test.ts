import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveToolCliPath } from '#cli-resolve'

describe('cli-resolve', () => {
  let tmpDir: string
  const realPath = process.env.PATH

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-resolve-'))
  })

  afterEach(async () => {
    process.env.PATH = realPath
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function writeExecutable(dir: string, name: string): Promise<string> {
    const p = path.join(dir, name)
    await fs.writeFile(p, '#!/bin/sh\n', { mode: 0o755 })
    return p
  }

  describe('resolveToolCliPath', () => {
    const realHome = process.env.HOME
    afterEach(() => { process.env.HOME = realHome })

    it('finds a tool CLI through $PATH, then in ~/.local/bin, else null', async () => {
      process.env.HOME = tmpDir
      const localBin = path.join(tmpDir, '.local', 'bin')
      const onPath = path.join(tmpDir, 'bin')
      await fs.mkdir(localBin, { recursive: true })
      await fs.mkdir(onPath)
      process.env.PATH = onPath
      expect(resolveToolCliPath('codex')).toBeNull()

      const installed = await writeExecutable(localBin, 'codex')
      expect(resolveToolCliPath('codex')).toBe(installed)
      const first = await writeExecutable(onPath, 'codex')
      expect(resolveToolCliPath('codex')).toBe(first)
    })
  })
})
