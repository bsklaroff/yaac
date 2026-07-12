/**
 * Entry: wire Electron to the boot flow. Untested glue — the logic lives in
 * the sibling modules (#flow, #mint, #server-process, #messages).
 *
 * Known v1 limitations (accepted, revisit if they bite): unlike `yaac open`,
 * the shell does not spawn the auth-daemon (`ensureAuthDaemonSpawned` is
 * in-process CLI code); the SPA's sign-in cards say what to run instead.
 */
import { app, BrowserWindow, dialog, shell } from 'electron'
import { resolveServerTarget } from '@yaac/shared/server-client'
import { runFlow } from '#flow'
import { mintWebToken } from '#mint'
import { errorBoxText, splashUrl } from '#messages'
import { runYaacServerStart } from '#server-process'

app.setName('yaac')

async function boot(): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'yaac',
    // The renderer is pure web content from the server origin — no preload,
    // no Node, fully sandboxed.
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  // The SPA's external links (forwarded ports, upstream docs) are
  // target="_blank": route them to the system browser, never a child window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const result = await runFlow({
    // The shell ships no server code, so it has no build id to match
    // against the lock — it only needs the local server to be live.
    resolveTarget: () => resolveServerTarget({ requireBuildMatch: false }),
    startLocalServer: runYaacServerStart,
    mintToken: mintWebToken,
    onStatus: (text) => {
      void win.loadURL(splashUrl(text)).catch(() => { /* superseded by the next load */ })
    },
  })
  if (!result.ok) {
    dialog.showErrorBox(result.error.title, errorBoxText(result.error))
    app.quit()
    return
  }
  try {
    await win.loadURL(result.url)
  } catch (err) {
    dialog.showErrorBox('Could not open yaac', err instanceof Error ? err.message : String(err))
    app.quit()
  }
}

void app.whenReady().then(boot)

// v1: the window is the app — no tray. Quitting on close matches the shell's
// "just a client" role: the server keeps running (it was never ours to stop),
// exactly like closing a webapp tab.
app.on('window-all-closed', () => app.quit())
