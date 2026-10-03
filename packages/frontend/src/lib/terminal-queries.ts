import type { IDisposable, Terminal } from '@xterm/xterm'

/**
 * Keep a workspace terminal from answering the app's terminal queries.
 *
 * The pane's output reaches this xterm raw (docs/terminal-mirror.md), but
 * the app's terminal is tmux, which already answers every query it
 * supports. An answer from xterm as well would reach the app as typed input.
 * So each query xterm would answer is claimed here and dropped: device
 * attributes (DA1, DA2), status and cursor reports (DSR), mode and setting
 * reports (DECRQM, DECRQSS), and colour queries (OSC 4, 10, 11, 12 with
 * `?`).
 *
 * Returns a disposer.
 */
export function swallowTerminalQueries(term: Terminal): () => void {
  const p = term.parser
  const handled = (): boolean => true
  const colourQuery = (data: string): boolean => data.split(';').includes('?')
  const subs: IDisposable[] = [
    p.registerCsiHandler({ final: 'c' }, handled),
    p.registerCsiHandler({ prefix: '>', final: 'c' }, handled),
    p.registerCsiHandler({ final: 'n' }, handled),
    p.registerCsiHandler({ prefix: '?', final: 'n' }, handled),
    p.registerCsiHandler({ intermediates: '$', final: 'p' }, handled),
    p.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, handled),
    p.registerDcsHandler({ intermediates: '$', final: 'q' }, handled),
    ...[4, 10, 11, 12].map((code) => p.registerOscHandler(code, colourQuery)),
  ]
  return (): void => {
    for (const s of subs) s.dispose()
  }
}
