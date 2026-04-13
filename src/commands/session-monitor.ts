import { sessionList } from '@/commands/session-list'

export interface SessionMonitorOptions {
  interval?: string
}

export async function sessionMonitor(projectSlug?: string, options: SessionMonitorOptions = {}): Promise<void> {
  const intervalSec = Math.max(1, parseInt(options.interval ?? '5', 10))

  // Clear the screen once on startup, then overwrite in place
  process.stdout.write('\x1B[2J')

  // Run once immediately, then poll
  while (true) {
    // Move cursor to top-left without clearing (avoids flash)
    process.stdout.write('\x1B[H')

    const now = new Date().toLocaleTimeString()
    console.log(`yaac session monitor  (every ${intervalSec}s, ${now})  Press Ctrl+C to exit\n`)

    await sessionList(projectSlug)

    // Clear from cursor to end of screen (remove stale lines from previous render)
    process.stdout.write('\x1B[J')

    await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000))
  }
}
