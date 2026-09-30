import type { MenuItemConstructorOptions } from 'electron'

/**
 * macOS application menu built from standard roles, so the app menu is
 * labeled "yaac" and the Edit menu makes Cmd-C / Cmd-V / Select All work in
 * the xterm terminals. main.ts builds it.
 */
export function appMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
}
