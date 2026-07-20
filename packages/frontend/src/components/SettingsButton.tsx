import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@base-ui/react/dialog'
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import {
  CloseIcon,
  DockerIcon,
  GeneralIcon,
  KeyboardIcon,
  KeyIcon,
  ProjectConfigIcon,
  ScheduleIcon,
  ServerIcon,
  SettingsIcon,
  TOOL_LABEL,
} from '#lib/icons'
import {
  addGitCredential,
  cancelToolInstall,
  cancelToolLogin,
  clearToolAuth,
  getDefaultTool,
  getToolInstall,
  getToolLogin,
  getUserDockerfile,
  resetShortcuts,
  saveUserDockerfile,
  sendToolLoginInput,
  setDefaultTool,
  setShortcutOverride,
  setToolApiKey,
  startToolInstall,
  startToolLogin,
} from '#lib/settingsApi'
import { AUTH_LIST_KEY, useAuthList } from '#lib/useAuthList'
import {
  SHORTCUTS, chordFromEvent, chordsEqual, formatChord, isModifierCode, validateChord, type ShortcutId,
} from '#lib/shortcuts'
import { ProjectSettings } from '#components/settings/ProjectSettings'
import { ScheduleSettings } from '#components/settings/ScheduleSettings'
import { ServerSettings } from '#components/settings/ServerSettings'
import { serverBridge } from '#lib/desktopServer'
import { FileEditor } from '#components/settings/FileEditor'
import { BuildFiles } from '#components/settings/BuildFiles'
import { userBuildFilesApi } from '#lib/buildFilesApi'
import { useUiStore, type SettingsSection } from '#store'
import type { ThemePref } from '#lib/theme'
import type { AgentTool, ToolAuthSummary, ToolInstallView, ToolLoginView } from '@yaac/shared/types'
import { OPENCODE_PROVIDERS, PI_PROVIDERS } from '@yaac/shared/tool-providers'

// iPadOS reports as "Macintosh" in modern Safari; both want the ⌘/⌥ glyphs.
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

const TOOLS: AgentTool[] = ['claude', 'codex', 'opencode', 'pi']

/**
 * Provider picker options for the api-key-only tools. Each key selects which
 * backend the pasted key authenticates against (env var + proxy host); the
 * first entry is the default. Tools not listed here have no provider.
 */
interface ProviderOption { id: string; label: string }
const PROVIDER_OPTIONS: Partial<Record<AgentTool, ProviderOption[]>> = {
  opencode: OPENCODE_PROVIDERS.map((p) => ({ id: p.id, label: p.label })),
  pi: PI_PROVIDERS.map((p) => ({ id: p.id, label: p.label })),
}

/** Default provider id for a tool that has a picker, else undefined. */
function defaultProvider(tool: AgentTool): string | undefined {
  return PROVIDER_OPTIONS[tool]?.[0].id
}

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const SECTIONS: { key: SettingsSection; label: string; Icon: typeof GeneralIcon }[] = [
  { key: 'general', label: 'General', Icon: GeneralIcon },
  { key: 'server', label: 'Server', Icon: ServerIcon },
  { key: 'shortcuts', label: 'Shortcuts', Icon: KeyboardIcon },
  { key: 'credentials', label: 'Credentials', Icon: KeyIcon },
  { key: 'project', label: 'Project Config', Icon: ProjectConfigIcon },
  { key: 'schedules', label: 'Schedules', Icon: ScheduleIcon },
  { key: 'userDockerfile', label: 'User Dockerfile', Icon: DockerIcon },
]

/**
 * The nav entries for this environment. 'server' switches which server the
 * desktop shell attaches to, so it exists only where the preload bridge
 * does — in a plain browser the tab is already bound to the origin that
 * served it and the section would be a no-op.
 */
function visibleSections(): typeof SECTIONS {
  return serverBridge() ? SECTIONS : SECTIONS.filter((s) => s.key !== 'server')
}

/**
 * Rail gear → settings. Notion-style modal: a left nav of sections over a
 * scrollable content pane (General: default tool; Credentials: tool sign-in +
 * git tokens). Open state lives in the store so other surfaces (the
 * new-session menu's "Sign in") can open it onto a specific section.
 */
export function SettingsButton(): JSX.Element {
  const open = useUiStore((s) => s.settingsOpen)
  const section = useUiStore((s) => s.settingsSection)
  const openSettings = useUiStore((s) => s.openSettings)
  const closeSettings = useUiStore((s) => s.closeSettings)
  const setSection = useUiStore((s) => s.setSettingsSection)
  const themePref = useUiStore((s) => s.themePref)
  const setThemePref = useUiStore((s) => s.setThemePref)
  const soundEnabled = useUiStore((s) => s.soundEnabled)
  const setSoundEnabled = useUiStore((s) => s.setSoundEnabled)
  const [tool, setTool] = useState<AgentTool | null>(null)
  const queryClient = useQueryClient()

  // On open, re-pull both the default tool and the credentials list — either
  // may have changed server-side (e.g. via the CLI) since the last look.
  useEffect(() => {
    if (!open) return
    void getDefaultTool().then(setTool).catch((e: unknown) => console.error(e))
    void queryClient.invalidateQueries({ queryKey: AUTH_LIST_KEY })
  }, [open, queryClient])

  const pickTool = (t: AgentTool): void => {
    setTool(t)
    void setDefaultTool(t).catch((e: unknown) => console.error(e))
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (next) openSettings(); else closeSettings() }}>
      <button
        onClick={() => openSettings()}
        title="Settings"
        className="flex h-10 w-10 items-center justify-center rounded-[20px] text-text-faint transition-all
          hover:rounded-xl hover:text-text-dim"
      >
        <SettingsIcon size={18} />
      </button>

      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[1px] transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 flex h-[480px] max-h-[calc(100vh-4rem)] w-[720px]
          max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border
          border-hairline bg-surface text-text shadow-[0_16px_48px_var(--shadow-color)] outline-none
          transition duration-150 data-[starting-style]:scale-95 data-[starting-style]:opacity-0
          data-[ending-style]:scale-95 data-[ending-style]:opacity-0">
          {/* Left nav */}
          <div className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-hairline-soft bg-bg/50 p-2">
            <Dialog.Title className="px-2 pb-2 pt-1 text-xs font-semibold text-text-dim">Settings</Dialog.Title>
            {visibleSections().map(({ key, label, Icon }) => (
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
                  hint="The initial pick when creating a session."
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
                <Field
                  label="Theme"
                  hint="Follows your system appearance unless you pick one."
                >
                  <RadioGroup
                    value={themePref}
                    onValueChange={(value) => setThemePref(value as ThemePref)}
                    className="flex flex-col gap-1"
                  >
                    {THEMES.map((t) => (
                      <label
                        key={t.value}
                        className="flex w-fit cursor-default items-center gap-2.5 rounded-md py-1 pr-2 text-xs
                          text-text-dim transition hover:text-text"
                      >
                        <Radio.Root
                          value={t.value}
                          className="flex h-4 w-4 items-center justify-center rounded-full border border-border-strong
                            transition data-[checked]:border-accent data-[checked]:bg-accent"
                        >
                          <Radio.Indicator className="h-1.5 w-1.5 rounded-full bg-surface data-[unchecked]:hidden" />
                        </Radio.Root>
                        {t.label}
                      </label>
                    ))}
                  </RadioGroup>
                </Field>
                <Field
                  label="Sounds"
                  hint="Play a chime when a session needs your input."
                >
                  <button
                    type="button"
                    role="switch"
                    aria-checked={soundEnabled}
                    aria-label="Sounds"
                    onClick={() => setSoundEnabled(!soundEnabled)}
                    className={clsx(
                      'relative flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
                      soundEnabled ? 'bg-accent' : 'bg-surface-3',
                    )}
                  >
                    <span
                      className={clsx(
                        'h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                        soundEnabled ? 'translate-x-[18px]' : 'translate-x-0.5',
                      )}
                    />
                  </button>
                </Field>
              </section>
            )}

            {section === 'server' && <ServerSettings />}

            {section === 'shortcuts' && <ShortcutsPane />}

            {section === 'credentials' && <CredentialsPane />}

            {section === 'project' && <ProjectSettings />}

            {section === 'schedules' && <ScheduleSettings />}

            {section === 'userDockerfile' && <UserDockerfilePane />}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * The global user image layer: the Dockerfile.user editor plus the support
 * files sharing its build dir (the layer's whole build context).
 */
function UserDockerfilePane(): JSX.Element {
  const filesApi = useMemo(() => userBuildFilesApi(), [])
  return (
    <section>
      <h2 className="text-sm font-semibold">User Dockerfile</h2>
      <Field
        label="Dockerfile.user"
        hint={(
          <>
            Layered atop every project image. Must start with{' '}
            <code className="text-text-dim">{'ARG BASE_IMAGE'}</code> and{' '}
            <code className="text-text-dim">{'FROM ${BASE_IMAGE}'}</code>.
          </>
        )}
      >
        <FileEditor
          title="Dockerfile.user"
          language="dockerfile"
          load={getUserDockerfile}
          save={saveUserDockerfile}
        />
      </Field>
      <Field
        label="Build files"
        hint={(
          <>
            Files stored next to Dockerfile.user as its build context — reference them
            with <code className="text-text-dim">COPY</code>. Changes apply on the next
            rebuild or session create.
          </>
        )}
      >
        <BuildFiles filesApi={filesApi} title="Dockerfile.user" />
      </Field>
    </section>
  )
}

/**
 * Per-tool sign-in plus git tokens. Each tool row shows its stored credential
 * (masked) with a sign-out, or a sign-in expander: claude/codex can import the
 * native login already on the server's machine or take a pasted API key;
 * opencode takes a provider pick + API key. New-session creation is blocked
 * per tool until a credential lands here.
 */
function CredentialsPane(): JSX.Element {
  const auth = useAuthList()
  const focusTool = useUiStore((s) => s.settingsFocusTool)
  const queryClient = useQueryClient()
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: AUTH_LIST_KEY })
  }

  return (
    <section>
      <h2 className="text-sm font-semibold">Credentials</h2>
      <Field label="Agent tools" hint="Sign in to create sessions with a tool. Keys stay on this machine — containers only ever see placeholders.">
        <div className="space-y-1.5 text-xs">
          {TOOLS.map((t) => (
            <ToolAuthRow
              key={t}
              tool={t}
              summary={auth?.toolAuth.find((a) => a.tool === t) ?? null}
              autoExpand={focusTool === t}
              onChanged={refresh}
            />
          ))}
        </div>
      </Field>
      <Field label="Git credentials" hint="HTTPS tokens injected into session containers.">
        <div className="space-y-1.5 text-xs">
          {auth?.gitCredentials.map((c) => (
            <Row key={c.pattern} left={`git · ${c.pattern}`} right={c.preview} />
          ))}
          {auth && auth.gitCredentials.length === 0 && (
            <p className="text-text-faint">No git credentials configured.</p>
          )}
        </div>
      </Field>
      <Field label="Add git credential" hint="HTTPS token for a host pattern, e.g. github.com/*.">
        <AddGitCredential onAdded={refresh} />
      </Field>
    </section>
  )
}

/** What the key-paste input asks for, per tool (and opencode/pi provider). */
function apiKeyLabel(tool: AgentTool, provider: string | undefined): string {
  if (tool === 'claude') return 'Anthropic API key'
  if (tool === 'codex') return 'OpenAI API key'
  const label = PROVIDER_OPTIONS[tool]?.find((o) => o.id === provider)?.label
  return label ? `${label} API key` : 'API key'
}

/** Max provider rows rendered at once; the rest surface by narrowing the search. */
const PROVIDER_VISIBLE_LIMIT = 50

/**
 * Searchable provider picker for the api-key-only tools. opencode exposes 150+
 * providers (models.dev) and pi a few dozen, so this filters an inline,
 * scrollable list by a search box rather than showing a radio row. The stored
 * value is the provider id.
 */
function ProviderCombobox({ options, value, onChange }: {
  options: ProviderOption[]
  value: string
  onChange: (id: string) => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const matches = q
    ? options.filter((o) => o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q))
    : options
  const shown = matches.slice(0, PROVIDER_VISIBLE_LIMIT)
  const hidden = matches.length - shown.length

  return (
    <div className="flex flex-col gap-1.5">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search providers…"
        className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-xs
          text-text outline-none focus:border-border-strong"
      />
      <div className="max-h-40 overflow-y-auto rounded-md border border-hairline-soft">
        {shown.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-text-faint">No providers found.</p>
        ) : (
          shown.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => onChange(o.id)}
              className={clsx(
                'flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[11px] transition',
                o.id === value
                  ? 'bg-surface-3 text-text'
                  : 'text-text-dim hover:bg-surface-2 hover:text-text',
              )}
            >
              <span className="truncate">{o.label}</span>
              <span className="shrink-0 font-mono text-[10px] text-text-faint">{o.id}</span>
            </button>
          ))
        )}
        {hidden > 0 && (
          <p className="px-2 py-1 text-[10px] text-text-faint">+{hidden} more — keep typing to narrow.</p>
        )}
      </div>
    </div>
  )
}

/**
 * One tool's credential row. Signed in: masked key + sign-out. Signed out:
 * a "Sign in" expander with the tool's available methods.
 */
function ToolAuthRow({ tool, summary, autoExpand, onChanged }: {
  tool: AgentTool
  summary: ToolAuthSummary | null
  autoExpand: boolean
  onChanged: () => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState<'save' | 'signout' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [justSignedIn, setJustSignedIn] = useState(false)
  const providerOptions = PROVIDER_OPTIONS[tool]
  const [provider, setProvider] = useState<string>(defaultProvider(tool) ?? 'openrouter')

  // Opened via a "Sign in" affordance elsewhere (new-session menu) — land
  // with this tool's form already open.
  useEffect(() => {
    if (autoExpand && !summary) setExpanded(true)
  }, [autoExpand, summary])

  const run = async (kind: 'save' | 'signout', op: () => Promise<void>): Promise<void> => {
    setBusy(kind)
    setError(null)
    try {
      await op()
      setExpanded(false)
      setJustSignedIn(kind === 'save') // sign-out clears a stale confirmation
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : `failed to ${kind === 'signout' ? 'sign out' : 'sign in'}`)
    } finally {
      setBusy(null)
    }
  }

  const saveKey = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const formElement = event.currentTarget
    const raw = new FormData(formElement).get('apiKey')
    const apiKey = (typeof raw === 'string' ? raw : '').trim()
    if (!apiKey) return
    await run('save', async () => {
      await setToolApiKey(tool, apiKey, providerOptions ? provider : undefined)
      formElement.reset()
    })
  }

  return (
    <div className="rounded-md bg-bg px-2.5 py-1.5">
      <div className="flex items-center justify-between">
        <span className="truncate font-mono text-text-dim">
          {tool}
          {summary && ` · ${(() => {
            const p = summary.opencodeProvider ?? summary.piProvider
            return p ? `${p} · ` : ''
          })()}${summary.kind}`}
        </span>
        {summary ? (
          <span className="ml-2 flex shrink-0 items-center gap-2">
            <span className="font-mono text-text-faint">{summary.keyPreview}</span>
            <button
              onClick={() => void run('signout', () => clearToolAuth(tool))}
              disabled={busy !== null}
              className="rounded px-1.5 py-0.5 text-[11px] text-text-faint transition hover:text-text
                disabled:opacity-50"
            >
              {busy === 'signout' ? 'Signing out…' : 'Sign out'}
            </button>
          </span>
        ) : (
          <button
            onClick={() => { setError(null); setExpanded((e) => !e) }}
            className="ml-2 shrink-0 rounded-md bg-surface-3 px-2.5 py-0.5 text-[11px] font-medium text-text
              transition hover:bg-border-strong"
          >
            Sign in
          </button>
        )}
      </div>

      {justSignedIn && (
        <p className="mt-1 text-[11px] text-emerald-400">Signed in successfully.</p>
      )}

      {!summary && expanded && (
        <div className="mt-2 flex flex-col gap-2 border-t border-hairline-soft pt-2">
          {!providerOptions && (
            <>
              <CliSignIn tool={tool} onDone={() => { setJustSignedIn(true); onChanged() }} />
              <p className="text-[11px] text-text-faint">
                …or paste an API key:
              </p>
            </>
          )}
          {providerOptions && (
            <ProviderCombobox
              options={providerOptions}
              value={provider}
              onChange={setProvider}
            />
          )}
          <form onSubmit={(e) => void saveKey(e)} className="flex gap-2">
            <input
              name="apiKey"
              type="password"
              placeholder={apiKeyLabel(tool, provider)}
              className="flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-xs
                text-text outline-none focus:border-border-strong"
            />
            <button
              type="submit"
              disabled={busy !== null}
              className="shrink-0 rounded-md bg-surface-3 px-3 text-xs font-medium text-text transition
                hover:bg-border-strong disabled:opacity-50"
            >
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
          </form>
        </div>
      )}
      {error && <p className="mt-1.5 text-[11px] text-red-400">{error}</p>}
    </div>
  )
}

/**
 * The primary sign-in path: the server runs the vendor's own browser login
 * (`claude auth login` / `codex login`) in a subprocess. The CLI opens the
 * browser on this machine and completes via its localhost callback, so the
 * UI only shows "finish in your browser" and polls for the outcome.
 */
function CliSignIn({ tool, onDone }: { tool: AgentTool; onDone: () => void }): JSX.Element {
  const [login, setLogin] = useState<ToolLoginView | null>(null)
  const [install, setInstall] = useState<ToolInstallView | null>(null)
  const [justInstalled, setJustInstalled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [inputError, setInputError] = useState<string | null>(null)
  const label = tool === 'claude' ? 'Sign in with Claude' : 'Sign in with ChatGPT'
  const toolName = tool === 'claude' ? 'Claude Code' : 'Codex'

  // Poll while the flow runs. A vanished session (server restart, expiry)
  // resets to the start button.
  useEffect(() => {
    if (login?.status !== 'running') return
    const t = setInterval(() => {
      getToolLogin(login.id).then(setLogin).catch(() => setLogin(null))
    }, 1500)
    return () => clearInterval(t)
  }, [login])

  // One-shot: `onDone` comes in as a fresh closure each parent render, and
  // re-running this effect must not re-announce the same success.
  const doneRef = useRef(false)
  const succeeded = login?.status === 'success'
  useEffect(() => {
    if (!succeeded || doneRef.current) return
    doneRef.current = true
    onDone()
  }, [succeeded, onDone])

  // Same polling for a running install.
  useEffect(() => {
    if (install?.status !== 'running') return
    const t = setInterval(() => {
      getToolInstall(install.id).then(setInstall).catch(() => setInstall(null))
    }, 1500)
    return () => clearInterval(t)
  }, [install])

  // A finished install returns to the start button with a "try again" nudge.
  const installed = install?.status === 'success'
  useEffect(() => {
    if (!installed) return
    setInstall(null)
    setLogin(null)
    setJustInstalled(true)
  }, [installed])

  const start = async (): Promise<void> => {
    setBusy(true)
    doneRef.current = false
    try {
      setLogin(await startToolLogin(tool))
    } catch (err) {
      setLogin({
        id: '', tool, status: 'error',
        error: err instanceof Error ? err.message : 'failed to start sign-in',
      })
    } finally {
      setBusy(false)
    }
  }

  const cancel = (): void => {
    if (login?.status === 'running') void cancelToolLogin(login.id).catch(() => {})
    setLogin(null)
  }

  const installCli = async (): Promise<void> => {
    setBusy(true)
    setLogin(null)
    try {
      setInstall(await startToolInstall(tool))
    } catch (err) {
      setInstall({
        id: '', tool, status: 'error',
        error: err instanceof Error ? err.message : 'failed to start install',
      })
    } finally {
      setBusy(false)
    }
  }

  const cancelInstall = (): void => {
    if (install?.status === 'running') void cancelToolInstall(install.id).catch(() => {})
    setInstall(null)
  }

  if (install) {
    if (install.status === 'error') {
      return (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] text-red-400">{install.error ?? 'install failed'}</p>
          <div className="flex gap-2">
            <button
              onClick={() => void installCli()}
              className="w-fit rounded-md border border-border px-2.5 py-1 text-[11px] text-text-dim
                transition hover:border-border-strong hover:text-text"
            >
              Try again
            </button>
            <button
              onClick={cancelInstall}
              className="w-fit rounded px-1 py-0.5 text-[11px] text-text-faint transition hover:text-text"
            >
              Cancel
            </button>
          </div>
        </div>
      )
    }
    return (
      <div className="flex flex-col gap-2 rounded-md border border-accent/20 bg-accent/5 p-2.5">
        <div className="flex items-center gap-2.5">
          <p className="flex-1 text-[11px] leading-relaxed text-text-dim">
            Installing {toolName}…
          </p>
          <button
            onClick={cancelInstall}
            className="shrink-0 rounded px-1 py-0.5 text-[11px] text-text-faint transition hover:text-text"
          >
            Cancel
          </button>
        </div>
        {install.output && <CliOutput text={install.output} />}
      </div>
    )
  }

  if (!login) {
    return (
      <div className="flex flex-col gap-1">
        {justInstalled && (
          <p className="text-[11px] text-emerald-400">{toolName} installed — try signing in again.</p>
        )}
        <button
          onClick={() => void start()}
          disabled={busy}
          className="w-fit rounded-md bg-accent/15 px-2.5 py-1 text-[11px] font-medium text-accent transition
            hover:bg-accent/25 disabled:opacity-50"
        >
          {busy ? 'Starting…' : label}
        </button>
        <p className="text-[11px] text-text-faint">
          Opens a browser window on this machine to authorize.
        </p>
      </div>
    )
  }

  if (login.status === 'error') {
    if (login.cliMissing) {
      return (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] text-text-dim">{toolName} isn't installed on this machine.</p>
          <div className="flex gap-2">
            <button
              onClick={() => void installCli()}
              disabled={busy}
              className="w-fit rounded-md bg-accent/15 px-2.5 py-1 text-[11px] font-medium text-accent
                transition hover:bg-accent/25 disabled:opacity-50"
            >
              {busy ? 'Starting…' : `Install ${toolName}`}
            </button>
            <button
              onClick={cancel}
              className="w-fit rounded px-1 py-0.5 text-[11px] text-text-faint transition hover:text-text"
            >
              Cancel
            </button>
          </div>
        </div>
      )
    }
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-[11px] text-red-400">{login.error ?? 'sign-in failed'}</p>
        <button
          onClick={cancel}
          className="w-fit rounded-md border border-border px-2.5 py-1 text-[11px] text-text-dim transition
            hover:border-border-strong hover:text-text"
        >
          Try again
        </button>
      </div>
    )
  }

  const sendInput = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (login.status !== 'running') return
    const formElement = event.currentTarget
    const raw = new FormData(formElement).get('text')
    const text = (typeof raw === 'string' ? raw : '').trim()
    if (!text) return
    try {
      setLogin(await sendToolLoginInput(login.id, text))
      setInputError(null)
      formElement.reset()
    } catch (err) {
      // A rejected paste (server whitelists the code alphabet) shouldn't kill
      // the flow — surface it inline and let the user paste again.
      setInputError(err instanceof Error ? err.message : 'failed to send input')
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-accent/20 bg-accent/5 p-2.5">
      <div className="flex items-center gap-2.5">
        <p className="flex-1 text-[11px] leading-relaxed text-text-dim">
          Finish signing in from the browser window that just opened. No window? Use
          the sign-in link the CLI printed below.
        </p>
        <button
          onClick={cancel}
          className="shrink-0 rounded px-1 py-0.5 text-[11px] text-text-faint transition hover:text-text"
        >
          Cancel
        </button>
      </div>
      {login.output && <CliOutput text={login.output} />}
      {tool === 'claude' && (
        <>
          <form onSubmit={(e) => void sendInput(e)} className="flex items-center gap-2">
            <input
              name="text"
              autoComplete="off"
              placeholder="paste code here if prompted"
              className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono
                text-xs text-text outline-none focus:border-border-strong"
            />
            <button
              type="submit"
              className="shrink-0 rounded-md bg-surface-3 px-3 py-1 text-xs font-medium text-text transition
                hover:bg-border-strong"
            >
              Send
            </button>
          </form>
          {inputError && <p className="text-[11px] text-red-400">{inputError}</p>}
        </>
      )}
    </div>
  )
}

const URL_RE = /https:\/\/[^\s"'<>]+/g

/**
 * The login CLI's output, tailing live, with URLs clickable — the manual path
 * when the server couldn't open a browser on this machine.
 */
function CliOutput({ text }: { text: string }): JSX.Element {
  const boxRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])

  const parts: (string | JSX.Element)[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    parts.push(text.slice(last, m.index))
    parts.push(
      <a
        key={m.index}
        href={m[0]}
        target="_blank"
        rel="noreferrer"
        className="break-all font-medium text-accent underline decoration-accent/40 hover:decoration-accent"
      >
        {m[0]}
      </a>,
    )
    last = m.index + m[0].length
  }
  parts.push(text.slice(last))

  return (
    <pre
      ref={boxRef}
      className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded bg-bg/80 p-2 font-mono
        text-[10px] leading-relaxed text-text-dim"
    >
      {parts}
    </pre>
  )
}

/**
 * View + rebind every keyboard shortcut. Click a row to record; the next
 * keypress (with a modifier, not already bound) becomes its chord and persists.
 * While recording, the workspace keydown listeners bail (via the store's
 * `recordingShortcut` flag) so the captured chord doesn't also fire the command
 * it's being bound to.
 */
function ShortcutsPane(): JSX.Element {
  const bindings = useUiStore((s) => s.bindings)
  const setBinding = useUiStore((s) => s.setBinding)
  const resetBindings = useUiStore((s) => s.resetBindings)
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!recordingId) return
    const setRecording = useUiStore.getState().setRecordingShortcut
    setRecording(true)
    const onKeyDown = (e: KeyboardEvent): void => {
      // Swallow the chord so it neither fires an app shortcut nor most in-page
      // browser ones. Truly reserved chords (Ctrl+W…) are grabbed by the
      // browser first and never arrive here — they self-exclude.
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape') { setRecordingId(null); setError(null); return }
      if (isModifierCode(e.code)) return // still waiting for the non-modifier key
      const chord = chordFromEvent(e)
      const check = validateChord(chord, bindings, recordingId)
      if (!check.ok) { setError(check.reason); return }
      const id = recordingId
      setRecordingId(null)
      setError(null)
      setBinding(id, chord)
      void setShortcutOverride(id, chord).catch((err: unknown) => console.error(err))
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      setRecording(false)
    }
  }, [recordingId, bindings, setBinding])

  const startRecording = (id: ShortcutId): void => {
    setError(null)
    setRecordingId((cur) => (cur === id ? null : id)) // click the active row again to cancel
  }

  const resetOne = (id: ShortcutId): void => {
    const def = SHORTCUTS.find((s) => s.id === id)
    if (!def) return
    setError(null)
    setBinding(id, def.defaultChord)
    void setShortcutOverride(id, def.defaultChord).catch((err: unknown) => console.error(err))
  }

  const resetAll = (): void => {
    setRecordingId(null)
    setError(null)
    resetBindings()
    void resetShortcuts().catch((err: unknown) => console.error(err))
  }

  return (
    <section>
      {/* Title only — the dialog's ✕ sits at the top-right, so nothing else
          may live there. "Reset all" is a footer below the list. */}
      <h2 className="text-sm font-semibold">Shortcuts</h2>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        Click a shortcut, then press a new key combination (hold Alt, Ctrl, or Cmd).
        Some chords the browser reserves — like Ctrl+W — can’t be captured.
      </p>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      <div className="mt-4 space-y-1">
        {SHORTCUTS.map((def) => {
          const chord = bindings[def.id]
          const overridden = !chordsEqual(chord, def.defaultChord)
          const recording = recordingId === def.id
          return (
            <div key={def.id} className="flex items-center justify-between gap-3 rounded-md bg-bg px-3 py-2">
              <div className="min-w-0">
                <div className="text-xs font-medium text-text">{def.label}</div>
                <div className="truncate text-[11px] text-text-faint">{def.description}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {overridden && !recording && (
                  <button
                    onClick={() => resetOne(def.id)}
                    title="Reset to default"
                    className="rounded px-1.5 py-0.5 text-[11px] text-text-faint transition hover:text-text"
                  >
                    Reset
                  </button>
                )}
                <button
                  onClick={() => startRecording(def.id)}
                  className={clsx(
                    'min-w-[88px] rounded-md border px-2.5 py-1 text-center font-mono text-xs transition',
                    recording
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border bg-surface-2 text-text-dim hover:border-border-strong hover:text-text',
                  )}
                >
                  {recording ? 'Press…' : formatChord(chord, IS_MAC)}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <button
        onClick={resetAll}
        className="mt-4 rounded-md border border-border px-2.5 py-1 text-[11px] text-text-faint transition
          hover:border-border-strong hover:text-text"
      >
        Reset all to defaults
      </button>
    </section>
  )
}

/** A labeled settings field: small bold label, dim hint, then the control. */
function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: JSX.Element }): JSX.Element {
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
    // event.currentTarget is nulled once the handler yields, so grab it now.
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const rawPattern = form.get('pattern')
    const rawToken = form.get('token')
    const pattern = (typeof rawPattern === 'string' ? rawPattern : '').trim()
    const token = (typeof rawToken === 'string' ? rawToken : '').trim()
    if (!pattern || !token) return
    setBusy(true)
    setError(null)
    try {
      await addGitCredential(pattern, token)
      formElement.reset()
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
