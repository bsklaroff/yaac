import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Critical memory pressure, as Chrome reads it on each platform, for
 * discarding hidden previews (docs/preview-lifecycle.md). Electron reports
 * no pressure events, so this polls.
 */

/** How often pressure is checked, and so how often one preview may go. */
const POLL_MS = 5_000
/** Chrome's Windows threshold: available physical memory below 400 MiB. */
const CRITICAL_AVAILABLE_KB = 400 * 1024
/** `kern.memorystatus_vm_pressure_level` at critical (DISPATCH_MEMORYPRESSURE_CRITICAL). */
const MAC_CRITICAL_LEVEL = 4

const execFileAsync = promisify(execFile)

/**
 * Whether the machine is under critical memory pressure: macOS's own level,
 * the one Chrome follows there, and elsewhere the memory the OS reports as
 * available (`MemAvailable` on Linux) against Chrome's Windows threshold.
 */
export async function underCriticalPressure(): Promise<boolean> {
  if (process.platform === 'darwin') {
    const { stdout } = await execFileAsync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])
    return Number(stdout) === MAC_CRITICAL_LEVEL
  }
  const info = process.getSystemMemoryInfo()
  return (process.platform === 'linux' ? info.available : info.free) < CRITICAL_AVAILABLE_KB
}

/** The part of a page's WebContents a pressure watch uses. */
export interface PressurePage {
  isDestroyed(): boolean
  send(channel: string): void
  on(event: 'did-navigate' | 'render-process-gone' | 'destroyed', listener: () => void): unknown
  off(event: 'did-navigate' | 'render-process-gone' | 'destroyed', listener: () => void): unknown
}

const PAGE_ENDS = ['did-navigate', 'render-process-gone', 'destroyed'] as const

/**
 * Send `page` `preview:memory-pressure` on every poll that finds critical
 * pressure. The watch belongs to the document that asked for it: it ends
 * when the page navigates, its renderer dies or it is destroyed, as well as
 * when the returned stop is called, so a reload never leaves it polling.
 */
export function watchMemoryPressure(page: PressurePage): () => void {
  const timer = setInterval(() => {
    underCriticalPressure().then((critical) => {
      if (critical && !page.isDestroyed()) page.send('preview:memory-pressure')
    }, () => {})
  }, POLL_MS)
  const stop = (): void => {
    clearInterval(timer)
    for (const event of PAGE_ENDS) page.off(event, stop)
  }
  for (const event of PAGE_ENDS) page.on(event, stop)
  return stop
}
