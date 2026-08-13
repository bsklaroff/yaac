import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readJsonOrNull, writeJsonAtomic } from 'yaac-proxy-sidecar/state-files'

let dir: string
const current = (): string => path.join(dir, 'worktrees.json')

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-state-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('writeJsonAtomic', () => {
  it('writes 0600 JSON and leaves no temp file behind', () => {
    writeJsonAtomic(current(), { a: 1 })
    expect(JSON.parse(fs.readFileSync(current(), 'utf8'))).toEqual({ a: 1 })
    expect(fs.statSync(current()).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(dir)).toEqual(['worktrees.json'])
  })

  it('replaces an existing file rather than appending to it', () => {
    writeJsonAtomic(current(), { a: 1 })
    writeJsonAtomic(current(), { b: 2 })
    expect(JSON.parse(fs.readFileSync(current(), 'utf8'))).toEqual({ b: 2 })
  })
})

describe('readJsonOrNull', () => {
  it('reads what writeJsonAtomic wrote', () => {
    writeJsonAtomic(current(), { sid: 'now' })
    expect(readJsonOrNull(current())).toEqual({ sid: 'now' })
  })

  // Missing does not error — the proxy just starts with zero registrations
  // and fails closed on every running worktree's egress until re-registered.
  it('returns null on first boot, when the file does not exist', () => {
    expect(readJsonOrNull(current())).toBeNull()
  })

  it('returns null for a corrupt file rather than throwing', () => {
    fs.writeFileSync(current(), '{not json')
    expect(readJsonOrNull(current())).toBeNull()
  })
})
