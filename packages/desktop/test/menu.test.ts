import { describe, it, expect, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { appMenuTemplate } from '#menu'

describe('appMenuTemplate', () => {
  it('is the app, edit, view and window menus, with copy/paste and a Find on Cmd/Ctrl-F', () => {
    const onFind = vi.fn()
    const menu = appMenuTemplate(onFind, 'darwin')
    expect(menu.map((m) => m.role ?? m.label)).toEqual(['appMenu', 'Edit', 'viewMenu', 'windowMenu'])
    const edit = menu[1].submenu as MenuItemConstructorOptions[]
    expect(edit.map((i) => i.role).filter(Boolean)).toEqual(
      expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']),
    )
    const find = edit.find((i) => i.label === 'Find')
    expect(find?.accelerator).toBe('CmdOrCtrl+F')
    ;(find?.click as () => void)()
    expect(onFind).toHaveBeenCalledTimes(1)
  })
  it('puts Quit in a File menu in place of the macOS app menu elsewhere', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const menu = appMenuTemplate(vi.fn(), platform)
      expect(menu.map((m) => m.role ?? m.label)).toEqual(['File', 'Edit', 'viewMenu', 'windowMenu'])
      expect((menu[0].submenu as MenuItemConstructorOptions[]).map((i) => i.role)).toEqual(['quit'])
    }
  })
})
