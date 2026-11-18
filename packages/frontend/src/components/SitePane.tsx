import { useState, type FormEvent, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Menu } from '@base-ui/react/menu'
import { BAR_BUTTON } from '#components/WorkflowPane'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { BUTTON, TEXT_BUTTON } from '#components/ui/button'
import { MENU_ITEM, MenuPopup } from '#components/ui/menu'
import { api } from '#lib/api'
import { MoreIcon, SiteIcon } from '#lib/icons'
import { relativeAge } from '#lib/time'
import { useVolumes } from '#lib/volumes'
import { useIsAdmin, useReadOnly } from '#lib/viewer'
import { useSnapshot } from '#lib/useSnapshot'
import { useStartSelection } from '#lib/useStartSelection'
import { useUiStore } from '#lib/store'
import type { RepoPick } from '#lib/newWorkspace'
import { siteEdgeOf } from '@yaac/shared/site-edge'
import { formatCommits } from '@yaac/shared/steps'
import type {
  ProjectSummary, SiteCommit, SiteDeployPhase, SiteEdge, SiteEdgeStatus, SiteEntry, SiteSummary, SiteTailnetState,
} from '@yaac/shared/types'

const INPUT = 'rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text outline-none focus:border-border-strong'

export const PHASE: Record<SiteDeployPhase, string> = {
  launching: 'creating release',
  building: 'building',
  handoff: 'handing over the volume',
  starting: 'starting',
}

/** Who reaches a site of each edge. */
const EDGE_REACH: Record<SiteEdge, string> = {
  tailnet: 'A tailnet site: only users on this install’s tailnet reach it, each request carrying their login.',
  public: 'A public site: the internet reaches it once the Cloudflare tunnel routes its hostname.',
}

const TAILNET_STATE: Record<SiteTailnetState, string> = {
  absent: 'no tailnet tunnel',
  joining: 'tailnet tunnel joining the tailnet',
  'no-certificate': 'tailnet tunnel has no certificate',
  ready: 'tailnet tunnel ready',
}

function useSiteEdge(): SiteEdgeStatus | undefined {
  return useQuery({ queryKey: ['site-edge'], queryFn: () => api.site.edge.$get() }).data
}

/** Commits per repo: `<dir>@<short>` each, bare for a lone repo. */
const short = (commits: SiteCommit[]): string => formatCommits(commits, 8)

/** A site's state in a few words, for its sidebar row. */
export function siteState(site: SiteSummary): string {
  if (site.deploy !== undefined) return site.deploy.replacing ? 'replacing its release' : PHASE[site.deploy.phase]
  if (site.live !== undefined) return 'serving'
  if (site.lastDeploy?.outcome === 'failed') return 'deploy failed'
  return 'not serving'
}

type Action = 'deploy' | 'stop' | 'delete'

/** What can be done to a site, from its sidebar row or its pane. */
export interface SiteActions {
  /** Ask, then deploy, stop or delete. */
  ask: (action: Action) => void
  start: () => void
  edit: () => void
  /** Deploy and Start need an admin; Stop and Delete the owner too. */
  canPublish: boolean
  canEnd: boolean
  error: string | null
  dialog: JSX.Element
}

/** A site's actions (docs/public-sites.md). A deploy of a site that does
 *  not follow its branches asks which ref of each repo to deploy. */
export function useSiteActions(site: SiteSummary): SiteActions {
  const admin = useIsAdmin()
  const readOnly = useReadOnly()
  const openObject = useUiStore((s) => s.openObject)
  const [confirm, setConfirm] = useState<Action | null>(null)
  const [refs, setRefs] = useState<Record<string, string>>({})
  const json = { project: site.projectId, name: site.name }
  const { data: entry } = useQuery({
    queryKey: ['site', site.projectId, site.name],
    queryFn: () => api.site.show.$get({ query: json }),
    enabled: confirm === 'deploy',
  })
  const act = useMutation({
    mutationFn: async (action: Action | 'start'): Promise<void> => {
      switch (action) {
        case 'deploy': {
          const named: Record<string, string> = {}
          for (const [dir, ref] of Object.entries(refs)) if (ref.trim() !== '') named[dir] = ref.trim()
          await api.site.deploy.$post({ json: { ...json, ...(Object.keys(named).length > 0 ? { refs: named } : {}) } })
          return
        }
        case 'start': await api.site.start.$post({ json }); return
        case 'stop': await api.site.stop.$post({ json }); return
        case 'delete': await api.site.delete.$post({ json })
      }
    },
    onSuccess: () => setConfirm(null),
  })
  return {
    ask: (action) => {
      act.reset()
      setRefs({})
      setConfirm(action)
    },
    start: () => act.mutate('start'),
    edit: () => openObject(site.projectId, { kind: 'site', id: site.name, edit: true }),
    canPublish: admin && !readOnly,
    canEnd: admin || !readOnly,
    error: confirm === null && act.error ? act.error.message : null,
    dialog: (
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => { if (!open) { setConfirm(null); act.reset() } }}
        {...confirmText(confirm, site.name)}
        busy={act.isPending}
        error={act.error?.message}
        onConfirm={() => { if (confirm !== null) act.mutate(confirm) }}
      >
        {confirm === 'deploy' && <p className="mt-3 text-[11px] text-text-faint">{EDGE_REACH[site.edge]}</p>}
        {confirm === 'deploy' && site.follow && (
          <p className="mt-3 text-[11px] text-text-faint">It follows its branches, so it deploys their tips.</p>
        )}
        {confirm === 'deploy' && !site.follow && entry?.repos.map((r) => (
          <input
            key={r.dir}
            aria-label={`Ref to deploy ${r.dir} at`}
            value={refs[r.dir] ?? ''}
            onChange={(e) => setRefs({ ...refs, [r.dir]: e.target.value })}
            placeholder={`${r.dir}: branch or commit (default: ${r.branch ?? r.commit?.slice(0, 8) ?? ''})`}
            className={`${INPUT} mt-3 w-full font-mono`}
          />
        ))}
      </ConfirmDialog>
    ),
  }
}

function confirmText(action: Action | null, site: string): {
  title: string
  description: string
  confirmLabel: string
  destructive: boolean
} {
  switch (action) {
    case 'deploy': return {
      title: `Deploy “${site}”?`,
      description: 'A new release runs the site’s workflow at these commits and takes over the hostname once it is ready.',
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

/**
 * A site in the main pane (docs/public-sites.md), opened from its sidebar
 * row. The bar holds Deploy and Stop or Start, and Edit and Delete. The
 * body shows its address and who reaches it, its live release, a deploy in
 * progress, the last deploy and what following is doing, and its recent
 * releases. With `site` absent, or `editing`, it is the site's form.
 */
export function SitePane({ project, site, editing, bar }: {
  project: ProjectSummary
  site?: SiteSummary
  editing: boolean
  bar: HTMLElement | null
}): JSX.Element {
  const openObject = useUiStore((s) => s.openObject)
  const select = useUiStore((s) => s.selectWorkspace)
  const done = (name?: string): void => {
    if (name !== undefined) openObject(project.id, { kind: 'site', id: name })
    else select(null)
  }
  if (site === undefined || editing) {
    return (
      <div className="h-full overflow-y-auto bg-bg px-4 py-6">
        {bar !== null && createPortal(
          <span className="titlebar-drag flex min-w-0 flex-1 items-center gap-1.5">
            <SiteIcon size={12} className="shrink-0 text-text-faint" />
            <h2 className="min-w-0 truncate font-medium text-text">{site !== undefined ? `Edit “${site.name}”` : 'New site'}</h2>
          </span>,
          bar,
        )}
        <div className="mx-auto max-w-2xl">
          <SiteForm project={project} {...(site !== undefined ? { site: site.name } : {})} onDone={done} onCancel={() => done(site?.name)} />
        </div>
      </div>
    )
  }
  return <SiteDetail site={site} bar={bar} />
}

function SiteDetail({ site, bar }: { site: SiteSummary; bar: HTMLElement | null }): JSX.Element {
  const actions = useSiteActions(site)
  const edge = useSiteEdge()
  const openWorkspace = useUiStore((s) => s.openWorkspace)
  const openObject = useUiStore((s) => s.openObject)
  const workflows = useSnapshot()?.workflows ?? []
  const workflow = workflows.find((w) => w.projectId === site.projectId && w.name === site.workflow)
  // Refetched whenever the snapshot's summary of it changes.
  const { data: detail } = useQuery({
    queryKey: ['site', site.projectId, site.name, JSON.stringify(site)],
    queryFn: () => api.site.show.$get({ query: { project: site.projectId, name: site.name } }),
  })
  const { live, deploy, lastDeploy } = site
  const release = (workspaceId: string, commits: SiteCommit[]): JSX.Element => (
    <button type="button" onClick={() => openWorkspace(site.projectId, workspaceId)} className="font-mono text-text-dim hover:text-text hover:underline">
      {short(commits)}
    </button>
  )

  return (
    <div className="h-full overflow-y-auto bg-bg px-4 py-6">
      {bar !== null && createPortal(
        <>
          <span className="titlebar-drag flex min-w-0 flex-1 items-center gap-1.5">
            <SiteIcon size={12} className="shrink-0 text-text-faint" />
            <h2 className="min-w-0 truncate font-medium text-text">{site.name}</h2>
            {actions.error !== null && <span className="truncate text-danger" title={actions.error}>{actions.error}</span>}
          </span>
          {actions.canPublish && deploy === undefined && (
            <button type="button" onClick={() => actions.ask('deploy')} className={BAR_BUTTON}>Deploy</button>
          )}
          {actions.canEnd && live !== undefined && (
            <button type="button" onClick={() => actions.ask('stop')} className={BAR_BUTTON}>Stop</button>
          )}
          {actions.canPublish && live === undefined && deploy === undefined && lastDeploy !== undefined && (
            <button type="button" onClick={actions.start} className={BAR_BUTTON}>Start</button>
          )}
          {actions.canEnd && (
            <Menu.Root>
              <Menu.Trigger aria-label="Site actions" title="Site actions" className={BAR_BUTTON}>
                <MoreIcon size={14} />
              </Menu.Trigger>
              <MenuPopup side="bottom" align="end" sideOffset={4} className="min-w-[140px]">
                {actions.canPublish && <Menu.Item className={MENU_ITEM} onClick={actions.edit}>Edit…</Menu.Item>}
                <Menu.Item className={MENU_ITEM} onClick={() => actions.ask('delete')}>Delete…</Menu.Item>
              </MenuPopup>
            </Menu.Root>
          )}
          {actions.dialog}
        </>,
        bar,
      )}
      <div className="mx-auto flex max-w-2xl flex-col gap-5 text-xs">
        <Section title="Address">
          <a href={`https://${site.hostname}`} target="_blank" rel="noreferrer noopener" className="font-mono text-text hover:underline">
            https://{site.hostname}
          </a>
          <p className="text-text-faint">{EDGE_REACH[site.edge]}</p>
          {site.edge === 'public' && (
            <p className="text-text-faint">
              It answers once the install&apos;s Cloudflare tunnel has a public hostname{' '}
              <code className="text-text-dim">{site.hostname}</code> whose service is the router
              (<code className="text-text-dim">yaac-site-router</code>, port 8080).
            </p>
          )}
          <EdgeStatus edge={edge} siteEdge={site.edge} />
        </Section>

        <Section title="Releases">
          <p className="text-text-dim">
            {live !== undefined
              ? <>Live {release(live.workspaceId, live.commits)} · {detail?.live?.running === false ? 'replacing' : `deployed ${relativeAge(live.since)}`}</>
              : 'Not serving'}
          </p>
          {deploy !== undefined && (
            <p className="text-text-dim">
              {deploy.replacing ? 'Replacing the release at ' : 'Deploying '}{release(deploy.workspaceId, deploy.commits)} · {PHASE[deploy.phase]}
            </p>
          )}
          {lastDeploy !== undefined && (
            <p className={lastDeploy.outcome === 'failed' ? 'text-danger' : 'text-text-dim'}>
              Last deploy {release(lastDeploy.workspaceId, lastDeploy.commits)} {lastDeploy.outcome}{' '}
              {relativeAge(lastDeploy.finishedAt)}{lastDeploy.error !== undefined && `: ${lastDeploy.error}`}
            </p>
          )}
          {detail?.followPaused !== undefined && <p className="text-warning">Not following: {detail.followPaused}</p>}
          {detail?.followSkipped !== undefined && (
            <p className="text-text-faint">Not retrying {short(detail.followSkipped)}, whose deploy failed; deploy to retry it</p>
          )}
          {detail !== undefined && detail.releases.length > 0 && (
            <ul className="mt-1 flex flex-col">
              {detail.releases.map((r) => (
                <li key={r.workspaceId}>
                  <button
                    type="button"
                    onClick={() => openWorkspace(site.projectId, r.workspaceId)}
                    className="flex w-full items-center gap-3 rounded-md px-1.5 py-1 text-left transition hover:bg-surface-2"
                  >
                    <span className="w-28 shrink-0 text-text-faint">{relativeAge(r.createdAt)}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-text-dim">{short(r.commits)}</span>
                    <span className="shrink-0 text-text-faint">{r.stoppedAt !== undefined ? 'stopped' : 'running'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {detail !== undefined && (
          <Section title="Settings">
            <dl className="grid grid-cols-[96px_1fr] gap-x-2 gap-y-1">
              <dt className="text-text-faint">Workflow</dt>
              <dd className="text-text-dim">
                {workflow !== undefined
                  ? <button type="button" onClick={() => openObject(site.projectId, { kind: 'workflow', id: workflow.id })} className={TEXT_BUTTON}>{site.workflow}</button>
                  : site.workflow}
              </dd>
              <dt className="text-text-faint">Port</dt>
              <dd className="font-mono text-text-dim">{detail.port}{detail.adminPort !== undefined && ` · admin ${detail.adminPort}`}</dd>
              <dt className="text-text-faint">Repos</dt>
              <dd className="font-mono text-text-dim">{detail.repos.map((r) => `${r.dir}@${r.branch ?? r.commit?.slice(0, 8) ?? '?'}`).join(' ')}</dd>
              <dt className="text-text-faint">Follows</dt>
              <dd className="text-text-dim">{detail.follow ? 'Yes: it deploys whenever one of these branches moves' : 'No'}</dd>
              {detail.volume !== undefined && <><dt className="text-text-faint">Volume</dt><dd className="text-text-dim">{detail.volume}</dd></>}
            </dl>
          </Section>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-text-faint">{title}</h3>
      {children}
    </section>
  )
}

/** The state of the install's tunnel for a site of `siteEdge`. */
function EdgeStatus({ edge, siteEdge }: { edge: SiteEdgeStatus | undefined; siteEdge: SiteEdge }): JSX.Element | null {
  if (edge === undefined) return null
  if (siteEdge === 'tailnet') {
    return <p className={edge.tailnet === 'ready' ? 'text-text-faint' : 'text-warning'}>{TAILNET_STATE[edge.tailnet]}</p>
  }
  return edge.cloudflare === 'absent' ? (
    <p className="text-warning">
      This install has no tunnel, so no site is reachable from the internet. Set one up with{' '}
      <code className="text-text-dim">CF_TUNNEL_TOKEN=… yaac cluster install</code>.
    </p>
  ) : (
    <p className={edge.cloudflare === 'connected' ? 'text-text-faint' : 'text-danger'}>Cloudflare tunnel {edge.cloudflare}</p>
  )
}

/**
 * Create a site, or edit the one named `site`. Its releases start with the
 * repos ticked, each at the branch or full commit its field names, which
 * starts empty: which branch is published is the owner's choice. They run
 * one of the project's workflows. `onDone` gets the site's name.
 */
export function SiteForm({ project, site: editing, onDone, onCancel }: {
  project: ProjectSummary
  site?: string
  onDone: (name: string) => void
  onCancel?: () => void
}): JSX.Element {
  const { data: site } = useQuery({
    queryKey: ['site', project.id, editing],
    queryFn: () => api.site.show.$get({ query: { project: project.id, name: editing ?? '' } }),
    enabled: editing !== undefined,
  })
  if (editing !== undefined && site === undefined) return <p className="text-xs text-text-faint">Loading…</p>
  return <SiteFields project={project} {...(site !== undefined ? { site } : {})} onDone={onDone} {...(onCancel !== undefined ? { onCancel } : {})} />
}

function SiteFields({ project, site, onDone, onCancel }: {
  project: ProjectSummary
  site?: SiteEntry
  onDone: (name: string) => void
  onCancel?: () => void
}): JSX.Element {
  const projectId = project.id
  const volumes = useVolumes(projectId)
  const workflows = (useSnapshot()?.workflows ?? []).filter((w) => w.projectId === projectId)
  const openObject = useUiStore((s) => s.openObject)
  const admin = useIsAdmin()
  const siteDomain = useSiteEdge()?.siteDomain
  const [name, setName] = useState('')
  const [hostname, setHostname] = useState(site?.hostname ?? '')
  const [port, setPort] = useState(site !== undefined ? String(site.port) : '')
  const [adminPort, setAdminPort] = useState(site?.adminPort !== undefined ? String(site.adminPort) : '')
  const [volume, setVolume] = useState(site?.volume ?? '')
  const [follow, setFollow] = useState(site?.follow ?? false)
  const [workflow, setWorkflow] = useState(site?.workflow ?? '')
  const [picks, setPicks] = useState<Record<string, RepoPick>>({})
  // What it starts with now, by repo id; a new site of a lone repo ticks it.
  const idOf = (dir: string): string => project.repos.find((p) => p.dir === dir)?.id ?? dir
  const seed = {
    repos: site !== undefined
      ? site.repos.map(({ dir, ...at }) => ({ repo: idOf(dir), ...at }))
      : project.repos.length === 1 ? [{ repo: project.repos[0].id }] : [],
    nested: false,
    cwd: '.',
  }
  const selection = useStartSelection(project, { repos: picks }, seed, {}, false)
  const pick = (id: string, change: RepoPick): void => setPicks({ ...picks, [id]: { ...picks[id], ...change } })
  const blocked = !admin ? 'Only an admin of this yaac install can publish sites'
    : selection.included.length === 0 ? 'Tick a repo'
    : selection.included.some((r) => r.branch.trim() === '') ? 'Give each repo a branch or a full commit'
    : hostname.trim() === '' ? 'Give it a hostname'
    : workflow === '' ? 'Pick a workflow'
    : site === undefined && name.trim() === '' ? 'Name the site'
    : null

  const save = useMutation({
    mutationFn: async () => {
      const repos = selection.request.repos
      const body = { project: projectId, hostname: hostname.trim(), port: Number(port), workflow, repos, follow }
      const admin = adminPort.trim() === '' ? null : Number(adminPort)
      if (site !== undefined) {
        await api.site.edit.$post({ json: { ...body, name: site.name, adminPort: admin, volume: volume === '' ? null : volume } })
        return site.name
      }
      await api.site.create.$post({ json: {
        ...body, name: name.trim(), ...(admin !== null ? { adminPort: admin } : {}), ...(volume !== '' ? { volume } : {}),
      } })
      return name.trim()
    },
    onSuccess: onDone,
  })
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    save.mutate()
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 text-xs">
      {site === undefined && (
        <Labelled label="Name">
          <input aria-label="Site name" value={name} onChange={(e) => setName(e.target.value)} placeholder="app" className={INPUT} />
        </Labelled>
      )}
      <Labelled label="Hostname" hint={hostname.trim() !== '' ? EDGE_REACH[siteEdgeOf(hostname.trim(), siteDomain)] : undefined}>
        <input
          aria-label="Hostname"
          value={hostname}
          onChange={(e) => setHostname(e.target.value)}
          placeholder={siteDomain !== undefined ? `app.${siteDomain}` : 'app.example.com'}
          className={`${INPUT} font-mono`}
        />
      </Labelled>
      <div className="flex gap-3">
        <Labelled label="Port">
          <input aria-label="Port" value={port} onChange={(e) => setPort(e.target.value)} placeholder="3000" inputMode="numeric" className={`${INPUT} w-24`} />
        </Labelled>
        <Labelled label="Admin port">
          <input
            aria-label="Admin port"
            value={adminPort}
            onChange={(e) => setAdminPort(e.target.value)}
            placeholder="none"
            title="A port of each release that only you can reach, as a preview or with yaac forward"
            inputMode="numeric"
            className={`${INPUT} w-24`}
          />
        </Labelled>
        <Labelled label="Volume">
          <select aria-label="Volume" value={volume} onChange={(e) => setVolume(e.target.value)} className={`${INPUT} w-36`}>
            <option value="">No volume</option>
            {volumes?.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
          </select>
        </Labelled>
      </div>
      <Labelled label="Workflow" hint="Each release runs its steps; one must be a service serving the port.">
        <select
          aria-label="Workflow"
          value={workflow}
          onChange={(e) => {
            if (e.target.value === NEW_WORKFLOW) openObject(projectId, { kind: 'workflow', id: '' })
            else setWorkflow(e.target.value)
          }}
          className={INPUT}
        >
          <option value="" disabled>Pick a workflow</option>
          {workflows.map((w) => <option key={w.id} value={w.name}>{w.name}</option>)}
          <option value={NEW_WORKFLOW}>+ New workflow…</option>
        </select>
      </Labelled>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 font-medium text-text">Repos</legend>
        <p className="text-[11px] text-text-faint">What each release starts with: one at its root, several in their folders.</p>
        {selection.rows.map((row) => (
          <div key={row.repo.id} className="flex items-center gap-2">
            <label className="flex w-28 shrink-0 items-center gap-1.5 truncate font-mono text-text">
              <input
                type="checkbox"
                aria-label={`Include ${row.repo.dir}`}
                checked={row.included}
                onChange={(e) => pick(row.repo.id, { included: e.target.checked })}
              />
              {row.repo.dir}
            </label>
            {row.included && <>
              <input
                aria-label={`Branch or commit of ${row.repo.dir}`}
                value={row.branch}
                onChange={(e) => pick(row.repo.id, { branch: e.target.value })}
                placeholder="branch or full commit"
                list={`site-branches-${row.repo.id}`}
                className={`${INPUT} min-w-0 flex-1 font-mono`}
              />
              <datalist id={`site-branches-${row.repo.id}`}>
                {row.branches?.map((b) => <option key={b} value={b} />)}
              </datalist>
            </>}
          </div>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-text">
        <input type="checkbox" role="switch" checked={follow} onChange={() => setFollow(!follow)} />
        Follow: deploy whenever a branch above moves
      </label>
      <p className="text-[11px] leading-relaxed text-text-faint">
        Steps that use the volume need <code className="text-text-dim">{'"volume"'}</code>, and run only once the old
        release has let it go. An admin port is one only you can open, as the release&apos;s preview; the internet
        never reaches it. A following site deploys whenever one of its branches moves, so whoever can push one, the
        project&apos;s agents included, publishes the site unless the remote&apos;s branch protection stops them. What
        fails to deploy leaves the last good release serving.
      </p>
      {save.error && <p className="text-red-400">{save.error.message}</p>}
      <div className="flex justify-end gap-2">
        {onCancel !== undefined && <button type="button" onClick={onCancel} className={TEXT_BUTTON}>Cancel</button>}
        <button type="submit" disabled={save.isPending || blocked !== null} title={blocked ?? undefined} className={BUTTON}>
          {save.isPending ? 'Saving…' : site !== undefined ? 'Save' : 'Create site'}
        </button>
      </div>
    </form>
  )
}

/** The workflow picker's "+ New workflow…" option. */
const NEW_WORKFLOW = '\u0000new'

function Labelled({ label, hint, children }: { label: string; hint?: string | undefined; children: ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-medium text-text">{label}</span>
      {children}
      {hint !== undefined && <span className="text-[11px] text-text-faint">{hint}</span>}
    </label>
  )
}
