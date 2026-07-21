import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#platform/db/client'
import { preferences, shortcutOverrides } from '#platform/db/schema'
import {
  getDefaultTool,
  setDefaultTool,
  setDefaultToolChecked,
  isValidTool,
  isSerializedChord,
  getShortcutOverrides,
  setShortcutOverride,
  clearShortcutOverrides,
  type SerializedChord,
} from '#features/projects/preferences'
import { ServerError } from '@yaac/shared/errors'

const chord = (code: string, over: Partial<SerializedChord> = {}): SerializedChord => ({
  code, alt: true, ctrl: false, meta: false, shift: false, ...over,
})

describe('preferences', () => {
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

  describe('getDefaultTool / setDefaultTool', () => {
    it('returns undefined when no preference set', async () => {
      expect(await getDefaultTool()).toBeUndefined()
    })

    it('round-trips the configured tool', async () => {
      await setDefaultTool('codex')
      expect(await getDefaultTool()).toBe('codex')
    })

    it('overwrites an existing default tool', async () => {
      await setDefaultTool('claude')
      await setDefaultTool('codex')
      expect(await getDefaultTool()).toBe('codex')
    })
  })

  describe('isValidTool', () => {
    it('accepts claude', () => {
      expect(isValidTool('claude')).toBe(true)
    })

    it('accepts codex', () => {
      expect(isValidTool('codex')).toBe(true)
    })

    it('rejects invalid values', () => {
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
      expect(isSerializedChord(null)).toBe(false)
      expect(isSerializedChord('KeyG')).toBe(false)
    })
  })

  describe('setDefaultToolChecked', () => {
    it('persists a valid tool and returns it', async () => {
      const saved = await setDefaultToolChecked('codex')
      expect(saved).toBe('codex')
      expect(await getDefaultTool()).toBe('codex')
    })

    it('throws VALIDATION for an unknown tool', async () => {
      await expect(setDefaultToolChecked('gemini')).rejects.toBeInstanceOf(ServerError)
      await expect(setDefaultToolChecked('gemini')).rejects.toMatchObject({
        code: 'VALIDATION',
      })
    })
  })

  describe('shortcut overrides', () => {
    it('getShortcutOverrides returns {} when none are set', async () => {
      expect(await getShortcutOverrides()).toEqual({})
    })

    it('setShortcutOverride persists a rebind and coexists with defaultTool', async () => {
      await setDefaultTool('codex')
      await setShortcutOverride('new-session', chord('KeyG'))
      expect(await getShortcutOverrides()).toEqual({ 'new-session': chord('KeyG') })
      // The unrelated preference is untouched.
      expect(await getDefaultTool()).toBe('codex')
    })

    it('accumulates overrides and overwrites one in place', async () => {
      await setShortcutOverride('new-session', chord('KeyG'))
      await setShortcutOverride('kill-terminal', chord('KeyX'))
      await setShortcutOverride('new-session', chord('KeyH'))
      expect(await getShortcutOverrides()).toEqual({
        'new-session': chord('KeyH'),
        'kill-terminal': chord('KeyX'),
      })
    })

    it('clearShortcutOverrides drops the shortcuts but keeps other prefs', async () => {
      await setDefaultTool('claude')
      await setShortcutOverride('new-session', chord('KeyG'))
      await clearShortcutOverrides()
      expect(await getShortcutOverrides()).toEqual({})
      expect(await getDefaultTool()).toBe('claude')
    })
  })
})
