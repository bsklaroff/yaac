import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { projectDir } from '@/shared/project-paths'
import {
  MAX_TITLE_LENGTH,
  sessionTitlesPath,
  normalizeTitle,
  getSessionTitles,
  setSessionTitle,
} from '@/lib/session/titles'

describe('session titles', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('sessionTitlesPath lives inside the project dir', () => {
    expect(sessionTitlesPath('proj')).toBe(path.join(projectDir('proj'), 'session-titles.json'))
  })

  it('normalizeTitle collapses whitespace and caps the length', () => {
    expect(normalizeTitle('  fix   the\tparser \n')).toBe('fix the parser')
    expect(normalizeTitle('')).toBe('')
    expect(normalizeTitle('x'.repeat(500))).toHaveLength(MAX_TITLE_LENGTH)
  })

  it('set + get round-trips titles per project', async () => {
    await setSessionTitle('proj', 'sid-1', 'fix the parser')
    await setSessionTitle('proj', 'sid-2', 'docs pass')
    await setSessionTitle('other', 'sid-1', 'unrelated')
    expect(await getSessionTitles('proj')).toEqual({ 'sid-1': 'fix the parser', 'sid-2': 'docs pass' })
    expect(await getSessionTitles('other')).toEqual({ 'sid-1': 'unrelated' })
  })

  it('a blank title clears the entry', async () => {
    await setSessionTitle('proj', 'sid-1', 'temp name')
    await setSessionTitle('proj', 'sid-1', '   ')
    expect(await getSessionTitles('proj')).toEqual({})
  })

  it('returns {} for a missing or corrupt file', async () => {
    expect(await getSessionTitles('nope')).toEqual({})
    await fs.mkdir(projectDir('bad'), { recursive: true })
    await fs.writeFile(sessionTitlesPath('bad'), 'not json')
    expect(await getSessionTitles('bad')).toEqual({})
    await fs.writeFile(sessionTitlesPath('bad'), JSON.stringify({ a: 1, b: 'ok', c: '' }))
    expect(await getSessionTitles('bad')).toEqual({ b: 'ok' })
  })
})
