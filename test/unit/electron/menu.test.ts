import { describe, it, expect } from 'vitest'
import { appMenuTemplate } from '@/electron/menu'

describe('appMenuTemplate', () => {
  it('is the standard macOS role menu (app, edit, view, window)', () => {
    expect(appMenuTemplate().map((m) => m.role)).toEqual(['appMenu', 'editMenu', 'viewMenu', 'windowMenu'])
  })

  it('includes an edit menu so terminal copy/paste works', () => {
    expect(appMenuTemplate().some((m) => m.role === 'editMenu')).toBe(true)
  })
})
