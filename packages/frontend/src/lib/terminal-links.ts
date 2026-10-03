import { WebLinksAddon } from '@xterm/addon-web-links'
import type { IBufferLine, ILink, Terminal } from '@xterm/xterm'

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

/** A file path found in a line of terminal text, by string index. */
export interface FileLink {
  start: number
  end: number
  path: string
}

/** Runs of characters a path can be made of; quotes, brackets and the like
 *  end one. */
const TOKEN = /[^\s'"`()<>[\]{},;|]+/g

/**
 * The paths in `text` that name files in `paths` (the checkout's listing,
 * relative to its root). A token counts with an optional `./`, a trailing
 * `:line[:col]` and trailing punctuation removed. An absolute path counts by
 * its longest suffix in the listing, since the checkout's absolute location
 * differs by driver (`/workspace` in a pod, a host path otherwise).
 */
export function fileLinksIn(text: string, paths: ReadonlySet<string>): FileLink[] {
  const links: FileLink[] = []
  for (const m of text.matchAll(TOKEN)) {
    const token = m[0].replace(/[.:]+$/, '').replace(/(:\d+)+$/, '')
    if (!token.includes('/') && !token.includes('.')) continue
    const path = resolvePath(token, paths)
    if (path !== undefined) links.push({ start: m.index, end: m.index + token.length, path })
  }
  return links
}

function resolvePath(token: string, paths: ReadonlySet<string>): string | undefined {
  const relative = token.replace(/^\.\//, '')
  if (!token.startsWith('/')) return paths.has(relative) ? relative : undefined
  for (let i = token.indexOf('/', 1); i !== -1; i = token.indexOf('/', i + 1)) {
    const suffix = token.slice(i + 1)
    if (paths.has(suffix)) return suffix
  }
  return undefined
}

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
 * Install both kinds of link. `listPaths` fetches the checkout's file
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
    listPaths: () => Promise<string[]>
    openFile: (path: string) => void
  },
): () => void {
  const web = new WebLinksAddon((event, uri) => {
    if (openGesture(event, opts.isMac)) window.open(uri, '_blank', 'noopener')
  })
  term.loadAddon(web)

  let fetchedAt = -Infinity
  let pending: Promise<ReadonlySet<string>> | null = null
  let known: ReadonlySet<string> | null = null
  const paths = (): Promise<ReadonlySet<string>> => {
    if (!pending || Date.now() - fetchedAt > LISTING_TTL_MS) {
      fetchedAt = Date.now()
      pending = opts.listPaths().then((p) => (known = new Set(p)), () => known ?? new Set<string>())
    }
    return known ? Promise.resolve(known) : pending
  }
  const prefetch = (): void => { void paths() }
  term.element?.addEventListener('mouseenter', prefetch)

  const provider = term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)
      const { text, cellAt } = line ? rowText(line) : { text: '', cellAt: [] }
      if (!/[/.]/.test(text)) {
        callback(undefined)
        return
      }
      void paths().then((known) => {
        const links: ILink[] = fileLinksIn(text, known).map((l) => ({
          // 1-based cells, end inclusive; a path's characters are narrow.
          range: { start: { x: cellAt[l.start] + 1, y }, end: { x: cellAt[l.end - 1] + 1, y } },
          text: text.slice(l.start, l.end),
          decorations: { underline: true, pointerCursor: true },
          activate: (event) => {
            if (openGesture(event, opts.isMac)) opts.openFile(l.path)
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
