import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#db/client'
import { preferences, shortcutOverrides } from '#db/schema'
import { clearShortcutOverrides, getGitIdentity, getShortcutOverrides, isSerializedChord, setGitIdentity, setShortcutOverride } from '#db'
// Shape of a stored chord, for building fixtures. Not under test here.
import type { SerializedChord } from '#db/preferences'

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
    await setGitIdentity({ name: 'Ada', email: 'ada@example.com' })
    await setShortcutOverride('new-session', chord('KeyG'))
    await setShortcutOverride('kill-terminal', chord('KeyX'))
    await setShortcutOverride('new-session', chord('KeyH'))
    expect(await getShortcutOverrides()).toEqual({
      'new-session': chord('KeyH'),
      'kill-terminal': chord('KeyX'),
    })
    expect(await getGitIdentity()).toEqual({ name: 'Ada', email: 'ada@example.com' })
  })
})

describe('clearShortcutOverrides', () => {
  it('drops the shortcuts but keeps other prefs', async () => {
    await setGitIdentity({ name: 'Ada', email: 'ada@example.com' })
    await setShortcutOverride('new-session', chord('KeyG'))
    await clearShortcutOverrides()
    expect(await getShortcutOverrides()).toEqual({})
    expect(await getGitIdentity()).toEqual({ name: 'Ada', email: 'ada@example.com' })
  })

  it('is a no-op when none are set', async () => {
    await clearShortcutOverrides()
    expect(await getShortcutOverrides()).toEqual({})
  })
})

describe('getGitIdentity', () => {
  it('is null until both halves are set', async () => {
    // Committing as a name with no email is not a lesser identity — git
    // refuses it — so a half-written pair must read as none at all.
    expect(await getGitIdentity()).toBeNull()

    const db = await getDb()
    await db.insert(preferences).values({ key: 'git_user_name', value: 'Ada' })
    expect(await getGitIdentity()).toBeNull()
  })

  it('trims, and treats whitespace as unset', async () => {
    const db = await getDb()
    await db.insert(preferences).values([
      { key: 'git_user_name', value: '  Ada Lovelace  ' },
      { key: 'git_user_email', value: '  ada@example.com  ' },
    ])
    expect(await getGitIdentity()).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com' })

    await db.update(preferences).set({ value: '   ' })
    expect(await getGitIdentity()).toBeNull()
  })
})

describe('setGitIdentity', () => {
  it('round-trips, and replaces rather than accumulating', async () => {
    await setGitIdentity({ name: 'Ada', email: 'ada@example.com' })
    expect(await getGitIdentity()).toEqual({ name: 'Ada', email: 'ada@example.com' })

    await setGitIdentity({ name: 'Grace', email: 'grace@example.com' })
    expect(await getGitIdentity()).toEqual({ name: 'Grace', email: 'grace@example.com' })
  })
})
