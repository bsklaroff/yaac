import { useEffect, useState, type FormEvent, type JSX } from 'react'
import clsx from 'clsx'
import { Dialog } from '@base-ui/react/dialog'
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { CloseIcon, GeneralIcon, KeyIcon, SettingsIcon, TOOL_LABEL } from '@/frontend/lib/icons'
import { addGitCredential, getAuthList, getDefaultTool, setDefaultTool } from '@/frontend/lib/settingsApi'
import type { AgentTool, AuthListResult } from '@/shared/types'

const TOOLS: AgentTool[] = ['claude', 'codex', 'opencode']

type SettingsSection = 'general' | 'credentials'

const SECTIONS: { key: SettingsSection; label: string; Icon: typeof GeneralIcon }[] = [
  { key: 'general', label: 'General', Icon: GeneralIcon },
  { key: 'credentials', label: 'Credentials', Icon: KeyIcon },
]

/**
 * Rail gear → settings. Notion-style modal: a left nav of sections over a
 * scrollable content pane (General: default tool; Credentials: listing +
 * add git token).
 */
export function SettingsButton(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<SettingsSection>('general')
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
        className="flex h-7 w-7 items-center justify-center rounded-2xl text-text-faint transition-all
          hover:rounded-[9px] hover:text-text-dim"
      >
        <SettingsIcon size={14} />
      </button>

      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[1px] transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 flex h-[480px] max-h-[calc(100vh-4rem)] w-[720px]
          max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border
          border-white/[0.06] bg-surface text-text shadow-[0_16px_48px_rgba(0,0,0,0.5)] outline-none
          transition duration-150 data-[starting-style]:scale-95 data-[starting-style]:opacity-0
          data-[ending-style]:scale-95 data-[ending-style]:opacity-0">
          {/* Left nav */}
          <div className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-white/[0.04] bg-bg/50 p-2">
            <Dialog.Title className="px-2 pb-2 pt-1 text-xs font-semibold text-text-dim">Settings</Dialog.Title>
            {SECTIONS.map(({ key, label, Icon }) => (
              <button
                key={key}
                onClick={() => setSection(key)}
                className={clsx(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition',
                  section === key
                    ? 'bg-surface-2 font-medium text-text'
                    : 'text-text-dim hover:bg-surface-2/60 hover:text-text',
                )}
              >
                <Icon size={13} className="shrink-0" />
                {label}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="relative min-w-0 flex-1 overflow-y-auto p-6">
            <Dialog.Close className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded
              text-text-faint transition hover:bg-surface-2 hover:text-text" aria-label="Close settings">
              <CloseIcon size={14} />
            </Dialog.Close>

            {section === 'general' && (
              <section>
                <h2 className="text-sm font-semibold">General</h2>
                <Field
                  label="Default tool"
                  hint="Used for prewarmed containers and as the initial pick when creating a session."
                >
                  <RadioGroup
                    value={tool ?? undefined}
                    onValueChange={(value) => pickTool(value as AgentTool)}
                    className="flex flex-col gap-1"
                  >
                    {TOOLS.map((t) => (
                      <label
                        key={t}
                        className="flex w-fit cursor-default items-center gap-2.5 rounded-md py-1 pr-2 text-xs
                          text-text-dim transition hover:text-text"
                      >
                        <Radio.Root
                          value={t}
                          className="flex h-4 w-4 items-center justify-center rounded-full border border-border-strong
                            transition data-[checked]:border-accent data-[checked]:bg-accent"
                        >
                          <Radio.Indicator className="h-1.5 w-1.5 rounded-full bg-surface data-[unchecked]:hidden" />
                        </Radio.Root>
                        {TOOL_LABEL[t]}
                      </label>
                    ))}
                  </RadioGroup>
                </Field>
              </section>
            )}

            {section === 'credentials' && (
              <section>
                <h2 className="text-sm font-semibold">Credentials</h2>
                <Field label="Configured" hint="Git tokens and tool auth yaac injects into session containers.">
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
                </Field>
                <Field label="Add git credential" hint="HTTPS token for a host pattern, e.g. github.com/*.">
                  <AddGitCredential onAdded={refresh} />
                </Field>
              </section>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** A labeled settings field: small bold label, dim hint, then the control. */
function Field({ label, hint, children }: { label: string; hint?: string; children: JSX.Element }): JSX.Element {
  return (
    <div className="mt-6">
      <div className="text-xs font-medium text-text">{label}</div>
      {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">{hint}</p>}
      <div className="mt-2">{children}</div>
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
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2">
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
