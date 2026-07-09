import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { boundsVisibleOn, readWindowState, saveWindowState } from '@/electron/window-state'

describe('boundsVisibleOn', () => {
  const display = { x: 0, y: 0, width: 1440, height: 900 }
  it('is true when the window overlaps a display', () => {
    expect(boundsVisibleOn({ x: 100, y: 100, width: 800, height: 600 }, [display])).toBe(true)
  })
  it('is false when the window is entirely off every display', () => {
    expect(boundsVisibleOn({ x: 5000, y: 5000, width: 800, height: 600 }, [display])).toBe(false)
  })
})

describe('read/saveWindowState', () => {
  it('round-trips bounds through a file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'yaac-winstate-'))
    const file = path.join(dir, 'window-state.json')
    try {
      expect(await readWindowState(file)).toBeNull()
      await saveWindowState(file, { x: 10, y: 20, width: 800, height: 600 })
      expect(await readWindowState(file)).toEqual({ x: 10, y: 20, width: 800, height: 600 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns null for a malformed (non-finite) saved state', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'yaac-winstate-'))
    const file = path.join(dir, 'window-state.json')
    try {
      await saveWindowState(file, { x: NaN, y: 0, width: 800, height: 600 })
      expect(await readWindowState(file)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
