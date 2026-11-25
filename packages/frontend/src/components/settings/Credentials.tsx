import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '#lib/api'
import { AUTH_LIST_KEY, useAuthList } from '#lib/useAuthList'
import { TOOL_LABEL } from '#lib/icons'
import { useUiStore } from '#lib/store'
import { useSnapshotSelect } from '#lib/useSnapshot'
import { isElectron, windowApi } from '#lib/platform'
import { CustomEndpoints } from '#components/settings/CustomEndpoints'
import { GitCredentials } from '#components/settings/GitCredentials'
import { Tokens } from '#components/settings/Tokens'
import { SettingsPageTitle } from '#components/settings/SettingsPage'
import {
  CUSTOM_PROVIDER,
  OMP_DEFAULT_PROVIDER,
  OMP_PROVIDERS,
  OPENCODE_DEFAULT_PROVIDER,
  OPENCODE_PROVIDERS,
  PI_DEFAULT_PROVIDER,
  PI_PROVIDERS,
} from '@yaac/shared/tool-providers'
import {
  filterSuggestions, YButton, YCallout, YInput, YRowFrame, YSection, YSelect, YSettingGroup, YTypeahead, type YTypeaheadItem,
} from '#ui'
import { AGENT_TOOLS, type AgentTool, type CustomEndpointSummary, type LoginTool, type ToolAuthSummary, type ToolLoginView } from '@yaac/shared/types'

/**
 * Provider choices for the API-key-only tools: which backend the pasted key
 * is for, as a picker item whose value is the provider id, and the one
 * picked to begin with. Unlisted tools have no provider.
 */
const providerItem = (p: { id: string; label: string }): YTypeaheadItem => ({ value: p.id, label: p.label, detail: p.id })
const PROVIDER_OPTIONS: Partial<Record<AgentTool, YTypeaheadItem[]>> = {
  opencode: OPENCODE_PROVIDERS.map(providerItem),
  pi: PI_PROVIDERS.map(providerItem),
  omp: OMP_PROVIDERS.map(providerItem),
}
const DEFAULT_PROVIDER: Partial<Record<AgentTool, string>> = {
  opencode: OPENCODE_DEFAULT_PROVIDER,
  pi: PI_DEFAULT_PROVIDER,
  omp: OMP_DEFAULT_PROVIDER,
}

/**
 * Per-tool sign-in, custom endpoints, git credentials and token bindings. claude and codex
 * sign in through the vendor's browser login or a pasted API key; opencode,
 * pi and omp take a provider and an API key, or one of the user's custom
 * endpoints. Creating a workspace needs a credential for its tool, and a git
 * credential for its project.
 */
export function CredentialsPane(): JSX.Element {
  const auth = useAuthList()
  const focusTool = useUiStore((s) => s.settingsFocusTool)
  const containerless = useSnapshotSelect((s) => s?.driver) === 'containerless'
  const queryClient = useQueryClient()
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: AUTH_LIST_KEY })
  }

  return (
    <>
      <SettingsPageTitle title="Credentials" />
      {containerless && (
        <YCallout title="This server runs workspaces directly on the host">
          Workspaces use these credentials as they are: an agent can read the real keys and tokens, not placeholders.
        </YCallout>
      )}
      <YSection
        title="Agent tools"
        description={containerless
          ? 'Sign in to create workspaces with a tool.'
          : 'Sign in to create workspaces with a tool. Workspaces only ever see placeholders.'}
      >
        <YSettingGroup>
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
        </YSettingGroup>
      </YSection>
      <CustomEndpoints />
      <GitCredentials />
      <Tokens />
    </>
  )
}

/** How a tool is signed in, in words: "OAuth", "OpenRouter API key", or
 *  the custom endpoint it uses. */
function signInText(tool: AgentTool, summary: ToolAuthSummary): string {
  if (summary.endpoint) return `${summary.endpoint.name} endpoint`
  if (summary.kind === 'oauth') return 'OAuth'
  const provider = summary.opencodeProvider ?? summary.piProvider ?? summary.ompProvider
  return provider ? apiKeyLabel(tool, provider) : 'API key'
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
  options: YTypeaheadItem[]
  value: string
  onChange: (id: string) => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const hidden = filterSuggestions(options, query, Infinity).length - PROVIDER_VISIBLE_LIMIT
  return (
    <div>
      <YTypeahead
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
        <p className="px-2 py-1 text-xs text-subtle">+{hidden} more — keep typing to narrow.</p>
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
    <div data-tool={tool} className="px-4 py-2 text-md">
      <YRowFrame
        label={tool}
        actionsShown
        actions={summary ? (
          <YButton
            variant="danger"
            size="sm"
            onClick={() => change.mutate({
              kind: 'signout',
              run: () => api.auth.clear.$post({ json: { service: tool } }),
            })}
            disabled={busy !== null}
          >
            {busy === 'signout' ? 'Signing out…' : 'Sign out'}
          </YButton>
        ) : (
          <YButton size="sm" onClick={() => { change.reset(); setExpanded((e) => !e) }}>
            Sign in
          </YButton>
        )}
        className="min-h-8"
      >
        <span className="w-24 shrink-0 font-medium text-text">{TOOL_LABEL[tool]}</span>
        <span className="min-w-0 flex-1 truncate text-muted">{summary ? signInText(tool, summary) : 'Not signed in'}</span>
        {summary && (
          <span className="truncate pr-2 font-mono text-sm text-subtle">{summary.endpoint?.baseUrl ?? summary.keyPreview}</span>
        )}
      </YRowFrame>

      {justSignedIn && (
        <p className="mb-1 text-sm text-success">Signed in successfully.</p>
      )}

      {!summary && expanded && (
        <div className="mt-1.5 mb-1 flex flex-col gap-2 border-t border-line pt-2.5">
          {!providerOptions && (
            <>
              <VendorSignIn tool={tool} onDone={() => { setJustSignedIn(true); onChanged() }} />
              <p className="text-sm text-subtle">
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
              <p className="text-sm text-subtle">
                Add a custom endpoint under &quot;Custom endpoints&quot; below, then pick it here.
              </p>
            ) : (
              <div className="flex items-center gap-2">
                {custom ? (
                  <YSelect name="endpointId" aria-label="Custom endpoint" className="flex-1 font-mono">
                    {endpoints.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.baseUrl})</option>)}
                  </YSelect>
                ) : (
                  <YInput
                    name="apiKey"
                    type="password"
                    placeholder={apiKeyLabel(tool, provider)}
                    className="flex-1 font-mono"
                  />
                )}
                <YButton size="sm" type="submit" disabled={busy !== null}>
                  {busy === 'save' ? 'Saving…' : 'Save'}
                </YButton>
              </div>
            )}
          </form>
        </div>
      )}
      {change.error && <p className="mb-1 text-sm text-danger">{change.error.message}</p>}
    </div>
  )
}

const LINK = 'break-all font-medium text-info underline underline-offset-2'

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
        <YButton
          size="sm"
          onClick={() => { doneRef.current = false; begin.mutate() }}
          disabled={begin.isPending}
          className="self-start"
        >
          {begin.isPending ? 'Starting…' : tool === 'claude' ? 'Sign in with Claude' : 'Sign in with ChatGPT'}
        </YButton>
        {abort.error && <p className="text-sm text-danger">Cancel failed: {abort.error.message}</p>}
      </div>
    )
  }

  if (flow.status === 'error') {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-sm text-danger">{flow.error ?? 'sign-in failed'}</p>
        <YButton size="sm" onClick={reset} className="self-start">
          Try again
        </YButton>
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
    <div className="flex flex-col gap-2 bg-info-soft p-2.5">
      <div className="flex items-start gap-2.5">
        <p className="flex-1 text-sm leading-relaxed text-muted">
          {flow.userCode ? (
            <>Open {link('the ChatGPT sign-in page')}, sign in, and enter this code:</>
          ) : flow.acceptsCode ? (
            <>Open {link('the Claude sign-in page')}, approve, then paste the code it shows below.</>
          ) : (
            <>Finish signing in in your browser. No window? {link('Open the sign-in page')}.</>
          )}
        </p>
        <YButton variant="ghost" size="sm" onClick={reset}>
          Cancel
        </YButton>
      </div>
      {flow.userCode && (
        <p className="select-all text-center font-mono text-lg tracking-widest text-text">{flow.userCode}</p>
      )}
      {flow.acceptsCode && (
        <>
          <form onSubmit={submitCode} className="flex items-center gap-2">
            <YInput
              name="text"
              autoComplete="off"
              placeholder="paste the code here"
              className="flex-1 font-mono"
            />
            <YButton size="sm" type="submit" disabled={sendCode.isPending}>
              {sendCode.isPending ? 'Signing in…' : 'Send'}
            </YButton>
          </form>
          {sendCode.error && <p className="text-sm text-danger">{sendCode.error.message}</p>}
        </>
      )}
    </div>
  )
}
