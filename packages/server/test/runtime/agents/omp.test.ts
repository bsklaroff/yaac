import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'
import { ompDir, setDataDir } from '@yaac/shared/project-paths'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { ensureOmpSettings, ompTranscriptAsAcp } from '#runtime/agents/omp'
import { openRoot } from '#lib/confined-fs'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-omp-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('ensureOmpSettings', () => {
  const home = () => openRoot(dir, 'no-links')
  const read = async (rel: string): Promise<unknown> => parse(await fs.readFile(path.join(dir, 'agent', rel), 'utf8'))

  it('writes the overlay its launches load, beside the user\'s own settings, and rewrites nothing unchanged', async () => {
    await fs.mkdir(path.join(dir, 'agent'))
    await fs.writeFile(path.join(dir, 'agent', 'config.yml'), 'theme: dark\n')

    await ensureOmpSettings(await home())

    // `off` is a string to omp (YAML 1.2), which a 1.1 parser would read as
    // false; the setting takes only `off`, `notify` or `auto`.
    expect(await read('yaac.yml')).toEqual({
      startup: { setupWizard: false, checkUpdate: false },
      update: { auto: false },
      marketplace: { autoUpdate: 'off' },
      dev: { autoqa: false },
    })
    expect((await fs.readdir(path.join(dir, 'agent'))).sort()).toEqual(['config.yml', 'yaac.yml'])
    expect(await fs.readFile(path.join(dir, 'agent', 'config.yml'), 'utf8')).toBe('theme: dark\n')

    const stat = () => fs.stat(path.join(dir, 'agent', 'yaac.yml')).then((s) => s.mtimeMs)
    const before = await stat()
    await new Promise((r) => setTimeout(r, 20))
    await ensureOmpSettings(await home())
    expect(await stat()).toBe(before)
  })
})

describe('ompTranscriptAsAcp', () => {
  const PROJECT = 'demo'
  const hash = (c: string): string => c.repeat(64)
  const message = (id: string, parentId: string | null, m: unknown): string =>
    JSON.stringify({ type: 'message', id, parentId, message: m })
  // A log as omp 18.18.6 writes one: its title slot, then pi's entries, with
  // each image's bytes in the agent dir's blob store.
  const log = [
    JSON.stringify({ type: 'title', v: 1, title: 'Look', pad: '   ' }),
    JSON.stringify({ type: 'session', version: 3, id: 'o-1', cwd: '/w' }),
    message('u', null, { role: 'user', content: [
      { type: 'text', text: 'what is this' },
      { type: 'image', mimeType: 'image/jpeg', data: `blob:sha256:${hash('a')}` },
    ] }),
    message('a', 'u', { role: 'assistant', content: [{ type: 'toolCall', id: 'r', name: 'read', arguments: { path: 'b.png' } }] }),
    message('t', 'a', { role: 'toolResult', toolCallId: 'r', toolName: 'read', content: [
      { type: 'image', mimeType: 'image/png', data: `blob:sha256:${hash('b')}` },
      { type: 'image', mimeType: 'image/png', data: `blob:sha256:${hash('c')}` },
    ] }),
  ].join('\n')

  beforeEach(async () => {
    setDataDir(dir)
    installFakeWorkspaceDriver()
    const blobs = path.join(ompDir(PROJECT), 'agent', 'blobs')
    await fs.mkdir(blobs, { recursive: true })
    await fs.writeFile(path.join(blobs, hash('a')), Buffer.from('jpeg-bytes'))
    await fs.writeFile(path.join(blobs, hash('b')), Buffer.from('png-bytes'))
    // `c` is gone (omp's gc, or a hand cleanup).
  })

  const images = (events: Awaited<ReturnType<typeof ompTranscriptAsAcp>>): unknown[] =>
    JSON.stringify(events).match(/\{"type":"image"[^}]*\}/g)?.map((s) => JSON.parse(s) as unknown) ?? []

  it('puts back each image omp stored apart, as pi\'s log holds them, and leaves a missing one out', async () => {
    expect(images(await ompTranscriptAsAcp(PROJECT, log, 1024))).toEqual([
      { type: 'image', mimeType: 'image/jpeg', data: Buffer.from('jpeg-bytes').toString('base64') },
      { type: 'image', mimeType: 'image/png', data: Buffer.from('png-bytes').toString('base64') },
      { type: 'image', mimeType: 'image/png', data: `blob:sha256:${hash('c')}` },
    ])
  })

  it('stops putting images back once they would pass the cap', async () => {
    const shown = images(await ompTranscriptAsAcp(PROJECT, log, 'jpeg-bytes'.length))
      .map((i) => (i as { data: string }).data.startsWith('blob:'))
    expect(shown).toEqual([false, true, true])
  })
})
