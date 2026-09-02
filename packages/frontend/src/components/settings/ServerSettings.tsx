import { useEffect, useState, type FormEvent, type JSX } from 'react'
import { CheckIcon } from '#lib/icons'
import { serverBridge } from '#lib/desktopServer'
import type { DesktopServerSelection, DesktopServerTargets } from '@yaac/shared/types'

/**
 * Desktop-only server picker (Settings → Server). Lists every server this
 * machine has configured — including the one on this machine, which `yaac
 * server start` registers like any other — and takes a new one (origin +
 * access token). Switching rewrites `~/.yaac-client/server.json`, the same
 * machine-wide selection `yaac remote set/on` writes, so the CLI follows;
 * the shell then relands the window on the new origin, so a successful
 * switch tears this page down mid-flight ("Reconnecting…" is the last
 * thing it shows).
 */
export function ServerSettings(): JSX.Element {
  const bridge = serverBridge()
  const [targets, setTargets] = useState<DesktopServerTargets | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // a server origin, or 'add'
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!bridge) return
    void bridge.targets().then(setTargets).catch((e: unknown) => console.error(e))
  }, [bridge])

  if (!bridge) {
    // Unreachable through the settings nav (the section is hidden without
    // the bridge) — a browser tab is already attached to the origin that
    // served it, so there is nothing to switch.
    return <section><h2 className="text-sm font-semibold">Server</h2></section>
  }

  const switchTo = async (sel: DesktopServerSelection): Promise<void> => {
    setBusy(sel.url)
    setError(null)
    try {
      const outcome = await bridge.switchTo(sel)
      if (!outcome.ok) setError(outcome.error)
      else setSwitching(true) // the shell relands the window now
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to switch server')
    } finally {
      setBusy(null)
    }
  }

  const addRemote = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const rawUrl = form.get('url')
    const rawToken = form.get('token')
    const url = (typeof rawUrl === 'string' ? rawUrl : '').trim()
    const token = (typeof rawToken === 'string' ? rawToken : '').trim()
    if (!url || !token) return
    setBusy('add')
    setError(null)
    try {
      const outcome = await bridge.addRemote(url, token)
      if (!outcome.ok) {
        setError(outcome.error)
        return
      }
      formElement.reset()
      setSwitching(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to add remote')
    } finally {
      setBusy(null)
    }
  }

  const saved = targets?.saved ?? []

  return (
    <section>
      <h2 className="text-sm font-semibold">Server</h2>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        Which yaac server this app is attached to. Switching applies machine-wide
        (the <code className="text-text-dim">yaac</code> CLI follows) and reconnects the window.
      </p>

      {switching && (
        <p className="mt-3 text-xs text-accent">Reconnecting…</p>
      )}

      <div className="mt-4 space-y-1.5 text-xs">
        {saved.length === 0 && (
          <p className="text-[11px] text-text-faint">No servers configured yet.</p>
        )}
        {saved.map((url) => (
          <div key={url} className="flex items-center justify-between rounded-md bg-bg px-2.5 py-1.5">
            <span className="truncate font-mono text-text-dim">{url}</span>
            {targets?.current === url ? (
              <span className="ml-2 flex shrink-0 items-center gap-1 text-[11px] text-emerald-400">
                <CheckIcon size={12} /> Connected
              </span>
            ) : (
              <button
                onClick={() => void switchTo({ url })}
                disabled={busy !== null || switching}
                className="ml-2 shrink-0 rounded-md bg-surface-3 px-2.5 py-0.5 text-[11px] font-medium
                  text-text transition hover:bg-border-strong disabled:opacity-50"
              >
                {busy === url ? 'Connecting…' : 'Connect'}
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="mt-6">
        <div className="text-xs font-medium text-text">Add a server</div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
          A yaac server origin (e.g. https://host.ts.net, or http://127.0.0.1:8787 for
          one on this machine) and an access token minted there
          with <code className="text-text-dim">yaac auth token create &lt;name&gt;</code>.
        </p>
        <form onSubmit={(e) => void addRemote(e)} className="mt-2 flex gap-2">
          <input
            name="url"
            placeholder="https://host.ts.net"
            className="flex-1 rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-text
              outline-none focus:border-border-strong"
          />
          <input
            name="token"
            type="password"
            placeholder="token"
            className="w-40 rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-text
              outline-none focus:border-border-strong"
          />
          <button
            type="submit"
            disabled={busy !== null || switching}
            className="shrink-0 rounded-md bg-surface-3 px-3 text-xs font-medium text-text transition
              hover:bg-border-strong disabled:opacity-50"
          >
            {busy === 'add' ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      </div>

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </section>
  )
}
