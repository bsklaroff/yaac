import { workspaceList } from '#commands/workspace-list'

export interface WorkspaceMonitorOptions {
  interval?: string
}

export async function workspaceMonitor(project?: string, options: WorkspaceMonitorOptions = {}): Promise<void> {
  const intervalSec = Math.max(1, parseInt(options.interval ?? '5', 10))

  // Swallow keyboard input so it doesn't corrupt the display. Raw mode
  // disables the default Ctrl+C, so handle it here.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', (key: Buffer) => {
      if (key[0] === 0x03) process.exit(0)
    })
  }

  // Clear once, then redraw in place each tick to avoid flashing.
  process.stdout.write('\x1B[2J')

  while (true) {
    process.stdout.write('\x1B[H')

    // Erase to end of line before each newline so shorter lines don't leave
    // stale characters from the previous render.
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = function (this: NodeJS.WriteStream, str: string | Uint8Array, ...rest: never[]) {
      if (typeof str === 'string') {
        str = str.replaceAll('\n', '\x1B[K\n')
      }
      return origWrite(str, ...rest)
    }

    try {
      const now = new Date().toLocaleTimeString()
      console.log(`yaac workspace monitor  (every ${intervalSec}s, ${now})  Press Ctrl+C to exit\n`)
      await workspaceList(project)
    } finally {
      process.stdout.write = origWrite
    }

    // Clear any leftover lines below.
    process.stdout.write('\x1B[J')

    await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000))
  }
}
