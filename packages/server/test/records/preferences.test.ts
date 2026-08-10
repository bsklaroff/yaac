import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#records/client'
import { preferences, shortcutOverrides } from '#records/schema'
import { DEFAULT_TOOL_KEY, clearShortcutOverrides, getDefaultTool, getShortcutOverrides, isSerializedChord, isValidTool, setDefaultToolChecked, setShortcutOverride } from '#records'
// Shape of a stored chord, for building fixtures. Not under test here.
import type { SerializedChord } from '#records/preferences'
import { ServerError } from '@yaac/shared/errors'

const chord = (code: string, over: Partial<SerializedChord> = {}): SerializedChord => ({
  code, alt: true, ctrl: false, meta: false, shift: false, ...over,
})

let tmpDir: string

// One PGlite per file: cold-init is the expensive part, so the tests
// share a data dir and wipe the tables instead of recreating it.
beforeAll(async () => {
  tmpDir = await createTempDataDir()
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

beforeEach(async () => {
  const db = await getDb()
  await db.delete(shortcutOverrides)
  await db.delete(preferences)
})

describe('getDefaultTool', () => {
  it('returns undefined when no preference set', async () => {
    expect(await getDefaultTool()).toBeUndefined()
  })

  it('returns the stored tool', async () => {
    await setDefaultToolChecked('codex')
    expect(await getDefaultTool()).toBe('codex')
  })

  it('ignores a row written by a build that knew a tool this one does not', async () => {
    const db = await getDb()
    await db.insert(preferences).values({ key: DEFAULT_TOOL_KEY, value: 'gemini' })
    expect(await getDefaultTool()).toBeUndefined()
  })
})

describe('setDefaultToolChecked', () => {
  it('persists a valid tool, returns it, and overwrites the previous one', async () => {
    expect(await setDefaultToolChecked('claude')).toBe('claude')
    expect(await setDefaultToolChecked('codex')).toBe('codex')
    expect(await getDefaultTool()).toBe('codex')
  })

  it('throws VALIDATION for an unknown tool, leaving the stored value alone', async () => {
    await setDefaultToolChecked('claude')
    await expect(setDefaultToolChecked('gemini')).rejects.toBeInstanceOf(ServerError)
    await expect(setDefaultToolChecked('gemini')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await getDefaultTool()).toBe('claude')
  })
})

describe('isValidTool', () => {
  it('accepts every shipped tool name', () => {
    for (const tool of ['claude', 'codex', 'opencode', 'pi']) {
      expect(isValidTool(tool)).toBe(true)
    }
  })

  it('rejects unknown names and is case-sensitive', () => {
    expect(isValidTool('invalid')).toBe(false)
    expect(isValidTool('')).toBe(false)
    expect(isValidTool('Claude')).toBe(false)
  })
})

describe('isSerializedChord', () => {
  it('accepts a full chord', () => {
    expect(isSerializedChord(chord('KeyG'))).toBe(true)
  })

  it('rejects partial or non-object values', () => {
    expect(isSerializedChord({ code: 'KeyW' })).toBe(false) // missing modifiers
    expect(isSerializedChord({ ...chord('KeyG'), alt: 'yes' })).toBe(false)
    expect(isSerializedChord({ ...chord('KeyG'), code: 7 })).toBe(false)
    expect(isSerializedChord(null)).toBe(false)
    expect(isSerializedChord('KeyG')).toBe(false)
  })
})

describe('getShortcutOverrides', () => {
  it('returns {} when none are set', async () => {
    expect(await getShortcutOverrides()).toEqual({})
  })

  it('returns every stored rebind keyed by command id', async () => {
    await setShortcutOverride('new-session', chord('KeyG'))
    await setShortcutOverride('kill-terminal', chord('KeyX', { ctrl: true, shift: true }))
    expect(await getShortcutOverrides()).toEqual({
      'new-session': chord('KeyG'),
      'kill-terminal': chord('KeyX', { ctrl: true, shift: true }),
    })
  })
})

describe('setShortcutOverride', () => {
  it('accumulates overrides, overwrites one in place, and leaves other prefs alone', async () => {
    await setDefaultToolChecked('codex')
    await setShortcutOverride('new-session', chord('KeyG'))
    await setShortcutOverride('kill-terminal', chord('KeyX'))
    await setShortcutOverride('new-session', chord('KeyH'))
    expect(await getShortcutOverrides()).toEqual({
      'new-session': chord('KeyH'),
      'kill-terminal': chord('KeyX'),
    })
    expect(await getDefaultTool()).toBe('codex')
  })
})

describe('clearShortcutOverrides', () => {
  it('drops the shortcuts but keeps other prefs', async () => {
    await setDefaultToolChecked('claude')
    await setShortcutOverride('new-session', chord('KeyG'))
    await clearShortcutOverrides()
    expect(await getShortcutOverrides()).toEqual({})
    expect(await getDefaultTool()).toBe('claude')
  })

  it('is a no-op when none are set', async () => {
    await clearShortcutOverrides()
    expect(await getShortcutOverrides()).toEqual({})
  })
})
