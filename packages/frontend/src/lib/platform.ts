/** True when the SPA is running inside the Electron desktop shell (vs a browser). */
export function isElectron(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron')
}
