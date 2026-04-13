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

    // Wrap stdout.write so every newline also erases to end-of-line first.
    // Without this, shorter lines leave stale characters from the previous render.
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = function (this: NodeJS.WriteStream, str: string | Uint8Array, ...rest: never[]) {
      if (typeof str === 'string') {
        str = str.replaceAll('\n', '\x1B[K\n')
      }
      return origWrite(str, ...rest)
    } as typeof origWrite

    try {
      const now = new Date().toLocaleTimeString()
      console.log(`yaac session monitor  (every ${intervalSec}s, ${now})  Press Ctrl+C to exit\n`)

      await sessionList(projectSlug)
    } finally {
      process.stdout.write = origWrite
    }

    // Clear from cursor to end of screen (remove stale lines from previous render)
    process.stdout.write('\x1B[J')

    await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000))
  }
}
