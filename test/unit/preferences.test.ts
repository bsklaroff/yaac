import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@test/helpers/setup'
import {
  preferencesPath,
  loadPreferences,
  savePreferences,
  getDefaultTool,
  setDefaultTool,
  setDefaultToolChecked,
  isValidTool,
  getShortcutOverrides,
  setShortcutOverride,
  clearShortcutOverrides,
  type SerializedChord,
} from '@yaac/server/lib/project/preferences'
import { ServerError } from '@yaac/shared/errors'

const chord = (code: string, over: Partial<SerializedChord> = {}): SerializedChord => ({
  code, alt: true, ctrl: false, meta: false, shift: false, ...over,
})

describe('preferences', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('preferencesPath returns path inside data dir', () => {
    expect(preferencesPath()).toBe(path.join(getDataDir(), '.preferences.json'))
  })

  describe('loadPreferences', () => {
    it('returns empty object when file is missing', async () => {
      const result = await loadPreferences()
      expect(result).toEqual({})
    })

    it('returns preferences from valid file', async () => {
      await fs.writeFile(
        preferencesPath(),
        JSON.stringify({ defaultTool: 'codex' }),
      )
      const result = await loadPreferences()
      expect(result).toEqual({ defaultTool: 'codex' })
    })

    it('ignores invalid defaultTool values', async () => {
      await fs.writeFile(
        preferencesPath(),
        JSON.stringify({ defaultTool: 'invalid' }),
      )
      const result = await loadPreferences()
      expect(result).toEqual({})
    })

    it('returns empty object for invalid JSON', async () => {
      await fs.writeFile(preferencesPath(), 'not json')
      const result = await loadPreferences()
      expect(result).toEqual({})
    })

    it('returns empty object when file is an array', async () => {
      await fs.writeFile(preferencesPath(), '[]')
      const result = await loadPreferences()
      expect(result).toEqual({})
    })
  })

  describe('savePreferences', () => {
    it('writes preferences to file', async () => {
      await savePreferences({ defaultTool: 'claude' })
      const raw = await fs.readFile(preferencesPath(), 'utf8')
      expect(JSON.parse(raw)).toEqual({ defaultTool: 'claude' })
    })
  })

  describe('getDefaultTool', () => {
    it('returns undefined when no preference set', async () => {
      const tool = await getDefaultTool()
      expect(tool).toBeUndefined()
    })

    it('returns the configured tool', async () => {
      await savePreferences({ defaultTool: 'codex' })
      const tool = await getDefaultTool()
      expect(tool).toBe('codex')
    })
  })

  describe('setDefaultTool', () => {
    it('sets the default tool', async () => {
      await setDefaultTool('codex')
      const prefs = await loadPreferences()
      expect(prefs.defaultTool).toBe('codex')
    })

    it('overwrites existing default tool', async () => {
      await setDefaultTool('claude')
      await setDefaultTool('codex')
      const prefs = await loadPreferences()
      expect(prefs.defaultTool).toBe('codex')
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

  describe('setDefaultToolChecked', () => {
    it('persists a valid tool and returns it', async () => {
      const saved = await setDefaultToolChecked('codex')
      expect(saved).toBe('codex')
      const prefs = await loadPreferences()
      expect(prefs.defaultTool).toBe('codex')
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
      expect((await loadPreferences()).defaultTool).toBe('codex')
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
      expect((await loadPreferences()).defaultTool).toBe('claude')
    })

    it('loadPreferences drops malformed shortcut entries', async () => {
      await fs.writeFile(preferencesPath(), JSON.stringify({
        shortcuts: {
          'new-session': chord('KeyG'),
          'bad': { code: 'KeyW' }, // missing modifier flags
        },
      }))
      expect((await loadPreferences()).shortcuts).toEqual({ 'new-session': chord('KeyG') })
    })
  })
})
