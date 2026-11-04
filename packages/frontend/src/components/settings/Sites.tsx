import { useState, type FormEvent, type JSX } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '#lib/api'
import { DeleteIcon } from '#lib/icons'
import { relativeAge } from '#lib/time'
import { useVolumes } from '#lib/volumes'
import { SectionLabel } from '#components/settings/Field'
import { INPUT, WorkspaceLink } from '#components/settings/Volumes'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { BUTTON, TEXT_BUTTON } from '#components/ui/button'
import type { SiteDeployPhase, SiteEntry } from '@yaac/shared/types'

/** How often the list is refetched while a deploy runs. */
const DEPLOY_POLL_MS = 3000

const PHASE: Record<SiteDeployPhase, string> = {
  launching: 'creating release',
  building: 'building',
  handoff: 'handing over the volume',
  starting: 'starting',
}

type Action = 'deploy' | 'stop' | 'start' | 'delete'

const short = (commit: string): string => commit.slice(0, 7)

/**
 * A project's public sites (docs/public-sites.md): the install's edge, then
 * each site's hostname, port, live release, deploy in progress and how the
 * last one ended, with deploy, stop, start, edit and delete. Only shown on
 * a cluster. The list is refetched every few seconds while a deploy runs;
 * `readOnly` (a teammate's project) only lists them.
 */
export function Sites({ projectId, readOnly }: { projectId: string; readOnly: boolean }): JSX.Element {
  const queryClient = useQueryClient()
  const key = ['sites', projectId]
  const { data: sites } = useQuery({
    queryKey: key,
    queryFn: () => api.site.list.$get({ query: { project: projectId } }),
    refetchInterval: (q) => (q.state.data?.some((s) => s.deploy !== undefined) ? DEPLOY_POLL_MS : false),
  })
  // The site the form edits, or 'new'; and the hostname of the one just
  // created, until its Cloudflare note is dismissed.
  const [form, setForm] = useState<SiteEntry | 'new' | null>(null)
  const [created, setCreated] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ action: Action; site: string } | null>(null)
  const [ref, setRef] = useState('')
  const onSettled = (): Promise<void> => queryClient.invalidateQueries({ queryKey: key })

  const act = useMutation({
    mutationFn: async ({ action, site }: { action: Action; site: string }): Promise<void> => {
      const json = { project: projectId, name: site }
      switch (action) {
        case 'deploy': await api.site.deploy.$post({ json: { ...json, ...(ref.trim() !== '' ? { ref: ref.trim() } : {}) } }); return
        case 'start': await api.site.start.$post({ json }); return
        case 'stop': await api.site.stop.$post({ json }); return
        case 'delete': await api.site.delete.$post({ json })
      }
    },
    onSuccess: () => setConfirm(null),
    onSettled,
  })
  const ask = (action: Action, site: string): void => {
    act.reset()
    setRef('')
    setConfirm({ action, site })
  }

  return (
    <div>
      <SectionLabel>Sites</SectionLabel>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        A site publishes the project&apos;s app at a hostname on the internet. Each deploy starts a release: a
        workspace that runs the site&apos;s steps at one commit and, once ready, takes over the hostname.
      </p>
      <EdgeStatus />

      {sites !== undefined && (
        <div className="mt-3 space-y-1">
          {sites.map((s) => (
            <SiteRow
              key={s.name}
              projectId={projectId}
              site={s}
              readOnly={readOnly}
              onAction={(action) => (action === 'start' ? act.mutate({ action, site: s.name }) : ask(action, s.name))}
              onEdit={() => setForm(s)}
            />
          ))}
          {sites.length === 0 && <p className="text-[11px] text-text-faint">No sites yet.</p>}
        </div>
      )}
      {confirm === null && act.error && <p className="mt-2 text-xs text-red-400">{act.error.message}</p>}

      {created !== null && (
        <div role="note" className="mt-3 flex items-start gap-2 rounded-md bg-bg px-2.5 py-1.5 text-[11px] text-text-dim">
          <p className="flex-1 leading-relaxed">
            To make it public, add a public hostname <code className="text-text">{created}</code> to the
            install&apos;s Cloudflare tunnel, whose service is the router (
            <code className="text-text">yaac-site-router</code>, port 8080).
          </p>
          <button type="button" onClick={() => setCreated(null)} className={TEXT_BUTTON}>Dismiss</button>
        </div>
      )}

      {!readOnly && (form === null ? (
        <button type="button" onClick={() => setForm('new')} className={`${BUTTON} mt-3`}>New site</button>
      ) : (
        <SiteForm
          key={form === 'new' ? '' : form.name}
          projectId={projectId}
          {...(form !== 'new' ? { site: form } : {})}
          onDone={(hostname) => {
            setForm(null)
            if (hostname !== undefined) setCreated(hostname)
            void onSettled()
          }}
          onCancel={() => setForm(null)}
        />
      ))}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => { if (!open) { setConfirm(null); act.reset() } }}
        {...confirmText(confirm)}
        busy={act.isPending}
        error={act.error?.message}
        onConfirm={() => { if (confirm !== null) act.mutate(confirm) }}
      >
        {confirm?.action === 'deploy' && (
          <input
            aria-label="Ref to deploy"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="branch or commit (default: the default branch)"
            className={`${INPUT} mt-3 w-full`}
          />
        )}
      </ConfirmDialog>
    </div>
  )
}

/** The confirm dialog's words for an action on a site. */
function confirmText(confirm: { action: Action; site: string } | null): {
  title: string
  description: string
  confirmLabel: string
  destructive: boolean
} {
  const site = confirm?.site ?? ''
  switch (confirm?.action) {
    case 'deploy': return {
      title: `Deploy “${site}”?`,
      description: 'A new release runs the site’s steps at this commit and takes over the hostname once it is ready.',
      confirmLabel: 'Deploy',
      destructive: false,
    }
    case 'stop': return {
      title: `Stop “${site}”?`,
      description: 'Its live release stops, and the hostname answers 503 until the site is started again.',
      confirmLabel: 'Stop',
      destructive: true,
    }
    default: return {
      title: `Delete site “${site}”?`,
      description: 'This stops the site’s releases, and its hostname no longer serves anything.',
      confirmLabel: 'Delete',
      destructive: true,
    }
  }
}

/** Whether the install's tunnel to Cloudflare is connected. */
function EdgeStatus(): JSX.Element | null {
  const { data: edge } = useQuery({ queryKey: ['site-edge'], queryFn: () => api.site.edge.$get() })
  if (edge === undefined) return null
  if (edge.tunnel === 'absent') {
    return (
      <p className="mt-2 text-[11px] leading-relaxed text-warning">
        This install has no tunnel, so no site is reachable from the internet. Set one up with{' '}
        <code className="text-text-dim">CF_TUNNEL_TOKEN=… yaac cluster install</code>.
      </p>
    )
  }
  return (
    <p className={`mt-2 text-[11px] ${edge.tunnel === 'connected' ? 'text-text-faint' : 'text-danger'}`}>
      Cloudflare tunnel {edge.tunnel}
    </p>
  )
}

/** One site: its address and actions, then its release lines. */
function SiteRow({ projectId, site, readOnly, onAction, onEdit }: {
  projectId: string
  site: SiteEntry
  readOnly: boolean
  onAction: (action: Action) => void
  onEdit: () => void
}): JSX.Element {
  const { live, deploy, lastDeploy } = site
  const release = (workspaceId: string, commit: string): JSX.Element => (
    <span className="font-mono"><WorkspaceLink projectId={projectId} workspaceId={workspaceId} title={short(commit)} /></span>
  )
  return (
    <div className="rounded-md bg-bg px-2.5 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-text">{site.name}</span>
        <a
          href={`https://${site.hostname}`}
          target="_blank"
          rel="noreferrer noopener"
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-dim hover:text-text hover:underline"
        >
          {site.hostname}
        </a>
        <span className="shrink-0 font-mono text-[11px] text-text-faint">
          :{site.port}{site.adminPort !== undefined && ` · admin :${site.adminPort}`}
          {site.volume !== undefined && ` · ${site.volume}`}
        </span>
        {!readOnly && (
          <>
            {deploy === undefined && <button type="button" onClick={() => onAction('deploy')} className={TEXT_BUTTON}>Deploy</button>}
            {live !== undefined
              ? <button type="button" onClick={() => onAction('stop')} className={TEXT_BUTTON}>Stop</button>
              : deploy === undefined && lastDeploy !== undefined
                && <button type="button" onClick={() => onAction('start')} className={TEXT_BUTTON}>Start</button>}
            <button type="button" onClick={onEdit} className={TEXT_BUTTON}>Edit</button>
            <button
              type="button"
              onClick={() => onAction('delete')}
              aria-label={`Delete site ${site.name}`}
              className="shrink-0 text-text-faint transition hover:text-text"
            >
              <DeleteIcon size={12} />
            </button>
          </>
        )}
      </div>
      <div className="mt-0.5 space-y-0.5 text-[11px] text-text-faint">
        <div>
          {live !== undefined ? (
            <>Live {release(live.workspaceId, live.commit)} · {live.running ? `running, deployed ${relativeAge(live.since)}` : 'replacing'}</>
          ) : 'Not serving'}
        </div>
        {deploy !== undefined && (
          <div>
            {deploy.replacing ? 'Replacing the release at ' : 'Deploying '}{release(deploy.workspaceId, deploy.commit)} · {PHASE[deploy.phase]}
          </div>
        )}
        {lastDeploy !== undefined && (
          <div className={lastDeploy.outcome === 'failed' ? 'text-danger' : undefined}>
            Last deploy {release(lastDeploy.workspaceId, lastDeploy.commit)} {lastDeploy.outcome}{' '}
            {relativeAge(lastDeploy.finishedAt)}{lastDeploy.error !== undefined && `: ${lastDeploy.error}`}
          </div>
        )}
      </div>
    </div>
  )
}

/** Parse the steps box, which must hold a JSON object. */
function parseSteps(text: string): Record<string, unknown> {
  let steps: unknown
  try {
    steps = JSON.parse(text)
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (typeof steps !== 'object' || steps === null || Array.isArray(steps)) throw new Error('Steps must be a JSON object')
  return steps as Record<string, unknown>
}

/**
 * Create a site, or edit `site`. Steps are checked to be a JSON object here
 * and otherwise by the server, whose message shows as given. `onDone` gets
 * a created site's hostname.
 */
function SiteForm({ projectId, site, onDone, onCancel }: {
  projectId: string
  site?: SiteEntry
  onDone: (createdHostname?: string) => void
  onCancel: () => void
}): JSX.Element {
  const volumes = useVolumes(projectId)
  const [name, setName] = useState('')
  const [hostname, setHostname] = useState(site?.hostname ?? '')
  const [port, setPort] = useState(site !== undefined ? String(site.port) : '')
  const [adminPort, setAdminPort] = useState(site?.adminPort !== undefined ? String(site.adminPort) : '')
  const [volume, setVolume] = useState(site?.volume ?? '')
  const [steps, setSteps] = useState(site !== undefined ? `${JSON.stringify(site.steps, null, 2)}\n` : '')

  const save = useMutation({
    mutationFn: async () => {
      const body = { project: projectId, hostname: hostname.trim(), port: Number(port), steps: parseSteps(steps) }
      const admin = adminPort.trim() === '' ? null : Number(adminPort)
      if (site !== undefined) {
        await api.site.edit.$post({ json: { ...body, name: site.name, adminPort: admin, volume: volume === '' ? null : volume } })
      } else {
        await api.site.create.$post({ json: {
          ...body, name: name.trim(), ...(admin !== null ? { adminPort: admin } : {}), ...(volume !== '' ? { volume } : {}),
        } })
      }
    },
    onSuccess: () => onDone(site === undefined ? hostname.trim() : undefined),
  })
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    save.mutate()
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-2 rounded-md bg-bg p-2.5">
      <div className="text-[11px] font-medium text-text">{site !== undefined ? `Edit “${site.name}”` : 'New site'}</div>
      <div className="flex gap-2">
        {site === undefined && (
          <input
            aria-label="Site name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name"
            className={`${INPUT} w-28`}
          />
        )}
        <input
          aria-label="Hostname"
          value={hostname}
          onChange={(e) => setHostname(e.target.value)}
          placeholder="app.example.com"
          className={`${INPUT} min-w-0 flex-1`}
        />
        <input
          aria-label="Port"
          value={port}
          onChange={(e) => setPort(e.target.value)}
          placeholder="3000"
          inputMode="numeric"
          className={`${INPUT} w-16`}
        />
        <input
          aria-label="Admin port"
          value={adminPort}
          onChange={(e) => setAdminPort(e.target.value)}
          placeholder="admin"
          title="A port of each release that only you can reach, as a preview or with yaac forward"
          inputMode="numeric"
          className={`${INPUT} w-16`}
        />
        <select
          aria-label="Volume"
          value={volume}
          onChange={(e) => setVolume(e.target.value)}
          className={`${INPUT} w-28`}
        >
          <option value="">No volume</option>
          {volumes?.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
        </select>
      </div>
      <textarea
        aria-label="Steps"
        value={steps}
        onChange={(e) => setSteps(e.target.value)}
        placeholder={'{\n  "install": { "run": "pnpm install" },\n  "server": { "run": "pnpm start", "service": true, "needs": ["install"] }\n}'}
        rows={8}
        spellCheck={false}
        className={`${INPUT} block w-full resize-y`}
      />
      <p className="text-[11px] leading-relaxed text-text-faint">
        The steps each release runs, like init steps; one must be a{' '}
        <code className="text-text-dim">{'"service": true'}</code> serving the port. Steps that use the volume
        need <code className="text-text-dim">{'"volume"'}</code>, and run only once the old release has let it go.
        An admin port is one only you can open, as the release&apos;s preview; the internet never reaches it.
      </p>
      {save.error && <p className="text-xs text-red-400">{save.error.message}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={TEXT_BUTTON}>Cancel</button>
        <button
          type="submit"
          disabled={save.isPending || hostname.trim() === '' || (site === undefined && name.trim() === '')}
          className={BUTTON}
        >
          {save.isPending ? 'Saving…' : site !== undefined ? 'Save' : 'Create'}
        </button>
      </div>
    </form>
  )
}
