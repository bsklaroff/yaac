import { useState, type FormEvent, type JSX } from 'react'
import clsx from 'clsx'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '#lib/api'
import { AUTH_LIST_KEY, useAuthList } from '#lib/useAuthList'
import { AffectsBanner } from '#components/settings/AffectsBanner'
import { Field } from '#components/settings/Field'
import { BUTTON, TEXT_BUTTON } from '#components/ui/button'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import {
  applyEndpointDiff,
  describeEndpointModel,
  diffEndpointModels,
  emptyDiff,
  parseEndpointModels,
  type EndpointModelsDiff,
} from '@yaac/shared/endpoint-models'
import { API_KEY_TOOLS, CUSTOM_PROVIDER, type ApiKeyTool, type EndpointModel } from '@yaac/shared/tool-providers'
import type { CustomEndpointSummary, EndpointDiscovery, ToolAuthSummary } from '@yaac/shared/types'

const INPUT = 'rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-xs text-text outline-none '
  + 'focus:border-border-strong'

/**
 * The user's custom endpoints (docs/custom-endpoints.md): self-hosted
 * OpenAI-compatible servers, each attachable to opencode, pi and omp, which
 * then sign in with it in place of their own provider. The model list is
 * fetched from the endpoint's `/models`, edited as JSON, and re-fetched on
 * request with a review of what changed.
 */
export function CustomEndpoints(): JSX.Element {
  const auth = useAuthList()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<string | null>(null) // an endpoint id, or 'new'
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: AUTH_LIST_KEY })
  const endpoints = auth?.customEndpoints ?? []

  return (
    <Field
      label="Custom endpoints"
      hint="Self-hosted OpenAI-compatible servers (vLLM, Ollama, llama.cpp, llama-swap…) that opencode, pi and omp can sign in with. On a cluster, add the endpoint's host to each project's allowlist; a key is only sent over https there."
    >
      <div className="space-y-2 text-xs">
        {endpoints.map((e) => (
          <EndpointCard
            key={e.id}
            endpoint={e}
            toolAuth={auth?.toolAuth ?? []}
            editing={editing === e.id}
            onEdit={() => setEditing((id) => (id === e.id ? null : e.id))}
            onDone={() => { setEditing(null); void refresh() }}
            onChanged={() => void refresh()}
          />
        ))}
        {editing === 'new' ? (
          <div className="rounded-md bg-bg px-2.5 py-2">
            <EndpointEditor onDone={() => { setEditing(null); void refresh() }} onCancel={() => setEditing(null)} />
          </div>
        ) : (
          <button type="button" onClick={() => setEditing('new')} className={BUTTON}>
            Add custom endpoint
          </button>
        )}
      </div>
    </Field>
  )
}

/** The provider a tool is signed in with, for the replace confirmation. */
function providerOf(s: ToolAuthSummary): string | undefined {
  return s.opencodeProvider ?? s.piProvider ?? s.ompProvider
}

/** One endpoint: its URL and key, the tools it serves (each a toggle), its
 *  models, and Edit and Delete. */
function EndpointCard({ endpoint: e, toolAuth, editing, onEdit, onDone, onChanged }: {
  endpoint: CustomEndpointSummary
  toolAuth: ToolAuthSummary[]
  editing: boolean
  onEdit: () => void
  onDone: () => void
  onChanged: () => void
}): JSX.Element {
  // A toggle or delete waiting on its confirmation.
  const [confirm, setConfirm] = useState<{ kind: 'attach' | 'detach'; tool: ApiKeyTool } | { kind: 'delete' } | null>(null)
  const change = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: onChanged,
    onSettled: () => setConfirm(null),
  })
  const attach = (tool: ApiKeyTool): void => change.mutate(() => api.auth[':tool'].$put({
    param: { tool },
    json: { kind: 'api-key', apiKey: '', provider: CUSTOM_PROVIDER, endpointId: e.id },
  }))
  const detach = (tool: ApiKeyTool): void => change.mutate(() => api.auth.clear.$post({ json: { service: tool } }))
  const toggle = (tool: ApiKeyTool): void => {
    if (e.tools.includes(tool)) setConfirm({ kind: 'detach', tool })
    else if (toolAuth.some((s) => s.tool === tool)) setConfirm({ kind: 'attach', tool })
    else attach(tool)
  }
  const replacing = confirm?.kind === 'attach' ? toolAuth.find((s) => s.tool === confirm.tool) : undefined

  return (
    <div data-endpoint={e.id} className="flex flex-col gap-1.5 rounded-md bg-bg px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <span className="truncate font-medium text-text">{e.name}</span>
        <span className="truncate font-mono text-text-faint">{[e.baseUrl, e.keyPreview].filter(Boolean).join(' · ')}</span>
        <span className="ml-auto flex shrink-0">
          <button type="button" onClick={onEdit} className={TEXT_BUTTON}>{editing ? 'Close' : 'Edit'}</button>
          <button type="button" onClick={() => setConfirm({ kind: 'delete' })} className={TEXT_BUTTON}>Delete</button>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-text-faint">Used by</span>
        {API_KEY_TOOLS.map((tool) => (
          <button
            key={tool}
            type="button"
            role="switch"
            aria-checked={e.tools.includes(tool)}
            aria-label={tool}
            disabled={change.isPending}
            onClick={() => toggle(tool)}
            className={clsx(
              'rounded-full border px-2 py-0.5 font-mono text-[11px]',
              e.tools.includes(tool) ? 'border-accent/40 bg-accent/10 text-text' : 'border-border text-text-faint',
            )}
          >
            {tool}
          </button>
        ))}
      </div>
      <p className="font-mono text-[11px] leading-relaxed text-text-dim">
        {e.models.map(describeEndpointModel).join(', ')}
      </p>
      {editing && <EndpointEditor endpoint={e} onDone={onDone} onCancel={onEdit} />}
      {change.error && <p className="text-[11px] text-red-400">{change.error.message}</p>}
      <ConfirmDialog
        open={confirm?.kind === 'attach'}
        onOpenChange={(open) => { if (!open) setConfirm(null) }}
        title={`Use ${e.name} for ${confirm?.kind === 'attach' ? confirm.tool : ''}?`}
        description={`This replaces its ${replacing && providerOf(replacing) ? `${providerOf(replacing)} ` : ''}sign-in.`}
        confirmLabel="Replace"
        busy={change.isPending}
        onConfirm={() => { if (confirm?.kind === 'attach') attach(confirm.tool) }}
      />
      <ConfirmDialog
        open={confirm?.kind === 'detach'}
        onOpenChange={(open) => { if (!open) setConfirm(null) }}
        title={`Sign ${confirm?.kind === 'detach' ? confirm.tool : ''} out?`}
        description={`It stops using ${e.name}, and cannot create workspaces until signed in again.`}
        confirmLabel="Sign out"
        busy={change.isPending}
        onConfirm={() => { if (confirm?.kind === 'detach') detach(confirm.tool) }}
      />
      <ConfirmDialog
        open={confirm?.kind === 'delete'}
        onOpenChange={(open) => { if (!open) setConfirm(null) }}
        title={`Delete ${e.name}?`}
        description={e.tools.length === 0 ? 'No tool uses it.'
          : `${e.tools.join(', ')} will be signed out, and cannot create workspaces until signed in again.`}
        busy={change.isPending}
        requireClick
        onConfirm={() => change.mutate(async () => {
          await api.auth.endpoints[':id'].$delete({ param: { id: e.id } })
          onDone()
        })}
      />
    </div>
  )
}

const pretty = (models: EndpointModel[]): string => JSON.stringify(models, null, 2)

/** A URL's host, or the text itself while it is not yet a URL. */
function hostOf(url: string): string {
  try {
    return new URL(url.trim()).hostname
  } catch {
    return url
  }
}

/**
 * Add an endpoint, or edit one. The models are JSON, checked as the server
 * will on every keystroke. An empty list is filled from the endpoint's
 * `/models`; fetching over one that has models shows what differs instead
 * of replacing them, since they may have been edited by hand.
 */
function EndpointEditor({ endpoint, onDone, onCancel }: {
  endpoint?: CustomEndpointSummary
  onDone: () => void
  onCancel: () => void
}): JSX.Element {
  const [name, setName] = useState(endpoint?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(endpoint?.baseUrl ?? '')
  // Blank keeps the stored key when editing.
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [modelsText, setModelsText] = useState(endpoint ? pretty(endpoint.models) : '')
  // The last fetch, numbered so each one's review starts from its own picks.
  const [discovery, setDiscovery] = useState<{ n: number; found: EndpointDiscovery; diff?: EndpointModelsDiff } | null>(null)

  let parsedJson: unknown
  let jsonError: string | null = null
  try {
    parsedJson = modelsText.trim() === '' ? undefined : JSON.parse(modelsText)
  } catch (err) {
    jsonError = err instanceof Error ? err.message : String(err)
  }
  const checked = parsedJson === undefined ? null : parseEndpointModels(parsedJson)
  const models = checked?.ok === true ? checked.value : null
  const problems = jsonError !== null ? [jsonError] : checked?.ok === false ? checked.errors : []
  // An empty list is filled from the endpoint; any other is compared with
  // it, which needs it to parse, so nothing typed is ever overwritten.
  const blank = modelsText.trim() === ''

  const fetchModels = useMutation({
    mutationFn: () => {
      // A stored endpoint is asked with its own URL and key unless the form
      // changes them.
      const asStored = endpoint !== undefined && baseUrl.trim() === endpoint.baseUrl && apiKey.trim() === '' && !clearKey
      return api.auth.endpoints.discover.$post({
        json: asStored ? { endpointId: endpoint.id } : { baseUrl: baseUrl.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) },
      })
    },
    onSuccess: (found) => {
      const n = (discovery?.n ?? 0) + 1
      if (blank || models === null) {
        if (blank) setModelsText(pretty(found.models))
        setDiscovery({ n, found })
      } else {
        setDiscovery({ n, found, diff: diffEndpointModels(models, found.models) })
      }
    },
  })
  const save = useMutation({
    mutationFn: async (list: EndpointModel[]) => {
      if (endpoint === undefined) {
        await api.auth.endpoints.$post({
          json: { name: name.trim(), baseUrl: baseUrl.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), models: list },
        })
      } else {
        await api.auth.endpoints[':id'].$patch({
          param: { id: endpoint.id },
          json: {
            ...(name.trim() !== endpoint.name ? { name: name.trim() } : {}),
            ...(baseUrl.trim() !== endpoint.baseUrl ? { baseUrl: baseUrl.trim() } : {}),
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : clearKey ? { apiKey: '' } : {}),
            models: list,
          },
        })
      }
    },
    onSuccess: onDone,
  })
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (models !== null && name.trim() !== '' && baseUrl.trim() !== '') save.mutate(models)
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 border-t border-hairline-soft pt-2">
      {endpoint && (
        <AffectsBanner
          lead="Used by"
          names={endpoint.tools}
          none="No tool uses this endpoint yet."
          note="Saving updates their model lists for agents started from now on; running ones keep theirs until restarted."
        />
      )}
      <div className="flex gap-2">
        <input aria-label="Endpoint name" value={name} onChange={(ev) => setName(ev.target.value)} placeholder="Name, e.g. my-llama" className={clsx(INPUT, 'w-40')} />
        <input
          aria-label="Endpoint URL"
          value={baseUrl}
          onChange={(ev) => setBaseUrl(ev.target.value)}
          onBlur={() => { if (endpoint === undefined && blank && baseUrl.trim() !== '') fetchModels.mutate() }}
          placeholder="Endpoint URL, e.g. http://my-box:8080/v1"
          className={clsx(INPUT, 'min-w-0 flex-1')}
        />
      </div>
      <div className="flex items-center gap-2">
        <input
          aria-label="Endpoint API key"
          type="password"
          value={apiKey}
          onChange={(ev) => { setApiKey(ev.target.value); setClearKey(false) }}
          placeholder={endpoint?.keyPreview && !clearKey ? `API key (keep ${endpoint.keyPreview})` : 'API key (optional)'}
          className={clsx(INPUT, 'min-w-0 flex-1')}
        />
        {endpoint?.keyPreview && !clearKey && (
          <button type="button" onClick={() => { setClearKey(true); setApiKey('') }} className={TEXT_BUTTON}>Remove key</button>
        )}
        <button
          type="button"
          disabled={baseUrl.trim() === '' || fetchModels.isPending || (!blank && models === null)}
          title={!blank && models === null ? 'Fix the models JSON first, so the fetched list can be compared with it' : undefined}
          onClick={() => fetchModels.mutate()}
          className={BUTTON}
        >
          {fetchModels.isPending ? 'Fetching…' : endpoint ? 'Re-fetch from endpoint' : 'Fetch models'}
        </button>
      </div>
      {endpoint?.keyPreview && !clearKey && apiKey.trim() === '' && hostOf(baseUrl) !== hostOf(endpoint.baseUrl) && (
        <p className="text-[11px] text-amber-400">The stored key is removed when the host changes; enter it again to keep one.</p>
      )}
      {fetchModels.error && <p className="text-[11px] text-red-400">{fetchModels.error.message}</p>}
      {discovery?.diff && (
        <DiffPanel
          key={discovery.n}
          diff={discovery.diff}
          canApply={models !== null}
          onApply={(pick) => {
            if (models === null || !discovery.diff) return
            setModelsText(pretty(applyEndpointDiff(models, discovery.diff, pick)))
            setDiscovery(null)
          }}
          onReplace={() => { setModelsText(pretty(discovery.found.models)); setDiscovery(null) }}
          onDismiss={() => setDiscovery(null)}
        />
      )}
      <textarea
        aria-label="Models (JSON)"
        value={modelsText}
        onChange={(ev) => setModelsText(ev.target.value)}
        placeholder={'[{ "id": "my-model", "efforts": { "levels": ["low", "medium", "high"], "default": "medium" } }]'}
        rows={Math.min(16, Math.max(4, modelsText.split('\n').length))}
        spellCheck={false}
        className={clsx(INPUT, 'resize-y leading-relaxed')}
      />
      {problems.length > 0 && (
        <ul className="text-[11px] text-red-400">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
      )}
      {discovery && discovery.found.skipped.length > 0 && (
        <p className="text-[11px] text-text-faint">
          Left out: {discovery.found.skipped.map((s) => `${s.id} (${s.reason})`).join(', ')}
        </p>
      )}
      <p className="text-[11px] text-text-faint">
        Each model is an id, an optional name, and its reasoning levels (none minimal low medium high xhigh max) with a default.
      </p>
      <div className="flex gap-2">
        <button type="submit" disabled={models === null || name.trim() === '' || baseUrl.trim() === '' || save.isPending} className={BUTTON}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} className={BUTTON}>Cancel</button>
      </div>
      {save.error && <p className="text-[11px] text-red-400">{save.error.message}</p>}
    </form>
  )
}

/**
 * What a re-fetch found that differs from the list being edited, by id: new
 * and changed models start checked, gone ones unchecked, since a model the
 * endpoint no longer lists may have been added by hand. Applying edits the
 * JSON, not the server, so the result is reviewed before Save.
 */
function DiffPanel({ diff, canApply, onApply, onReplace, onDismiss }: {
  diff: EndpointModelsDiff
  /** False while the JSON being edited does not parse. */
  canApply: boolean
  onApply: (pick: { added: Set<string>; changed: Set<string>; removed: Set<string> }) => void
  onReplace: () => void
  onDismiss: () => void
}): JSX.Element {
  const [added, setAdded] = useState(() => new Set(diff.added.map((m) => m.id)))
  const [changed, setChanged] = useState(() => new Set(diff.changed.map((c) => c.after.id)))
  const [removed, setRemoved] = useState(() => new Set<string>())
  if (emptyDiff(diff)) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-hairline-soft p-2 text-[11px] text-text-dim">
        The endpoint&apos;s list matches yours.
        <button type="button" onClick={onDismiss} className={clsx(TEXT_BUTTON, 'ml-auto')}>Dismiss</button>
      </div>
    )
  }
  const flip = (set: Set<string>, update: (s: Set<string>) => void, id: string): void => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    update(next)
  }
  const row = (label: string, id: string, text: string, set: Set<string>, update: (s: Set<string>) => void): JSX.Element => (
    <label key={`${label}-${id}`} className="flex items-center gap-2 font-mono text-[11px] text-text-dim">
      <input type="checkbox" checked={set.has(id)} onChange={() => flip(set, update, id)} aria-label={`${label} ${id}`} />
      <span className="w-14 shrink-0 font-sans text-text-faint">{label}</span>
      <span className="truncate">{text}</span>
    </label>
  )
  return (
    <div role="region" aria-label="Fetched changes" className="flex flex-col gap-1 rounded-md border border-accent/20 bg-accent/5 p-2">
      {diff.added.map((m) => row('New', m.id, describeEndpointModel(m), added, setAdded))}
      {diff.changed.map(({ before, after }) => row(
        'Changed', after.id, `${describeEndpointModel(before)} → ${describeEndpointModel(after)}`, changed, setChanged,
      ))}
      {diff.removed.map((m) => row('Gone', m.id, describeEndpointModel(m), removed, setRemoved))}
      {!canApply && <p className="text-[11px] text-red-400">Fix the models JSON below to apply these.</p>}
      <div className="mt-1 flex flex-wrap gap-2">
        <button type="button" disabled={!canApply} onClick={() => onApply({ added, changed, removed })} className={BUTTON}>Apply selected</button>
        <button
          type="button"
          disabled={!canApply}
          onClick={() => onApply({
            added: new Set(diff.added.map((m) => m.id)),
            changed: new Set(diff.changed.map((c) => c.after.id)),
            removed: new Set(diff.removed.map((m) => m.id)),
          })}
          className={BUTTON}
        >
          Apply all
        </button>
        <button type="button" onClick={onReplace} className={BUTTON}>Replace list with fetched</button>
        <button type="button" onClick={onDismiss} className={BUTTON}>Dismiss</button>
      </div>
    </div>
  )
}
