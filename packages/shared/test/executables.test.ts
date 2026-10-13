import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { findExecutable } from '#executables'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'executables-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writeExecutable(dir: string, name: string): Promise<string> {
  const p = path.join(dir, name)
  await fs.writeFile(p, '#!/bin/sh\n', { mode: 0o755 })
  return p
}

describe('findExecutable', () => {
  it('finds an executable file, searching dirs in order', async () => {
    const first = path.join(tmpDir, 'a')
    const second = path.join(tmpDir, 'b')
    await fs.mkdir(first)
    await fs.mkdir(second)
    const winner = await writeExecutable(first, 'tool')
    await writeExecutable(second, 'tool')
    expect(findExecutable('tool', [second, first])).toBe(path.join(second, 'tool'))
    expect(findExecutable('tool', [first, second])).toBe(winner)
  })

  it('skips non-executable files, empty dir entries, and missing dirs', async () => {
    await fs.writeFile(path.join(tmpDir, 'tool'), '#!/bin/sh\n', { mode: 0o644 })
    expect(findExecutable('tool', ['', path.join(tmpDir, 'nope'), tmpDir])).toBeNull()
  })

  it('ignores a directory named like the command', async () => {
    await fs.mkdir(path.join(tmpDir, 'tool'))
    expect(findExecutable('tool', [tmpDir])).toBeNull()
  })
})
