import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { swallowTerminalQueries } from '#lib/terminal-queries'

const QUERIES = [
  '\x1b[c', // DA1
  '\x1b[>c', // DA2
  '\x1b[5n', // DSR status
  '\x1b[6n', // DSR cursor position
  '\x1b[?6n', // DECXCPR
  '\x1b[?2004$p', // DECRQM, private
  '\x1b[4$p', // DECRQM, ANSI
  '\x1bP$qm\x1b\\', // DECRQSS
  '\x1b]10;?\x07', // foreground colour
  '\x1b]11;?\x07', // background colour
  '\x1b]4;1;?\x07', // palette entry
]

/** Write `data` and collect whatever the terminal sends back. */
async function replies(term: Terminal, data: string): Promise<string[]> {
  const out: string[] = []
  const sub = term.onData((d) => out.push(d))
  await new Promise<void>((resolve) => term.write(data, resolve))
  sub.dispose()
  return out
}

describe('swallowTerminalQueries', () => {
  it('stops the terminal answering queries, but not obeying the rest', async () => {
    // Without it, xterm answers at least the CSI and DCS queries.
    const stock = new Terminal()
    expect(await replies(stock, QUERIES.join(''))).not.toEqual([])

    const term = new Terminal()
    const dispose = swallowTerminalQueries(term)
    expect(await replies(term, QUERIES.join(''))).toEqual([])

    // Mode changes still apply, text still prints, and a colour set (not a
    // query) still reaches xterm's own handler.
    await replies(term, '\x1b[?2004h\x1b]10;#ff0000\x07hi')
    expect(term.modes.bracketedPasteMode).toBe(true)
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('hi')

    // Disposed, the terminal answers again.
    dispose()
    expect(await replies(term, '\x1b[c')).not.toEqual([])
  })
})
