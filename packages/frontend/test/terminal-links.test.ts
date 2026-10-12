import { describe, it, expect, vi } from 'vitest'
import { Terminal, type ILink, type ILinkProvider } from '@xterm/xterm'
import { installTerminalLinks } from '#lib/terminal-links'

const PATHS = new Set(['packages/server/src/main.ts', 'README.md', 'docs/a b.md'])

describe('installTerminalLinks', () => {
  it('opens a file on Cmd/Ctrl-click only, and leaves URLs to the web-links add-on', async () => {
    const term = new Terminal({ cols: 80, rows: 5, allowProposedApi: true })
    const providers: ILinkProvider[] = []
    const register = term.registerLinkProvider.bind(term)
    vi.spyOn(term, 'registerLinkProvider').mockImplementation((p) => {
      providers.push(p)
      return register(p)
    })
    const listFiles = vi.fn(() => Promise.resolve({ root: '/workspace', paths: [...PATHS] }))
    const openFile = vi.fn()
    const dispose = installTerminalLinks(term, { isMac: false, listFiles, openFile })
    // The web-links add-on and the path provider.
    expect(providers).toHaveLength(2)

    // Wide characters (two cells each) before a path on row 3.
    await new Promise<void>((r) => term.write('see README.md:7 and https://example.com/x\r\nno paths here\r\n日本 README.md', r))
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
    expect(listFiles).toHaveBeenCalledTimes(1)

    const click = (mods: Partial<MouseEvent>): MouseEvent => ({ ctrlKey: false, metaKey: false, ...mods }) as MouseEvent
    link.activate(click({}), link.text)
    link.activate(click({ metaKey: true }), link.text)
    expect(openFile).not.toHaveBeenCalled()
    link.activate(click({ ctrlKey: true }), link.text)
    expect(openFile).toHaveBeenCalledWith('README.md', 7)
    dispose()
  })
})
