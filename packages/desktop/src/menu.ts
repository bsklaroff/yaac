import type { MenuItemConstructorOptions } from 'electron'

/**
 * The application menu, built from standard roles. On macOS the first menu
 * is the app menu labeled "Yaac"; elsewhere it is a File menu, since the
 * app menu role exists only on macOS and closing the window only hides it,
 * so Quit needs a home. The Edit menu makes Cmd/Ctrl-C, -V and Select All
 * work in the xterm terminals. main.ts builds it.
 *
 * Edit > Find runs `onFind` on Cmd/Ctrl-F only when the focused page leaves
 * the key unhandled: Electron offers a page every key first and hands one
 * it does not take to the menu, a `<webview>` guest's included. That is how
 * Chrome shares the chord, so a previewed app with its own find keeps it,
 * and the preview's find opens for any other page.
 */
export function appMenuTemplate(onFind: () => void, platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  return [
    platform === 'darwin' ? { role: 'appMenu' } : { label: 'File', submenu: [{ role: 'quit' }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: onFind },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
}
