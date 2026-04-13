import { sessionList } from '@/commands/session-list'

export interface SessionMonitorOptions {
  interval?: string
}

export async function sessionMonitor(projectSlug?: string, options: SessionMonitorOptions = {}): Promise<void> {
  const intervalSec = Math.max(1, parseInt(options.interval ?? '5', 10))

  // Run once immediately, then poll
  while (true) {
    // Clear the screen and move cursor to top-left
    process.stdout.write('\x1B[2J\x1B[H')

    const now = new Date().toLocaleTimeString()
    console.log(`yaac monitor  (every ${intervalSec}s, ${now})  Press Ctrl+C to exit\n`)

    await sessionList(projectSlug)

    await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000))
  }
}
