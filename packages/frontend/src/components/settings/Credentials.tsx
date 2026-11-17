import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '#lib/api'
import { AUTH_LIST_KEY, useAuthList } from '#lib/useAuthList'
import { useUiStore } from '#lib/store'
import { isElectron, windowApi } from '#lib/platform'
import { BUTTON, TEXT_BUTTON } from '#components/ui/button'
import { CustomEndpoints } from '#components/settings/CustomEndpoints'
import { GitCredentials } from '#components/settings/GitCredentials'
import { Field } from '#components/settings/Field'
import { filterSuggestions, Typeahead, type TypeaheadItem } from '#components/ui/Typeahead'
import {
  CUSTOM_PROVIDER,
  OMP_DEFAULT_PROVIDER,
  OMP_PROVIDERS,
  OPENCODE_DEFAULT_PROVIDER,
  OPENCODE_PROVIDERS,
  PI_DEFAULT_PROVIDER,
  PI_PROVIDERS,
} from '@yaac/shared/tool-providers'
import { AGENT_TOOLS, type AgentTool, type CustomEndpointSummary, type LoginTool, type ToolAuthSummary, type ToolLoginView } from '@yaac/shared/types'

/**
 * Provider choices for the API-key-only tools: which backend the pasted key
 * is for, as a picker item whose value is the provider id, and the one
 * picked to begin with. Unlisted tools have no provider.
 */
const providerItem = (p: { id: string; label: string }): TypeaheadItem => ({ value: p.id, label: p.label, detail: p.id })
const PROVIDER_OPTIONS: Partial<Record<AgentTool, TypeaheadItem[]>> = {
  opencode: OPENCODE_PROVIDERS.map(providerItem),
  pi: PI_PROVIDERS.map(providerItem),
  omp: OMP_PROVIDERS.map(providerItem),
}
const DEFAULT_PROVIDER: Partial<Record<AgentTool, string>> = {
  opencode: OPENCODE_DEFAULT_PROVIDER,
  pi: PI_DEFAULT_PROVIDER,
  omp: OMP_DEFAULT_PROVIDER,
}

const INPUT = 'rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-xs text-text outline-none '
  + 'focus:border-border-strong'

/**
 * Per-tool sign-in, custom endpoints and git credentials. claude and codex
 * sign in through the vendor's browser login or a pasted API key; opencode,
 * pi and omp take a provider and an API key, or one of the user's custom
 * endpoints. Creating a workspace needs a credential for its tool, and a git
 * credential for its project.
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
          {AGENT_TOOLS.map((t) => (
            <ToolAuthRow
              key={t}
              tool={t}
              summary={auth?.toolAuth.find((a) => a.tool === t) ?? null}
              endpoints={auth?.customEndpoints ?? []}
              autoExpand={focusTool === t}
              onChanged={refresh}
            />
          ))}
        </div>
      </Field>
      <CustomEndpoints />
      <GitCredentials />
    </section>
  )
}

/** What the key-paste input asks for, per tool (and api-key tool provider). */
function apiKeyLabel(tool: AgentTool, provider: string | undefined): string {
  if (tool === 'claude') return 'Anthropic API key'
  if (tool === 'codex') return 'OpenAI API key'
  const label = PROVIDER_OPTIONS[tool]?.find((o) => o.value === provider)?.label
  return label ? `${label} API key` : 'API key'
}

/** Max provider rows rendered at once; search to reach the rest. */
const PROVIDER_VISIBLE_LIMIT = 50

/**
 * Searchable provider picker for the API-key-only tools. opencode has 150+
 * providers, so a filtered list replaces a radio row. The current pick is
 * tagged.
 */
function ProviderCombobox({ options, value, onChange }: {
  options: TypeaheadItem[]
  value: string
  onChange: (id: string) => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const hidden = filterSuggestions(options, query, Infinity).length - PROVIDER_VISIBLE_LIMIT
  return (
    <div>
      <Typeahead
        items={options}
        query={query}
        onQueryChange={setQuery}
        onSelect={onChange}
        showList
        limit={PROVIDER_VISIBLE_LIMIT}
        placeholder="Search providers…"
        ariaLabel="Provider"
        tag={(item) => item.value === value && 'selected'}
      />
      {hidden > 0 && (
        <p className="px-2 py-1 text-[10px] text-text-faint">+{hidden} more — keep typing to narrow.</p>
      )}
    </div>
  )
}

/**
 * One tool's credential row. Signed in: masked key + sign-out. Signed out:
 * a "Sign in" expander with the tool's available methods.
 */
function ToolAuthRow({ tool, summary, endpoints, autoExpand, onChanged }: {
  tool: AgentTool
  summary: ToolAuthSummary | null
  /** The user's custom endpoints, which the `custom` provider picks from. */
  endpoints: CustomEndpointSummary[]
  autoExpand: boolean
  onChanged: () => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [justSignedIn, setJustSignedIn] = useState(false)
  const providerOptions = PROVIDER_OPTIONS[tool]
  const [provider, setProvider] = useState<string>(DEFAULT_PROVIDER[tool] ?? '')
  const custom = provider === CUSTOM_PROVIDER

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
    const form = new FormData(formElement)
    const field = (name: string): string => {
      const raw = form.get(name)
      return (typeof raw === 'string' ? raw : '').trim()
    }
    const apiKey = custom ? '' : field('apiKey')
    const endpointId = custom ? field('endpointId') : undefined
    if (custom ? !endpointId : !apiKey) return
    change.mutate({
      kind: 'save',
      run: async () => {
        await api.auth[':tool'].$put({
          param: { tool },
          json: { kind: 'api-key', apiKey, ...(providerOptions ? { provider } : {}), ...(endpointId ? { endpointId } : {}) },
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
            const p = summary.opencodeProvider ?? summary.piProvider ?? summary.ompProvider
            return p ? `${p} · ` : ''
          })()}${summary.endpoint?.name ?? summary.kind}`}
        </span>
        {summary ? (
          <span className="ml-2 flex shrink-0 items-center gap-2">
            <span className="truncate font-mono text-text-faint">
              {summary.endpoint?.baseUrl ?? summary.keyPreview}
            </span>
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
              <VendorSignIn tool={tool} onDone={() => { setJustSignedIn(true); onChanged() }} />
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
          <form onSubmit={saveKey} className="flex flex-col gap-2">
            {custom && endpoints.length === 0 ? (
              <p className="text-[11px] text-text-faint">
                Add a custom endpoint under &quot;Custom endpoints&quot; below, then pick it here.
              </p>
            ) : (
              <div className="flex items-center gap-2">
                {custom ? (
                  <select name="endpointId" aria-label="Custom endpoint" className={clsx(INPUT, 'flex-1')}>
                    {endpoints.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.baseUrl})</option>)}
                  </select>
                ) : (
                  <input
                    name="apiKey"
                    type="password"
                    placeholder={apiKeyLabel(tool, provider)}
                    className={clsx(INPUT, 'flex-1')}
                  />
                )}
                <button type="submit" disabled={busy !== null} className={BUTTON}>
                  {busy === 'save' ? 'Saving…' : 'Save'}
                </button>
              </div>
            )}
          </form>
        </div>
      )}
      {change.error && <p className="mt-1.5 text-[11px] text-red-400">{change.error.message}</p>}
    </div>
  )
}

const LINK = 'break-all font-medium text-accent underline decoration-accent/40 hover:decoration-accent'

/**
 * Browser sign-in through the vendor's OAuth page, which the server runs
 * (docs/tool-sign-in.md). In the desktop app the page redirects back to its
 * auth daemon, so the page opens straight away and nothing needs pasting.
 * Anywhere else (a browser, the iPhone app) the user pastes the code
 * Claude's page shows, or enters on Codex's page the device code shown here.
 * The flow is polled every 1.5s while it runs.
 */
function VendorSignIn({ tool, onDone }: { tool: AgentTool; onDone: () => void }): JSX.Element {
  const loginTool = tool as LoginTool
  const [started, setStarted] = useState<ToolLoginView | null>(null)
  const queryClient = useQueryClient()
  const poll = useQuery({
    queryKey: ['tool-login', started?.id],
    queryFn: () => api.auth.login[':id'].$get({ param: { id: started?.id ?? '' } }),
    enabled: started?.status === 'running',
    staleTime: 0,
    // Stop once the flow ends, or once the server no longer knows it.
    refetchInterval: (q) => (q.state.status !== 'error' && q.state.data?.status !== 'success'
      && q.state.data?.status !== 'error' ? 1500 : false),
  })
  const flow = poll.isError ? null : poll.data ?? started
  const begin = useMutation({
    mutationFn: () => api.auth[':tool'].login.start.$post({
      param: { tool: loginTool },
      json: isElectron() ? { callback: 'auth-daemon' } : {},
    }),
    onSuccess: (view) => {
      setStarted(view)
      if (view.url && !view.acceptsCode && !view.userCode) windowApi()?.openExternal(view.url)
    },
    onError: (err) => setStarted({ id: '', tool: loginTool, status: 'error', error: err.message }),
  })
  // A failed abort shows beside the start button; the panel resets at once.
  const abort = useMutation({
    mutationFn: (id: string) => api.auth.login[':id'].cancel.$post({ param: { id } }),
  })
  const sendCode = useMutation({
    mutationFn: (text: string) => api.auth.login[':id'].input.$post({ param: { id: flow?.id ?? '' }, json: { text } }),
    onSuccess: (view) => queryClient.setQueryData(['tool-login', view.id], view),
  })
  const reset = (): void => {
    if (flow?.status === 'running') abort.mutate(flow.id)
    sendCode.reset()
    setStarted(null)
  }

  // Closing the panel abandons a running flow, so the server stops on it
  // rather than waiting out its timeout.
  const liveRef = useRef<string | null>(null)
  liveRef.current = flow?.status === 'running' && flow.id ? flow.id : null
  useEffect(() => () => {
    if (liveRef.current) void api.auth.login[':id'].cancel.$post({ param: { id: liveRef.current } }).catch(() => {})
  }, [])

  // `onDone` is a new closure each render; fire it only once per success.
  const doneRef = useRef(false)
  const succeeded = flow?.status === 'success'
  useEffect(() => {
    if (!succeeded || doneRef.current) return
    doneRef.current = true
    onDone()
  }, [succeeded, onDone])

  if (!flow) {
    return (
      <div className="flex flex-col gap-1">
        <button
          onClick={() => { doneRef.current = false; begin.mutate() }}
          disabled={begin.isPending}
          className={BUTTON}
        >
          {begin.isPending ? 'Starting…' : tool === 'claude' ? 'Sign in with Claude' : 'Sign in with ChatGPT'}
        </button>
        {abort.error && <p className="text-[11px] text-red-400">Cancel failed: {abort.error.message}</p>}
      </div>
    )
  }

  if (flow.status === 'error') {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-[11px] text-red-400">{flow.error ?? 'sign-in failed'}</p>
        <button onClick={reset} className={BUTTON}>
          Try again
        </button>
      </div>
    )
  }

  // The server refuses a code with unexpected characters before spending
  // it, so the user can paste again.
  const submitCode = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const formElement = event.currentTarget
    const raw = new FormData(formElement).get('text')
    const text = (typeof raw === 'string' ? raw : '').trim()
    if (!text) return
    sendCode.mutate(text, { onSuccess: () => formElement.reset() })
  }
  const link = (text: string): JSX.Element => (
    <a href={flow.url} target="_blank" rel="noreferrer" className={LINK}>{text}</a>
  )

  return (
    <div className="flex flex-col gap-2 rounded-md border border-accent/20 bg-accent/5 p-2.5">
      <div className="flex items-start gap-2.5">
        <p className="flex-1 text-[11px] leading-relaxed text-text-dim">
          {flow.userCode ? (
            <>Open {link('the ChatGPT sign-in page')}, sign in, and enter this code:</>
          ) : flow.acceptsCode ? (
            <>Open {link('the Claude sign-in page')}, approve, then paste the code it shows below.</>
          ) : (
            <>Finish signing in in your browser. No window? {link('Open the sign-in page')}.</>
          )}
        </p>
        <button onClick={reset} className={BUTTON}>
          Cancel
        </button>
      </div>
      {flow.userCode && (
        <p className="select-all text-center font-mono text-base tracking-widest text-text">{flow.userCode}</p>
      )}
      {flow.acceptsCode && (
        <>
          <form onSubmit={submitCode} className="flex items-center gap-2">
            <input
              name="text"
              autoComplete="off"
              placeholder="paste the code here"
              className={clsx(INPUT, 'min-w-0 flex-1')}
            />
            <button type="submit" disabled={sendCode.isPending} className={BUTTON}>
              {sendCode.isPending ? 'Signing in…' : 'Send'}
            </button>
          </form>
          {sendCode.error && <p className="text-[11px] text-red-400">{sendCode.error.message}</p>}
        </>
      )}
    </div>
  )
}
