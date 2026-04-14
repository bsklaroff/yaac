import { sessionList } from '@/commands/session-list'
import { ensurePrewarmSession, ensurePrewarmSessions } from '@/lib/prewarm'

export interface SessionMonitorOptions {
  interval?: string
  noPrewarm?: boolean
}

export async function sessionMonitor(projectSlug?: string, options: SessionMonitorOptions = {}): Promise<void> {
  const intervalSec = Math.max(1, parseInt(options.interval ?? '5', 10))

  // Swallow all keyboard input so typed characters don't corrupt the display.
  // Ctrl+C still exits because we handle it explicitly.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', (key: Buffer) => {
      // Ctrl+C
      if (key[0] === 0x03) process.exit(0)
    })
  }

  // Clear the screen once on startup, then overwrite in place
  process.stdout.write('\x1B[2J')

  let prewarmInProgress = false

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

    // Prewarm: run as non-blocking background task with in-progress guard.
    // When a specific project is given, prewarm just that project.
    // Otherwise, discover all projects with live sessions and prewarm each.
    if (!options.noPrewarm && !prewarmInProgress) {
      prewarmInProgress = true
      const prewarmTask = projectSlug
        ? ensurePrewarmSession(projectSlug)
        : ensurePrewarmSessions()
      prewarmTask
        .catch((err) => {
          console.error(`Prewarm: ${err instanceof Error ? err.message : err}`)
        })
        .finally(() => {
          prewarmInProgress = false
        })
    }

    await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000))
  }
}
