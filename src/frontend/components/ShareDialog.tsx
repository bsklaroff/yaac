import { useEffect, useState, type JSX } from 'react'
import clsx from 'clsx'
import { Dialog } from '@base-ui/react/dialog'
import { CloseIcon } from '@/frontend/lib/icons'
import {
  createInvite,
  getAuthMe,
  inviteUrl,
  listInvites,
  revokeInvite,
  type SessionInvite,
} from '@/frontend/lib/invitesApi'

function relativeExpiry(expiresAt: number): string {
  const days = Math.max(0, Math.round((expiresAt - Date.now()) / 86_400_000))
  return days <= 1 ? 'expires soon' : `expires in ${days}d`
}

/**
 * Share a session: mint a scoped invite link (view or drive), copy it,
 * and manage existing links. Loopback-only v1 — the link works for
 * anyone who can reach this daemon's address.
 */
export function ShareDialog({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  const [mode, setMode] = useState<'view' | 'drive'>('view')
  const [invites, setInvites] = useState<SessionInvite[] | null>(null)
  const [created, setCreated] = useState<SessionInvite | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shareOrigin, setShareOrigin] = useState<string | null>(null)

  const refresh = (): void => {
    void listInvites(sessionId).then(setInvites).catch((e: unknown) => console.error(e))
  }

  useEffect(() => {
    if (!open) return
    setCreated(null)
    setError(null)
    void listInvites(sessionId).then(setInvites).catch((e: unknown) => console.error(e))
    void getAuthMe().then((me) => setShareOrigin(me.shareOrigin)).catch(() => setShareOrigin(null))
  }, [open, sessionId])

  const onCreate = (): void => {
    setError(null)
    void createInvite(sessionId, mode)
      .then((invite) => {
        setCreated(invite)
        refresh()
        void copy(invite.token)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'failed to create link'))
  }

  const copy = async (token: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(inviteUrl(token, shareOrigin))
      setCopied(token)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      // clipboard unavailable — the link is still shown for manual copy
    }
  }

  const onRevoke = (token: string): void => {
    if (created?.token === token) setCreated(null)
    void revokeInvite(sessionId, token)
      .then(refresh)
      .catch((e: unknown) => console.error('revoke failed', e))
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[1px] transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 w-[460px] max-w-[calc(100vw-2rem)] -translate-x-1/2
          -translate-y-1/2 rounded-lg border border-white/[0.06] bg-surface-2 p-5 text-text
          shadow-[0_16px_48px_rgba(0,0,0,0.5)] outline-none transition duration-150
          data-[starting-style]:scale-95 data-[starting-style]:opacity-0
          data-[ending-style]:scale-95 data-[ending-style]:opacity-0">
          <Dialog.Title className="text-sm font-semibold">Share session</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs leading-relaxed text-text-dim">
            {shareOrigin
              ? 'Links use your tailnet address — anyone on your tailnet with the link gets this one session, nothing else.'
              : 'Links use this machine\'s local address. Enable "Share over tailnet" in Settings (and restart the daemon) for teammate-reachable links.'}
          </Dialog.Description>

          <div className="mt-4 flex items-center gap-2">
            <div className="flex gap-1 rounded-lg bg-bg p-1">
              {(['view', 'drive'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={clsx(
                    'rounded-md px-3 py-1.5 text-xs font-medium transition',
                    mode === m ? 'bg-surface-3 text-text' : 'text-text-dim hover:text-text',
                  )}
                >
                  {m === 'view' ? 'View only' : 'Can drive'}
                </button>
              ))}
            </div>
            <button
              onClick={onCreate}
              className="ml-auto flex h-8 items-center rounded-md bg-accent px-3 text-xs font-medium text-bg
                transition hover:brightness-110"
            >
              Create link
            </button>
          </div>

          {created && (
            <div className="mt-3 rounded-md bg-bg px-2.5 py-2 text-xs">
              <div className="break-all font-mono text-text-dim">{inviteUrl(created.token, shareOrigin)}</div>
              <div className="mt-1 text-[11px] text-text-faint">
                {copied === created.token ? 'Copied to clipboard' : 'Copy and send to a teammate'}
              </div>
            </div>
          )}
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

          {invites && invites.length > 0 && (
            <div className="mt-4">
              <div className="mb-1.5 text-[11px] font-medium text-text-faint">Active links</div>
              <div className="space-y-1">
                {invites.map((i) => (
                  <div key={i.token} className="flex items-center gap-2 rounded-md bg-bg px-2.5 py-1.5 text-xs">
                    <span className={clsx(
                      'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                      i.mode === 'drive' ? 'bg-accent-soft/40 text-accent' : 'bg-surface-3 text-text-dim',
                    )}>
                      {i.mode === 'drive' ? 'drive' : 'view'}
                    </span>
                    <button
                      onClick={() => void copy(i.token)}
                      className="min-w-0 flex-1 truncate text-left font-mono text-text-dim transition hover:text-text"
                      title="Copy link"
                    >
                      {copied === i.token ? 'Copied!' : `…${i.token.slice(-12)}`}
                    </button>
                    <span className="shrink-0 text-[10px] text-text-faint">{relativeExpiry(i.expiresAt)}</span>
                    <button
                      onClick={() => onRevoke(i.token)}
                      title="Revoke link"
                      aria-label="Revoke link"
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-faint
                        transition hover:bg-surface-3 hover:text-text"
                    >
                      <CloseIcon size={11} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-5 flex justify-end">
            <Dialog.Close className="flex h-8 items-center rounded-md px-3 text-xs text-text-dim transition
              hover:bg-surface-3 hover:text-text">
              Done
            </Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
