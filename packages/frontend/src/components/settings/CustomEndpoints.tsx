import { useState, type FormEvent, type JSX } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '#lib/api'
import { AUTH_LIST_KEY, useAuthList } from '#lib/useAuthList'
import { AffectsBanner } from '#components/settings/AffectsBanner'
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
import { YButton, YCheckbox, YChip, YConfirm, YInput, YRowFrame, YSection, YSettingGroup, YTextArea } from '#ui'

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
    <YSection
      title="Custom endpoints"
      description="OpenAI-compatible servers that opencode, pi and omp can use."
      actions={editing !== 'new' && (
        <YButton size="sm" onClick={() => setEditing('new')}>
          Add custom endpoint
        </YButton>
      )}
    >
      {endpoints.length === 0 && editing !== 'new' ? (
        <YSettingGroup><p className="px-4 py-3 text-md text-subtle">No custom endpoints yet.</p></YSettingGroup>
      ) : (
        <YSettingGroup className="text-md">
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
          {editing === 'new' && (
            <div className="px-4 py-3">
              <EndpointEditor onDone={() => { setEditing(null); void refresh() }} onCancel={() => setEditing(null)} />
            </div>
          )}
        </YSettingGroup>
      )}
    </YSection>
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
    <div data-endpoint={e.id} className="flex flex-col gap-1.5 px-4 py-2">
      <YRowFrame
        label={e.name}
        actionsShown
        actions={<>
          <YButton variant="secondary" size="sm" onClick={onEdit}>{editing ? 'Close' : 'Edit'}</YButton>
          <YButton variant="danger" size="sm" onClick={() => setConfirm({ kind: 'delete' })}>Delete</YButton>
        </>}
        className="min-h-7"
      >
        <span className="truncate font-medium text-text">{e.name}</span>
        <span className="truncate font-mono text-subtle">{[e.baseUrl, e.keyPreview].filter(Boolean).join(' · ')}</span>
      </YRowFrame>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm text-subtle">Used by</span>
        {API_KEY_TOOLS.map((tool) => (
          <YChip
            key={tool}
            role="switch"
            aria-checked={e.tools.includes(tool)}
            aria-label={tool}
            selected={e.tools.includes(tool)}
            disabled={change.isPending}
            onClick={() => toggle(tool)}
            className="font-mono"
          >
            {tool}
          </YChip>
        ))}
      </div>
      <p className="font-mono text-sm leading-relaxed text-muted">
        {e.models.map(describeEndpointModel).join(', ')}
      </p>
      {editing && <EndpointEditor endpoint={e} onDone={onDone} onCancel={onEdit} />}
      {change.error && <p className="text-sm text-danger">{change.error.message}</p>}
      <YConfirm
        open={confirm?.kind === 'attach'}
        onOpenChange={(open) => { if (!open) setConfirm(null) }}
        title={`Use ${e.name} for ${confirm?.kind === 'attach' ? confirm.tool : ''}?`}
        description={`This replaces its ${replacing && providerOf(replacing) ? `${providerOf(replacing)} ` : ''}sign-in.`}
        confirmLabel="Replace"
        busy={change.isPending}
        onConfirm={() => { if (confirm?.kind === 'attach') attach(confirm.tool) }}
      />
      <YConfirm
        open={confirm?.kind === 'detach'}
        onOpenChange={(open) => { if (!open) setConfirm(null) }}
        title={`Sign ${confirm?.kind === 'detach' ? confirm.tool : ''} out?`}
        description={`It stops using ${e.name}, and cannot create workspaces until signed in again.`}
        confirmLabel="Sign out"
        busy={change.isPending}
        onConfirm={() => { if (confirm?.kind === 'detach') detach(confirm.tool) }}
      />
      <YConfirm
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
    <form onSubmit={submit} className="flex flex-col gap-2 border-t border-line pt-2">
      {endpoint && (
        <AffectsBanner
          lead="Used by"
          names={endpoint.tools}
          none="No tool uses this endpoint yet."
          note="Saving updates their model lists for agents started from now on; running ones keep theirs until restarted."
        />
      )}
      <div className="flex gap-2">
        <YInput aria-label="Endpoint name" value={name} onChange={(ev) => setName(ev.target.value)} placeholder="Name, e.g. my-llama" className="w-40 font-mono" />
        <YInput
          aria-label="Endpoint URL"
          value={baseUrl}
          onChange={(ev) => setBaseUrl(ev.target.value)}
          onBlur={() => { if (endpoint === undefined && blank && baseUrl.trim() !== '') fetchModels.mutate() }}
          placeholder="Endpoint URL, e.g. http://my-box:8080/v1"
          className="flex-1 font-mono"
        />
      </div>
      <div className="flex items-center gap-2">
        <YInput
          aria-label="Endpoint API key"
          type="password"
          value={apiKey}
          onChange={(ev) => { setApiKey(ev.target.value); setClearKey(false) }}
          placeholder={endpoint?.keyPreview && !clearKey ? `API key (keep ${endpoint.keyPreview})` : 'API key (optional)'}
          className="flex-1 font-mono"
        />
        {endpoint?.keyPreview && !clearKey && (
          <YButton variant="danger" size="sm" onClick={() => { setClearKey(true); setApiKey('') }}>Remove key</YButton>
        )}
        <YButton
          size="sm"
          disabled={baseUrl.trim() === '' || fetchModels.isPending || (!blank && models === null)}
          title={!blank && models === null ? 'Fix the models JSON first, so the fetched list can be compared with it' : undefined}
          onClick={() => fetchModels.mutate()}
        >
          {fetchModels.isPending ? 'Fetching…' : endpoint ? 'Re-fetch from endpoint' : 'Fetch models'}
        </YButton>
      </div>
      {endpoint?.keyPreview && !clearKey && apiKey.trim() === '' && hostOf(baseUrl) !== hostOf(endpoint.baseUrl) && (
        <p className="text-sm text-warning">The stored key is removed when the host changes; enter it again to keep one.</p>
      )}
      {fetchModels.error && <p className="text-sm text-danger">{fetchModels.error.message}</p>}
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
      <YTextArea
        aria-label="Models (JSON)"
        value={modelsText}
        onChange={(ev) => setModelsText(ev.target.value)}
        placeholder={'[{ "id": "my-model", "efforts": { "levels": ["low", "medium", "high"], "default": "medium" } }]'}
        rows={Math.min(16, Math.max(4, modelsText.split('\n').length))}
        spellCheck={false}
        className="resize-y font-mono leading-relaxed"
      />
      {problems.length > 0 && (
        <ul className="text-sm text-danger">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
      )}
      {discovery && discovery.found.skipped.length > 0 && (
        <p className="text-sm text-subtle">
          Left out: {discovery.found.skipped.map((s) => `${s.id} (${s.reason})`).join(', ')}
        </p>
      )}
      <p className="text-sm text-subtle">
        Each model is an id, an optional name, and its reasoning levels (none minimal low medium high xhigh max) with a default.
      </p>
      <div className="flex gap-2">
        <YButton
          variant="primary"
          size="sm"
          type="submit"
          disabled={models === null || name.trim() === '' || baseUrl.trim() === '' || save.isPending}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </YButton>
        <YButton variant="ghost" size="sm" onClick={onCancel}>Cancel</YButton>
      </div>
      {save.error && <p className="text-sm text-danger">{save.error.message}</p>}
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
      <div className="flex items-center gap-2 bg-sunken p-2 text-sm text-muted shadow-inset">
        The endpoint&apos;s list matches yours.
        <YButton variant="ghost" size="sm" onClick={onDismiss} className="ml-auto">Dismiss</YButton>
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
    <YCheckbox key={`${label}-${id}`} checked={set.has(id)} onCheckedChange={() => flip(set, update, id)} aria-label={`${label} ${id}`}>
      <span className="flex min-w-0 items-center gap-2 font-mono text-sm text-muted">
        <span className="w-14 shrink-0 font-sans text-subtle">{label}</span>
        <span className="truncate">{text}</span>
      </span>
    </YCheckbox>
  )
  return (
    <div role="region" aria-label="Fetched changes" className="flex flex-col gap-1 bg-info-soft p-2">
      {diff.added.map((m) => row('New', m.id, describeEndpointModel(m), added, setAdded))}
      {diff.changed.map(({ before, after }) => row(
        'Changed', after.id, `${describeEndpointModel(before)} → ${describeEndpointModel(after)}`, changed, setChanged,
      ))}
      {diff.removed.map((m) => row('Gone', m.id, describeEndpointModel(m), removed, setRemoved))}
      {!canApply && <p className="text-sm text-danger">Fix the models JSON below to apply these.</p>}
      <div className="mt-1 flex flex-wrap gap-2">
        <YButton size="sm" disabled={!canApply} onClick={() => onApply({ added, changed, removed })}>Apply selected</YButton>
        <YButton
          size="sm"
          disabled={!canApply}
          onClick={() => onApply({
            added: new Set(diff.added.map((m) => m.id)),
            changed: new Set(diff.changed.map((c) => c.after.id)),
            removed: new Set(diff.removed.map((m) => m.id)),
          })}
        >
          Apply all
        </YButton>
        <YButton size="sm" onClick={onReplace}>Replace list with fetched</YButton>
        <YButton variant="ghost" size="sm" onClick={onDismiss}>Dismiss</YButton>
      </div>
    </div>
  )
}
