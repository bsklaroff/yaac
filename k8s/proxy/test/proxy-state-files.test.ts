import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readJsonOrNull, scopeLegacySecretRefs, writeJsonAtomic } from 'yaac-proxy-sidecar/state-files'

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

describe('scopeLegacySecretRefs', () => {
  const rule = (secretRef: string | undefined) => ({
    hostPattern: 'api.example.com',
    pathPattern: '/*',
    injections: [{ action: 'set_header' as const, name: 'authorization', secretRef }],
  })

  it('scopes a bare ref to the registration’s own project', () => {
    // A registration written before refs were scoped names one the server
    // will never push again; its injections would stop resolving silently
    // after this pod replaced the last one.
    expect(scopeLegacySecretRefs([rule('MY_KEY')], 'demo')[0].injections[0].secretRef)
      .toBe('demo/MY_KEY')
  })

  it('leaves an already-scoped ref alone', () => {
    expect(scopeLegacySecretRefs([rule('other/MY_KEY')], 'demo')[0].injections[0].secretRef)
      .toBe('other/MY_KEY')
  })

  it('leaves an injection with no ref, and a registration with no project, alone', () => {
    expect(scopeLegacySecretRefs([rule(undefined)], 'demo')[0].injections[0].secretRef)
      .toBeUndefined()
    const rules = [rule('MY_KEY')]
    expect(scopeLegacySecretRefs(rules, undefined)).toBe(rules)
  })
})
