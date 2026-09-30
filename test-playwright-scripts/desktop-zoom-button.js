/*
 * Verifies the desktop shell's green "zoom" window control end to end: a
 * click goes through the preload bridge and the window:toggle-maximize IPC
 * to zoomAction, which changes the BrowserWindow state. On Linux a plain
 * click toggles maximize and so does an Alt-click; the macOS full-screen
 * path is unit-tested in packages/desktop/test/window-zoom.test.ts.
 *
 * Needs the desktop bundle (`pnpm --filter @yaac/desktop build`), the
 * Electron binary (`node packages/desktop/node_modules/electron/install.js`),
 * and a running server for the shell to land on (see lib.js; the shell
 * follows the same YAAC_DATA_DIR). GTK needs a real X display with a window
 * manager for maximize state to change, e.g.
 *   Xvfb :99 & DISPLAY=:99 openbox &
 *   DISPLAY=:99 node test-playwright-scripts/desktop-zoom-button.js
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, finish, requirePlaywright } from './lib.js'

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/desktop')

const windowState = (app) => app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  return { maximized: w.isMaximized(), fullScreen: w.isFullScreen() }
})
const settle = () => new Promise((r) => setTimeout(r, 1000))

const app = await requirePlaywright()._electron.launch({
  executablePath: path.join(desktopDir, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '.'],
  cwd: desktopDir,
})
try {
  const win = await app.firstWindow()
  const zoom = win.getByLabel('Zoom window')
  await zoom.waitFor({ timeout: 60_000 })
  const before = await windowState(app)

  await zoom.click()
  await settle()
  const afterClick = await windowState(app)
  check('a plain click toggles maximize', before.maximized !== afterClick.maximized, JSON.stringify(afterClick))

  await zoom.click({ modifiers: ['Alt'] })
  await settle()
  const afterAltClick = await windowState(app)
  check('an Alt-click toggles it back', afterAltClick.maximized === before.maximized, JSON.stringify(afterAltClick))
} finally {
  await app.close()
}
finish()
