import { describe, it, expect, vi } from 'vitest'
import { Terminal, type ILink, type ILinkProvider } from '@xterm/xterm'
import { fileLinksIn, installTerminalLinks } from '#lib/terminal-links'

const PATHS = new Set(['packages/server/src/main.ts', 'README.md', 'docs/a b.md'])

describe('fileLinksIn', () => {
  it('finds paths of checkout files, however the line prints them', () => {
    const line = [
      'Edited packages/server/src/main.ts:12:3,', // line and column, punctuation
      '(./README.md)', // ./ and brackets
      '/workspace/packages/server/src/main.ts.', // absolute in a pod
      '/home/me/.yaac/sessions/x/packages/server/src/main.ts:7', // absolute on a host
      'src/main.ts', // not a checkout-relative path
      'notes.txt', // not in the checkout
      'v1.2', 'a/b', // path-shaped, not files
    ].join(' ')
    const links = fileLinksIn(line, PATHS)
    expect(links.map((l) => [line.slice(l.start, l.end), l.path])).toEqual([
      ['packages/server/src/main.ts', 'packages/server/src/main.ts'],
      ['./README.md', 'README.md'],
      ['/workspace/packages/server/src/main.ts', 'packages/server/src/main.ts'],
      ['/home/me/.yaac/sessions/x/packages/server/src/main.ts', 'packages/server/src/main.ts'],
    ])
  })
})

describe('installTerminalLinks', () => {
  it('opens a file on Cmd/Ctrl-click only, and leaves URLs to the web-links add-on', async () => {
    const term = new Terminal({ cols: 80, rows: 5, allowProposedApi: true })
    const providers: ILinkProvider[] = []
    const register = term.registerLinkProvider.bind(term)
    vi.spyOn(term, 'registerLinkProvider').mockImplementation((p) => {
      providers.push(p)
      return register(p)
    })
    const listPaths = vi.fn(() => Promise.resolve([...PATHS]))
    const openFile = vi.fn()
    const dispose = installTerminalLinks(term, { isMac: false, listPaths, openFile })
    // The web-links add-on and the path provider.
    expect(providers).toHaveLength(2)

    // Wide characters (two cells each) before a path on row 3.
    await new Promise<void>((r) => term.write('see README.md and https://example.com/x\r\nno paths here\r\n日本 README.md', r))
    const linksOn = (y: number): Promise<ILink[] | undefined> =>
      new Promise((r) => providers[1].provideLinks(y, r))
    const [link] = (await linksOn(1)) ?? []
    expect(link.range).toEqual({ start: { x: 5, y: 1 }, end: { x: 13, y: 1 } })
    // Ranges are in cells: 日 and 本 take two each, so README.md starts in
    // cell 6 (1-based), not at string index 3.
    const [wide] = (await linksOn(3)) ?? []
    expect(wide.range).toEqual({ start: { x: 6, y: 3 }, end: { x: 14, y: 3 } })
    expect(wide.text).toBe('README.md')
    // A line with nothing path-shaped never fetches the listing.
    expect(await linksOn(2)).toBeUndefined()
    // The listing is fetched once and reused.
    await linksOn(1)
    expect(listPaths).toHaveBeenCalledTimes(1)

    const click = (mods: Partial<MouseEvent>): MouseEvent => ({ ctrlKey: false, metaKey: false, ...mods }) as MouseEvent
    link.activate(click({}), link.text)
    link.activate(click({ metaKey: true }), link.text)
    expect(openFile).not.toHaveBeenCalled()
    link.activate(click({ ctrlKey: true }), link.text)
    expect(openFile).toHaveBeenCalledWith('README.md')
    dispose()
  })
})
