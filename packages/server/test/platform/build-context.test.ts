import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { collectContextFiles, isLayered } from '#platform/build-context'

describe('isLayered', () => {
  it('accepts a Dockerfile that declares ARG BASE_IMAGE and FROM ${BASE_IMAGE}', () => {
    expect(isLayered('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo hi\n')).toBe(true)
  })

  it('rejects a standalone Dockerfile with a concrete FROM', () => {
    expect(isLayered('FROM ubuntu:24.04\nRUN echo hi\n')).toBe(false)
  })

  it('rejects a Dockerfile that declares the arg but pins a concrete base', () => {
    expect(isLayered('ARG BASE_IMAGE\nFROM ubuntu:24.04\n')).toBe(false)
  })
})

describe('collectContextFiles', () => {
  it('walks regular files, honoring the ignore set and skipping symlinks', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ctx-'))
    try {
      await fs.writeFile(path.join(tmpDir, 'a.txt'), 'a')
      await fs.mkdir(path.join(tmpDir, 'sub'))
      await fs.writeFile(path.join(tmpDir, 'sub', 'b.txt'), 'b')
      await fs.mkdir(path.join(tmpDir, 'ignored'))
      await fs.writeFile(path.join(tmpDir, 'ignored', 'c.txt'), 'c')
      await fs.symlink('a.txt', path.join(tmpDir, 'link.txt'))

      const files = await collectContextFiles(tmpDir, '', new Set(['ignored']))
      expect(files.sort()).toEqual(['a.txt', 'sub/b.txt'])
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})
