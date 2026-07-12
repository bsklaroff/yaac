import type { MenuItemConstructorOptions } from 'electron'

/**
 * macOS application menu. Standard role-based menus so the app presents as
 * "yaac" (the app menu's labels use app.name) rather than the default
 * "Electron", and — importantly — Cmd-C / Cmd-V / Select All work in the
 * embedded xterm terminals via the Edit menu's roles. Kept as a plain
 * template (no Electron calls) so it's unit-testable; main.ts builds it.
 */
export function appMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
}
