import { contextBridge, ipcRenderer } from 'electron'

/**
 * The native traffic lights are hidden (main.ts) in favour of custom
 * monochrome controls drawn in the web UI (WindowControls.tsx). Those buttons
 * drive the window over these channels. contextIsolation is on, so the renderer
 * only ever sees this minimal, explicit surface — never ipcRenderer directly.
 */
contextBridge.exposeInMainWorld('yaacWindow', {
  minimize: () => ipcRenderer.send('window:minimize'),
  // altKey selects the macOS Option-click zoom (maximize) instead of full screen.
  toggleMaximize: (altKey?: boolean) => ipcRenderer.send('window:toggle-maximize', altKey === true),
  close: () => ipcRenderer.send('window:close'),
  // Open a URL in the system browser (the preview's "open external" action).
  openExternal: (url: string) => ipcRenderer.send('window:open-external', url),
})

// The server picker (Settings → Server, rendered only when this bridge
// exists). Selections and results are plain JSON — origins only, never
// tokens; the main process re-validates every payload (#server-switch).
contextBridge.exposeInMainWorld('yaacServer', {
  targets: () => ipcRenderer.invoke('server:targets'),
  switchTo: (selection: unknown) => ipcRenderer.invoke('server:switch', selection),
  addRemote: (url: string, token: string) => ipcRenderer.invoke('server:add-remote', url, token),
})
