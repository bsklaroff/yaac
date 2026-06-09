import { useEffect, useState, type FormEvent, type JSX } from 'react'
import clsx from 'clsx'
import { Dialog } from '@base-ui/react/dialog'
import { SettingsIcon, TOOL_LABEL } from '@/frontend/lib/icons'
import { addGitCredential, getAuthList, getDefaultTool, setDefaultTool } from '@/frontend/lib/settingsApi'
import type { AgentTool, AuthListResult } from '@/shared/types'

const TOOLS: AgentTool[] = ['claude', 'codex', 'opencode']

/** Rail gear → settings: default tool, credentials listing, add git token. */
export function SettingsButton(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [tool, setTool] = useState<AgentTool | null>(null)
  const [auth, setAuth] = useState<AuthListResult | null>(null)

  const refresh = (): void => {
    void getDefaultTool().then(setTool).catch((e: unknown) => console.error(e))
    void getAuthList().then(setAuth).catch((e: unknown) => console.error(e))
  }

  useEffect(() => { if (open) refresh() }, [open])

  const pickTool = (t: AgentTool): void => {
    setTool(t)
    void setDefaultTool(t).catch((e: unknown) => console.error(e))
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <button
        onClick={() => setOpen(true)}
        title="Settings"
        className="flex h-8 w-8 items-center justify-center rounded-2xl text-text-faint transition-all
          hover:rounded-[9px] hover:text-text-dim"
      >
        <SettingsIcon size={14} />
      </button>

      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[1px] transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 w-[480px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2
          rounded-lg border border-border bg-surface-2 p-5 text-text shadow-[0_16px_48px_rgba(0,0,0,0.5)] outline-none
          transition duration-150 data-[starting-style]:scale-95 data-[starting-style]:opacity-0
          data-[ending-style]:scale-95 data-[ending-style]:opacity-0">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-sm font-semibold">Settings</Dialog.Title>
            <Dialog.Close className="text-xs text-text-dim hover:text-text">Done</Dialog.Close>
          </div>

          <Section label="Default tool">
            <div className="flex gap-1 rounded-lg bg-bg p-1">
              {TOOLS.map((t) => (
                <button
                  key={t}
                  onClick={() => pickTool(t)}
                  className={clsx(
                    'flex flex-1 items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium transition',
                    tool === t ? 'bg-surface-3 text-text' : 'text-text-dim hover:text-text',
                  )}
                >
                  {TOOL_LABEL[t]}
                </button>
              ))}
            </div>
          </Section>

          <Section label="Credentials">
            <div className="space-y-1.5 text-xs">
              {auth?.gitCredentials.map((c) => (
                <Row key={c.pattern} left={`git · ${c.pattern}`} right={c.preview} />
              ))}
              {auth?.toolAuth.map((t) => (
                <Row key={t.tool} left={`${t.tool} · ${t.kind}`} right={t.keyPreview} />
              ))}
              {auth && auth.gitCredentials.length === 0 && auth.toolAuth.length === 0 && (
                <p className="text-text-faint">No credentials configured.</p>
              )}
            </div>
            <AddGitCredential onAdded={refresh} />
          </Section>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Section({ label, children }: { label: string; children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <div className="mt-5">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-faint">{label}</div>
      {children}
    </div>
  )
}

function Row({ left, right }: { left: string; right: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between rounded-md bg-bg px-2.5 py-1.5">
      <span className="truncate font-mono text-text-dim">{left}</span>
      <span className="ml-2 shrink-0 font-mono text-text-faint">{right}</span>
    </div>
  )
}

function AddGitCredential({ onAdded }: { onAdded: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const rawPattern = form.get('pattern')
    const rawToken = form.get('token')
    const pattern = (typeof rawPattern === 'string' ? rawPattern : '').trim()
    const token = (typeof rawToken === 'string' ? rawToken : '').trim()
    if (!pattern || !token) return
    setBusy(true)
    setError(null)
    try {
      await addGitCredential(pattern, token)
      event.currentTarget.reset()
      onAdded()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to add credential')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-2 flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          name="pattern"
          placeholder="github.com/*"
          className="w-40 rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-text
            outline-none focus:border-border-strong"
        />
        <input
          name="token"
          type="password"
          placeholder="token"
          className="flex-1 rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-text
            outline-none focus:border-border-strong"
        />
        <button
          type="submit"
          disabled={busy}
          className="shrink-0 rounded-md bg-surface-3 px-3 text-xs font-medium text-text transition
            hover:bg-border-strong disabled:opacity-50"
        >
          {busy ? 'Adding…' : 'Add'}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </form>
  )
}
