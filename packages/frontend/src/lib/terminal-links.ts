import { WebLinksAddon } from '@xterm/addon-web-links'
import type { IBufferLine, ILink, Terminal } from '@xterm/xterm'
import { fileLinksIn, type CheckoutFiles } from './files'

/**
 * Clickable links in a workspace terminal: URLs, opened in a new tab (the
 * desktop app hands them to the system browser), and paths of files in the
 * workspace's checkout, opened in the webapp's file editor.
 *
 * Both take Cmd-click on macOS and Ctrl-click elsewhere, as in VS Code and
 * as claude's fullscreen TUI documents for xterm.js terminals. A plain click
 * belongs to the app when it tracks the mouse (every agent TUI does), and to
 * text selection otherwise; `patchClickForwarding` keeps modified clicks
 * from reaching the app.
 */

/** How long a checkout's file listing is reused for path lookups. */
const LISTING_TTL_MS = 15_000

/**
 * A row's text with the cell each string index sits in. A wide character
 * (CJK, emoji) is one character over two cells, so string indexes and cell
 * columns drift apart after one.
 */
function rowText(line: IBufferLine): { text: string; cellAt: number[] } {
  let text = ''
  const cellAt: number[] = []
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)
    // The second cell of a wide character holds nothing.
    if (!cell || cell.getWidth() === 0) continue
    const chars = cell.getChars() || ' '
    for (let i = 0; i < chars.length; i++) cellAt.push(x)
    text += chars
  }
  return { text, cellAt }
}

/** The click that opens a link: Cmd on macOS, Ctrl elsewhere. */
function openGesture(event: MouseEvent, isMac: boolean): boolean {
  return isMac ? event.metaKey : event.ctrlKey
}

/**
 * Install both kinds of link. `listFiles` fetches the checkout's file
 * listing, at most once per `LISTING_TTL_MS`: first when the pointer enters
 * the terminal, so a link is ready by the time it is hovered. xterm shows a
 * row's links only once every provider has answered, so a stale listing
 * answers at once while a fresh one loads, and URLs never wait on it.
 * Returns a disposer. Call after `term.open()`.
 */
export function installTerminalLinks(
  term: Terminal,
  opts: {
    isMac: boolean
    listFiles: () => Promise<{ root: string; paths: string[] } | undefined>
    openFile: (path: string, line?: number) => void
  },
): () => void {
  const web = new WebLinksAddon((event, uri) => {
    if (openGesture(event, opts.isMac)) window.open(uri, '_blank', 'noopener')
  })
  term.loadAddon(web)

  let fetchedAt = -Infinity
  let pending: Promise<CheckoutFiles> | null = null
  let known: CheckoutFiles | null = null
  const none: CheckoutFiles = { root: '', paths: new Set() }
  const files = (): Promise<CheckoutFiles> => {
    if (!pending || Date.now() - fetchedAt > LISTING_TTL_MS) {
      fetchedAt = Date.now()
      pending = opts.listFiles().then(
        (f) => (known = f ? { root: f.root, paths: new Set(f.paths) } : none),
        () => known ?? none,
      )
    }
    return known ? Promise.resolve(known) : pending
  }
  const prefetch = (): void => { void files() }
  term.element?.addEventListener('mouseenter', prefetch)

  const provider = term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)
      const { text, cellAt } = line ? rowText(line) : { text: '', cellAt: [] }
      if (!/[/.]/.test(text)) {
        callback(undefined)
        return
      }
      void files().then((known) => {
        const links: ILink[] = fileLinksIn(text, known).map((l) => ({
          // 1-based cells, end inclusive; a path's characters are narrow.
          range: { start: { x: cellAt[l.start] + 1, y }, end: { x: cellAt[l.end - 1] + 1, y } },
          text: text.slice(l.start, l.end),
          decorations: { underline: true, pointerCursor: true },
          activate: (event) => {
            if (openGesture(event, opts.isMac)) opts.openFile(l.path, l.line)
          },
        }))
        callback(links.length > 0 ? links : undefined)
      })
    },
  })
  return () => {
    term.element?.removeEventListener('mouseenter', prefetch)
    provider.dispose()
    web.dispose()
  }
}
