// Verifies the desktop shell's green "zoom" window control end to end:
// renderer button click → preload bridge (altKey arg) → window:toggle-maximize
// IPC → main-process zoomAction dispatch → BrowserWindow state change.
// On Linux the plain-click path is the maximize toggle (the darwin path enters
// native full screen; that branch is unit-tested in
// packages/desktop/test/window-zoom.test.ts and needs a real Mac to observe).
//
// Run: node test-playwright-scripts/desktop-zoom-button.js
// Needs: built desktop bundle (pnpm --filter @yaac/desktop exec tsup), the
// electron binary downloaded (node node_modules/electron/install.js), and a
// running yaac server (the shell's boot flow lands on it).
import path from 'node:path'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
let playwright
try {
  playwright = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'))
} catch {
  playwright = require('playwright')
}

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/desktop')

async function windowState(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    return { maximized: w.isMaximized(), fullScreen: w.isFullScreen() }
  })
}

const app = await playwright._electron.launch({
  executablePath: path.join(desktopDir, 'node_modules/electron/dist/electron'),
  // Needs a real X display (GTK refuses ozone-headless): run under Xvfb with
  // a window manager so maximize state works, e.g.
  //   Xvfb :99 & DISPLAY=:99 openbox & DISPLAY=:99 node <this script>
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '.'],
  cwd: desktopDir,
})
try {
  const win = await app.firstWindow()
  await win.waitForSelector('[aria-label="Zoom window"]', { timeout: 60000 })

  const results = []
  const before = await windowState(app)

  await win.click('[aria-label="Zoom window"]')
  await new Promise((r) => setTimeout(r, 1000))
  const afterClick = await windowState(app)
  results.push(['plain click toggles maximize on linux', before.maximized !== afterClick.maximized])

  await win.click('[aria-label="Zoom window"]', { modifiers: ['Alt'] })
  await new Promise((r) => setTimeout(r, 1000))
  const afterAltClick = await windowState(app)
  results.push(['alt-click toggles back', afterAltClick.maximized === before.maximized])

  for (const [name, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  console.log('states:', JSON.stringify({ before, afterClick, afterAltClick }))
  process.exitCode = results.every(([, ok]) => ok) ? 0 : 1
} finally {
  await app.close()
}
