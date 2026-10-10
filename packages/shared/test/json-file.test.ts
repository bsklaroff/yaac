import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readJsonFile, writeJsonFile } from '#json-file'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-json-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('readJsonFile', () => {
  it('tells an absent file from one that is not a JSON object', async () => {
    const file = path.join(dir, 'x.json')
    expect(await readJsonFile(file)).toBe('absent')
    await fs.writeFile(file, '')
    expect(await readJsonFile(file)).toBeNull()
    await fs.writeFile(file, '"text"')
    expect(await readJsonFile(file)).toBeNull()
    await fs.writeFile(file, '{"a":1}')
    expect(await readJsonFile(file)).toEqual({ a: 1 })
  })
})

describe('writeJsonFile', () => {
  it('writes at 0600 into a dir it creates, and leaves no temp file behind', async () => {
    const file = path.join(dir, 'nested', 'x.json')
    expect(await writeJsonFile(file, { a: 1 })).toBe(true)
    expect(await readJsonFile(file)).toEqual({ a: 1 })
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect(await fs.readdir(path.dirname(file))).toEqual(['x.json'])
  })

  it('with exclusive, never replaces a file another writer put there first', async () => {
    const file = path.join(dir, 'x.json')
    expect(await writeJsonFile(file, { first: true }, { exclusive: true })).toBe(true)
    expect(await writeJsonFile(file, { second: true }, { exclusive: true })).toBe(false)
    expect(await readJsonFile(file)).toEqual({ first: true })
    expect(await fs.readdir(dir)).toEqual(['x.json'])
    // Without it, the write replaces the file.
    await writeJsonFile(file, { third: true })
    expect(await readJsonFile(file)).toEqual({ third: true })
  })
})
