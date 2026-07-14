import { contextBridge, ipcRenderer } from 'electron'

/**
 * The native traffic lights are hidden (main.ts) in favour of custom
 * monochrome controls drawn in the web UI (WindowControls.tsx). Those buttons
 * drive the window over these channels. contextIsolation is on, so the renderer
 * only ever sees this minimal, explicit surface — never ipcRenderer directly.
 */
contextBridge.exposeInMainWorld('yaacWindow', {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  // Open a URL in the system browser (the preview's "open external" action).
  openExternal: (url: string) => ipcRenderer.send('window:open-external', url),
})
