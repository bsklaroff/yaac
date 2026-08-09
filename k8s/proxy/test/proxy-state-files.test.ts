import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readJsonEither, writeJsonAtomic } from 'yaac-proxy-sidecar/state-files'

let dir: string
const current = (): string => path.join(dir, 'worktrees.json')
const legacy = (): string => path.join(dir, 'sessions.json')

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

describe('readJsonEither', () => {
  it('reads the current name', () => {
    writeJsonAtomic(current(), { sid: 'now' })
    expect(readJsonEither(current(), legacy())).toEqual({ sid: 'now' })
  })

  // The upgrade case, and the reason this module exists: a /data written by a
  // proxy that predates the rename has only sessions.json. Missing it does not
  // error — the proxy just starts with zero registrations and fails closed on
  // every running worktree's egress.
  it('falls back to the legacy name when only it exists', () => {
    writeJsonAtomic(legacy(), { sid: 'legacy' })
    expect(readJsonEither(current(), legacy())).toEqual({ sid: 'legacy' })
  })

  it('prefers the current name when both exist', () => {
    writeJsonAtomic(legacy(), { sid: 'legacy' })
    writeJsonAtomic(current(), { sid: 'now' })
    expect(readJsonEither(current(), legacy())).toEqual({ sid: 'now' })
  })

  it('returns null on first boot, when neither exists', () => {
    expect(readJsonEither(current(), legacy())).toBeNull()
  })

  // A present-but-corrupt current file is authoritative: falling back would
  // resurrect registrations the proxy has already moved past.
  it('returns null for a corrupt current file instead of reading the legacy one', () => {
    writeJsonAtomic(legacy(), { sid: 'legacy' })
    fs.writeFileSync(current(), '{not json')
    expect(readJsonEither(current(), legacy())).toBeNull()
  })
})
