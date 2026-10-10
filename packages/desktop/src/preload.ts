import { contextBridge, ipcRenderer } from 'electron'

/**
 * The IPC surface the renderer gets. The native traffic lights are hidden, so
 * the web UI's WindowControls.tsx drives the window over these channels.
 * contextIsolation keeps ipcRenderer itself out of the renderer.
 */
contextBridge.exposeInMainWorld('yaacWindow', {
  minimize: () => ipcRenderer.send('window:minimize'),
  // altKey selects the macOS Option-click zoom (maximize) instead of full screen.
  toggleMaximize: (altKey?: boolean) => ipcRenderer.send('window:toggle-maximize', altKey === true),
  close: () => ipcRenderer.send('window:close'),
  // Open a URL in the system browser (the preview's "open external" action).
  openExternal: (url: string) => ipcRenderer.send('window:open-external', url),
})

// The server picker (Settings → Server, shown only when this bridge exists).
// The main process re-validates every payload (server-switch.ts).
contextBridge.exposeInMainWorld('yaacServer', {
  targets: () => ipcRenderer.invoke('server:targets'),
  switchTo: (selection: unknown) => ipcRenderer.invoke('server:switch', selection),
  addRemote: (url: string) => ipcRenderer.invoke('server:add-remote', url),
  remove: (selection: unknown) => ipcRenderer.invoke('server:remove', selection),
  // Re-run the boot flow against the current `server.json`, so the static
  // picker page can pick up a server started from a terminal.
  retry: () => ipcRenderer.invoke('server:retry'),
  // Start one of this machine's servers (`yaac server start`, or `yaac
  // cluster start` for scope 'cluster') and land on it.
  startLocal: (scope?: string) => ipcRenderer.invoke('server:start-local', scope),
})
