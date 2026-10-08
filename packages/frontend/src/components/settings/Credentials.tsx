import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '#lib/api'
import { AUTH_LIST_KEY, useAuthList } from '#lib/useAuthList'
import { useUiStore } from '#lib/store'
import { BUTTON, TEXT_BUTTON } from '#components/ui/button'
import { GitCredentials } from '#components/settings/GitCredentials'
import { Field } from '#components/settings/Field'
import { OPENCODE_PROVIDERS, PI_PROVIDERS } from '@yaac/shared/tool-providers'
import { TOOL_LABELS, type AgentTool, type ToolAuthSummary, type ToolInstallView, type ToolLoginView } from '@yaac/shared/types'

const TOOLS: AgentTool[] = ['claude', 'codex', 'opencode', 'pi']

/**
 * Provider choices for the API-key-only tools: which backend the pasted key
 * is for. The first entry is the default. Unlisted tools have no provider.
 */
interface ProviderOption { id: string; label: string }
const PROVIDER_OPTIONS: Partial<Record<AgentTool, ProviderOption[]>> = {
  opencode: OPENCODE_PROVIDERS.map((p) => ({ id: p.id, label: p.label })),
  pi: PI_PROVIDERS.map((p) => ({ id: p.id, label: p.label })),
}

/**
 * Per-tool sign-in plus git credentials. claude and codex sign in through the
 * vendor's browser login or a pasted API key; opencode and pi take a provider
 * and an API key. Creating a workspace needs a credential for its tool, and a
 * git credential for its project.
 */
export function CredentialsPane(): JSX.Element {
  const auth = useAuthList()
  const focusTool = useUiStore((s) => s.settingsFocusTool)
  const queryClient = useQueryClient()
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: AUTH_LIST_KEY })
  }

  return (
    <section>
      <h2 className="text-sm font-semibold">Credentials</h2>
      <Field label="Agent tools" hint="Sign in to create workspaces with a tool. Keys stay on this machine — containers only ever see placeholders.">
        <div className="space-y-2 text-xs">
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
      <GitCredentials />
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

/** Max provider rows rendered at once; search to reach the rest. */
const PROVIDER_VISIBLE_LIMIT = 50

/**
 * Searchable provider picker for the API-key-only tools. opencode has 150+
 * providers, so a filtered list replaces a radio row. The value is the
 * provider id.
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
  const [justSignedIn, setJustSignedIn] = useState(false)
  const providerOptions = PROVIDER_OPTIONS[tool]
  const [provider, setProvider] = useState<string>(providerOptions?.[0].id ?? 'openrouter')

  // Opened from a "Sign in" link elsewhere: start with this tool's form open.
  useEffect(() => {
    if (autoExpand && !summary) setExpanded(true)
  }, [autoExpand, summary])

  const change = useMutation({
    mutationFn: (op: { kind: 'save' | 'signout'; run: () => Promise<unknown> }) => op.run(),
    onSuccess: (_, op) => {
      setExpanded(false)
      setJustSignedIn(op.kind === 'save') // sign-out clears a stale confirmation
      onChanged()
    },
  })
  const busy = change.isPending ? change.variables.kind : null

  const saveKey = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const formElement = event.currentTarget
    const raw = new FormData(formElement).get('apiKey')
    const apiKey = (typeof raw === 'string' ? raw : '').trim()
    if (!apiKey) return
    change.mutate({
      kind: 'save',
      run: async () => {
        await api.auth[':tool'].$put({
          param: { tool },
          json: { kind: 'api-key', apiKey, ...(providerOptions ? { provider } : {}) },
        })
        formElement.reset()
      },
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
              onClick={() => change.mutate({
                kind: 'signout',
                run: () => api.auth.clear.$post({ json: { service: tool } }),
              })}
              disabled={busy !== null}
              className={TEXT_BUTTON}
            >
              {busy === 'signout' ? 'Signing out…' : 'Sign out'}
            </button>
          </span>
        ) : (
          <button onClick={() => { change.reset(); setExpanded((e) => !e) }} className={clsx(BUTTON, 'ml-2')}>
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
          <form onSubmit={saveKey} className="flex items-center gap-2">
            <input
              name="apiKey"
              type="password"
              placeholder={apiKeyLabel(tool, provider)}
              className="flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-xs
                text-text outline-none focus:border-border-strong"
            />
            <button type="submit" disabled={busy !== null} className={BUTTON}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
          </form>
        </div>
      )}
      {change.error && <p className="mt-1.5 text-[11px] text-red-400">{change.error.message}</p>}
    </div>
  )
}

type FlowView = ToolLoginView | ToolInstallView

/**
 * A command the server runs for a tool (its sign-in or its install), polled
 * every 1.5s while it runs. `flow` is null until started. Starting one that
 * fails to start yields an error view with no id. A flow the server no
 * longer knows (restart, expiry) resets to null.
 */
function useCliFlow(kind: 'login' | 'install', tool: AgentTool, start: () => Promise<FlowView>) {
  const [started, setStarted] = useState<FlowView | null>(null)
  const queryClient = useQueryClient()
  const poll = useQuery({
    queryKey: ['cli-flow', kind, started?.id],
    queryFn: () => (kind === 'login'
      ? api.auth.login[':id'].$get({ param: { id: started?.id ?? '' } })
      : api.auth.install[':id'].$get({ param: { id: started?.id ?? '' } })),
    enabled: started?.status === 'running',
    staleTime: 0,
    // Stop once the flow ends, or once the server no longer knows it.
    refetchInterval: (q) => (q.state.status !== 'error' && q.state.data?.status !== 'success'
      && q.state.data?.status !== 'error' ? 1500 : false),
  })
  const flow = poll.isError ? null : poll.data ?? started
  const begin = useMutation({
    mutationFn: start,
    onSuccess: setStarted,
    onError: (err) => setStarted({ id: '', tool, status: 'error', error: err.message }),
  })
  // Aborting a running flow; the panel resets at once, and a failed abort
  // shows beside the start button.
  const abort = useMutation({
    mutationFn: (id: string) => (kind === 'login'
      ? api.auth.login[':id'].cancel.$post({ param: { id } })
      : api.auth.install[':id'].cancel.$post({ param: { id } })),
  })
  const reset = (): void => {
    if (flow?.status === 'running') abort.mutate(flow.id)
    setStarted(null)
  }
  /** Replace the polled view, e.g. with an input's reply. */
  const replace = (view: FlowView): void => {
    queryClient.setQueryData(['cli-flow', kind, view.id], view)
  }
  return { flow, begin, abort, reset, replace, clear: () => setStarted(null) }
}

/**
 * Browser sign-in: the server runs the vendor's login command
 * (`claude auth login` / `codex login`), which opens a browser and completes
 * through its localhost callback. A missing CLI can be installed from here.
 */
function CliSignIn({ tool, onDone }: { tool: AgentTool; onDone: () => void }): JSX.Element {
  const cliTool = tool as 'claude' | 'codex'
  const login = useCliFlow('login', tool, () => api.auth[':tool'].login.start.$post({ param: { tool: cliTool } }))
  const install = useCliFlow('install', tool, () => api.auth[':tool'].install.start.$post({ param: { tool: cliTool } }))
  const [justInstalled, setJustInstalled] = useState(false)
  const sendInput = useMutation({
    mutationFn: (text: string) => api.auth.login[':id'].input.$post({ param: { id: login.flow?.id ?? '' }, json: { text } }),
    onSuccess: login.replace,
  })
  const label = tool === 'claude' ? 'Sign in with Claude' : 'Sign in with ChatGPT'
  const toolName = TOOL_LABELS[tool]
  const busy = login.begin.isPending || install.begin.isPending

  // `onDone` is a new closure each render; fire it only once per success.
  const doneRef = useRef(false)
  const succeeded = login.flow?.status === 'success'
  useEffect(() => {
    if (!succeeded || doneRef.current) return
    doneRef.current = true
    onDone()
  }, [succeeded, onDone])

  // A finished install returns to the start button with a "try again" nudge.
  const installed = install.flow?.status === 'success'
  const { clear: clearInstall } = install
  const { clear: clearLogin } = login
  useEffect(() => {
    if (!installed) return
    clearInstall()
    clearLogin()
    setJustInstalled(true)
  }, [installed, clearInstall, clearLogin])

  const start = (): void => {
    doneRef.current = false
    login.begin.mutate()
  }
  const installCli = (): void => {
    login.clear()
    install.begin.mutate()
  }

  const abortError = login.abort.error ?? install.abort.error

  if (install.flow) {
    if (install.flow.status === 'error') {
      return (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] text-red-400">{install.flow.error ?? 'install failed'}</p>
          <div className="flex gap-2">
            <button onClick={installCli} className={BUTTON}>
              Try again
            </button>
            <button onClick={install.reset} className={BUTTON}>
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
          <button onClick={install.reset} className={BUTTON}>
            Cancel
          </button>
        </div>
        {install.flow.output && <CliOutput text={install.flow.output} />}
      </div>
    )
  }

  if (!login.flow) {
    return (
      <div className="flex flex-col gap-1">
        {justInstalled && (
          <p className="text-[11px] text-emerald-400">{toolName} installed — try signing in again.</p>
        )}
        <button onClick={start} disabled={busy} className={BUTTON}>
          {busy ? 'Starting…' : label}
        </button>
        <p className="text-[11px] text-text-faint">
          Opens a browser window on this machine to authorize. Needs the yaac
          desktop app running here; without it, run <code>yaac auth update</code> in
          a terminal.
        </p>
        {abortError && <p className="text-[11px] text-red-400">Cancel failed: {abortError.message}</p>}
      </div>
    )
  }

  if (login.flow.status === 'error') {
    if ('cliMissing' in login.flow && login.flow.cliMissing) {
      return (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] text-text-dim">{toolName} isn't installed on this machine.</p>
          <div className="flex gap-2">
            <button onClick={installCli} disabled={busy} className={BUTTON}>
              {busy ? 'Starting…' : `Install ${toolName}`}
            </button>
            <button onClick={login.reset} className={BUTTON}>
              Cancel
            </button>
          </div>
        </div>
      )
    }
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-[11px] text-red-400">{login.flow.error ?? 'sign-in failed'}</p>
        <button onClick={login.reset} className={BUTTON}>
          Try again
        </button>
      </div>
    )
  }

  // The server rejects codes with unexpected characters; the flow stays open
  // so the user can paste again.
  const submitInput = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const formElement = event.currentTarget
    const raw = new FormData(formElement).get('text')
    const text = (typeof raw === 'string' ? raw : '').trim()
    if (!text) return
    sendInput.mutate(text, { onSuccess: () => formElement.reset() })
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-accent/20 bg-accent/5 p-2.5">
      <div className="flex items-center gap-2.5">
        <p className="flex-1 text-[11px] leading-relaxed text-text-dim">
          Finish signing in from the browser window that just opened. No window? Use
          the sign-in link the CLI printed below.
        </p>
        <button onClick={login.reset} className={BUTTON}>
          Cancel
        </button>
      </div>
      {login.flow.output && <CliOutput text={login.flow.output} />}
      {tool === 'claude' && (
        <>
          <form onSubmit={submitInput} className="flex items-center gap-2">
            <input
              name="text"
              autoComplete="off"
              placeholder="paste code here if prompted"
              className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono
                text-xs text-text outline-none focus:border-border-strong"
            />
            <button type="submit" className={BUTTON}>
              Send
            </button>
          </form>
          {sendInput.error && <p className="text-[11px] text-red-400">{sendInput.error.message}</p>}
        </>
      )}
    </div>
  )
}

const URL_RE = /https:\/\/[^\s"'<>]+/g

/**
 * The login command's live output with clickable URLs, for when the server
 * could not open a browser itself.
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
