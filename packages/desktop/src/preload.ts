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
  // Show the shell's Servers page (the SPA's Servers button and server badge).
  showServers: () => ipcRenderer.send('window:show-servers'),
  // Follow the forwards the app bound at a fallback local port: called with
  // the current table, then on every change. Returns an unsubscribe.
  onForwardRemaps: (cb: (remaps: unknown) => void) => {
    const listener = (_e: unknown, remaps: unknown): void => cb(remaps)
    ipcRenderer.on('forward:remaps', listener)
    void ipcRenderer.invoke('forward:remaps').then(cb)
    return () => { ipcRenderer.removeListener('forward:remaps', listener) }
  },
})

// The Servers page's bridge (servers-page.ts). The main process answers it
// for that page alone and re-validates every payload (server-switch.ts).
contextBridge.exposeInMainWorld('yaacServer', {
  switchTo: (selection: unknown) => ipcRenderer.invoke('server:switch', selection),
  addRemote: (url: string) => ipcRenderer.invoke('server:add-remote', url),
  remove: (selection: unknown) => ipcRenderer.invoke('server:remove', selection),
  // Deselect the selected server (`yaac remote disconnect`).
  disconnect: () => ipcRenderer.invoke('server:disconnect'),
  // The saved servers that do not answer or refuse this device, and why.
  serverHealth: () => ipcRenderer.invoke('server:health'),
  // "Back" to the server the page was opened over, by re-running the boot
  // flow against the current `server.json`.
  back: () => ipcRenderer.invoke('server:back'),
  // Start or stop one of this machine's servers (`yaac server start`, or
  // `yaac cluster start` for scope 'cluster'); a start lands on it.
  startLocal: (scope: unknown) => ipcRenderer.invoke('server:start-local', scope),
  stopLocal: (scope: unknown) => ipcRenderer.invoke('server:stop-local', scope),
  // This Mac's installs and the setup under way (local-setup.ts).
  localState: () => ipcRenderer.invoke('server:local'),
  // Run one of the main process's fixed setups, named by its scope alone.
  setupLocal: (scope: unknown) => ipcRenderer.invoke('server:setup', scope),
  cancelSetup: () => ipcRenderer.invoke('server:setup-cancel'),
})
