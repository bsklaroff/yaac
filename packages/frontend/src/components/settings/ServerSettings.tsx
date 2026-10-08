import { useEffect, useState, type FormEvent, type JSX } from 'react'
import { CheckIcon, DeleteIcon } from '#lib/icons'
import { serverBridge } from '#lib/desktopServer'
import { api } from '#lib/api'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import type { DesktopServerSelection, DesktopServerTargets, Principal } from '@yaac/shared/types'

/**
 * Desktop-only server picker. Lists the servers this machine has
 * configured, adds one by origin, and forgets any but the connected one.
 * Switching rewrites `~/.yaac-client/server.json` (the same selection
 * `yaac remote set/on` writes, so the CLI follows), then the shell reloads
 * the window on the new origin, unloading this page.
 */
export function ServerSettings(): JSX.Element {
  const bridge = serverBridge()
  const [targets, setTargets] = useState<DesktopServerTargets | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // a server origin, `remove:<origin>`, or 'add'
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [principal, setPrincipal] = useState<Principal | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  useEffect(() => {
    if (!bridge) return
    void bridge.targets().then(setTargets).catch((e: unknown) => console.error(e))
    void api.whoami.$get().then(setPrincipal).catch((e: unknown) => console.error(e))
  }, [bridge])

  if (!bridge) {
    // The nav hides this section outside the desktop shell.
    return <section><h2 className="text-sm font-semibold">Server</h2></section>
  }

  const switchTo = async (sel: DesktopServerSelection): Promise<void> => {
    setBusy(sel.url)
    setError(null)
    try {
      const outcome = await bridge.switchTo(sel)
      if (!outcome.ok) setError(outcome.error)
      else setSwitching(true) // the shell reloads the window
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to switch server')
    } finally {
      setBusy(null)
    }
  }

  const remove = async (url: string): Promise<void> => {
    setBusy(`remove:${url}`)
    setError(null)
    try {
      const outcome = await bridge.remove({ url })
      if (!outcome.ok) {
        setError(outcome.error)
        return
      }
      setConfirmRemove(null)
      setTargets(await bridge.targets())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to remove server')
    } finally {
      setBusy(null)
    }
  }

  const addRemote = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const rawUrl = form.get('url')
    const url = (typeof rawUrl === 'string' ? rawUrl : '').trim()
    if (!url) return
    setBusy('add')
    setError(null)
    try {
      const outcome = await bridge.addRemote(url)
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
      {principal?.kind === 'tailnet' && (
        <p className="mt-1 text-[11px] text-text-dim">Signed in as {principal.login}</p>
      )}

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
              <div className="ml-2 flex shrink-0 items-center gap-1">
                <button
                  onClick={() => void switchTo({ url })}
                  disabled={busy !== null || switching}
                  className="rounded-md bg-surface-3 px-2.5 py-0.5 text-[11px] font-medium
                    text-text transition hover:bg-border-strong disabled:opacity-50"
                >
                  {busy === url ? 'Connecting…' : 'Connect'}
                </button>
                <button
                  onClick={() => { setError(null); setConfirmRemove(url) }}
                  disabled={busy !== null || switching}
                  title="Remove"
                  aria-label={`Remove ${url}`}
                  className="rounded-md p-1 text-text-faint transition hover:bg-surface-3 hover:text-danger
                    disabled:opacity-50"
                >
                  <DeleteIcon size={12} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-6">
        <div className="text-xs font-medium text-text">Add a server</div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
          A yaac server origin: https://host.ts.net for one served over your tailnet,
          or http://127.0.0.1:8787 for one on this machine. The server knows you by
          your tailnet login; there is nothing to paste.
        </p>
        <form onSubmit={(e) => void addRemote(e)} className="mt-2 flex gap-2">
          <input
            name="url"
            placeholder="https://host.ts.net"
            className="flex-1 rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-text
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

      {error && confirmRemove === null && <p className="mt-2 text-xs text-red-400">{error}</p>}

      <ConfirmDialog
        open={confirmRemove !== null}
        onOpenChange={(open) => { if (!open) { setConfirmRemove(null); setError(null) } }}
        title="Remove server?"
        description={`Removes ${confirmRemove ?? ''} from this machine's server list, for the app and the yaac CLI alike. The server itself keeps running; add it again to reconnect.`}
        confirmLabel="Remove"
        busy={confirmRemove !== null && busy === `remove:${confirmRemove}`}
        error={error ?? undefined}
        onConfirm={() => { if (confirmRemove !== null) void remove(confirmRemove) }}
      />
    </section>
  )
}
