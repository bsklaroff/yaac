import { describe, it, expect, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { appMenuTemplate } from '#menu'

describe('appMenuTemplate', () => {
  it('is the app, edit, view and window menus, with copy/paste and a Find on Cmd/Ctrl-F', () => {
    const onFind = vi.fn()
    const menu = appMenuTemplate(onFind)
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
})
