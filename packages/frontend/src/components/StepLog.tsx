import { useEffect, useRef, useState, type JSX } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { resolveEffectiveTheme } from '#lib/theme'
import { terminalTheme } from '#lib/terminalTheme'

/** How often a followed log is asked for what was added. */
const FOLLOW_MS = 1_000

/**
 * One terminal log of a workspace (docs/workspace-steps.md "Logs") in a
 * read-only terminal: the bytes its window printed, replayed with their
 * colors. While `follow` holds it asks again from where the last read
 * ended, so a step still running streams in; a log that rotated starts
 * over from its new file.
 */
export function StepLog({ workspaceId, life, file, follow }: {
  workspaceId: string
  /** The life's log dir (`lifeDirName`). */
  life: string
  file: string
  follow: boolean
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const readRef = useRef<(() => Promise<void>) | null>(null)
  const [empty, setEmpty] = useState(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const term = new XTerm({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      disableStdin: true,
      cursorBlink: false,
      scrollback: 50_000,
      theme: terminalTheme(resolveEffectiveTheme()),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    fit.fit()
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => fit.fit())
    })
    ro.observe(el)

    let offset = 0
    let done = false
    let reading: Promise<void> | null = null
    const url = (): string => `/api/workspace/${encodeURIComponent(workspaceId)}/logs/`
      + `${encodeURIComponent(life)}/${encodeURIComponent(file)}?offset=${offset}`
    const readOnce = async (): Promise<void> => {
      for (;;) {
        const res = await fetch(url(), { credentials: 'same-origin' })
        if (done) return
        if (res.status === 404) {
          setEmpty(offset === 0)
          return
        }
        if (!res.ok) return
        const size = Number(res.headers.get('x-log-size') ?? '0')
        if (size < offset) {
          offset = 0
          term.reset()
          continue
        }
        const bytes = new Uint8Array(await res.arrayBuffer())
        if (done) return
        setEmpty(offset === 0 && bytes.length === 0)
        if (bytes.length > 0) term.write(bytes)
        offset = Number(res.headers.get('x-log-next') ?? String(offset + bytes.length))
        if (offset >= size) return
      }
    }
    readRef.current = () => {
      reading ??= readOnce().catch(() => {}).finally(() => { reading = null })
      return reading
    }
    void readRef.current()
    return () => {
      done = true
      readRef.current = null
      cancelAnimationFrame(raf)
      ro.disconnect()
      term.dispose()
    }
  }, [workspaceId, life, file])

  // One last read when following stops, for what came in since the last.
  useEffect(() => {
    if (!follow) {
      void readRef.current?.()
      return
    }
    const timer = setInterval(() => void readRef.current?.(), FOLLOW_MS)
    return () => clearInterval(timer)
  }, [follow])

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {empty && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-text-faint">
          {follow ? 'No output yet' : 'It printed nothing'}
        </p>
      )}
    </div>
  )
}
