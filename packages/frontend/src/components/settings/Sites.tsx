import { useState, type FormEvent, type JSX } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '#lib/api'
import { DeleteIcon } from '#lib/icons'
import { relativeAge } from '#lib/time'
import { useVolumes } from '#lib/volumes'
import { useIsAdmin } from '#lib/viewer'
import { useStartSelection } from '#lib/useStartSelection'
import type { RepoPick } from '#lib/newWorkspace'
import { SectionLabel } from '#components/settings/Field'
import { INPUT, WorkspaceLink } from '#components/settings/Volumes'
import { useWorkflows } from '#components/settings/Workflows'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { BUTTON, TEXT_BUTTON } from '#components/ui/button'
import { siteEdgeOf } from '@yaac/shared/site-edge'
import { formatCommits } from '@yaac/shared/steps'
import type {
  ProjectSummary, SiteCommit, SiteDeployPhase, SiteEdge, SiteEdgeStatus, SiteEntry, SiteTailnetState,
} from '@yaac/shared/types'

/** How often the list is refetched while a deploy runs. */
const DEPLOY_POLL_MS = 3000

const PHASE: Record<SiteDeployPhase, string> = {
  launching: 'creating release',
  building: 'building',
  handoff: 'handing over the volume',
  starting: 'starting',
}

type Action = 'deploy' | 'stop' | 'start' | 'delete'

/** Who reaches a site of each edge, for the form, the note after creating
 *  and the deploy dialog. */
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

/**
 * A project's public sites (docs/public-sites.md): the install's edge, then
 * each site's hostname, port, live release, deploy in progress and how the
 * last one ended, with deploy, stop, start, edit and delete. Only shown on
 * a cluster. The list is refetched every few seconds while a deploy runs;
 * `readOnly` (a teammate's project) only lists them, unless the caller is an
 * admin, who may stop and delete any site; a member may only stop and delete
 * their own.
 */
export function Sites({ project, readOnly }: { project: ProjectSummary; readOnly: boolean }): JSX.Element {
  const projectId = project.id
  const queryClient = useQueryClient()
  const admin = useIsAdmin()
  const canPublish = admin && !readOnly
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
  const edge = useSiteEdge()
  const [confirm, setConfirm] = useState<{ action: Action; site: string } | null>(null)
  // The ref the deploy dialog names per repo, by folder.
  const [refs, setRefs] = useState<Record<string, string>>({})
  const onSettled = (): Promise<void> => queryClient.invalidateQueries({ queryKey: key })
  const confirmed = sites?.find((s) => s.name === confirm?.site)

  const act = useMutation({
    mutationFn: async ({ action, site }: { action: Action; site: string }): Promise<void> => {
      const json = { project: projectId, name: site }
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
    onSettled,
  })
  const ask = (action: Action, site: string): void => {
    act.reset()
    setRefs({})
    setConfirm({ action, site })
  }

  return (
    <div>
      <SectionLabel>Sites</SectionLabel>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        A site publishes the project&apos;s app at a hostname: on the internet, or, under the install&apos;s site
        domain, only on its tailnet. Each deploy starts a release: a
        workspace that runs the site&apos;s workflow with each of its repos at a commit and, once ready, takes over
        the hostname.
      </p>
      <EdgeStatus edge={edge} />

      {sites !== undefined && (
        <div className="mt-3 space-y-1">
          {sites.map((s) => (
            <SiteRow
              key={s.name}
              projectId={projectId}
              site={s}
              canEnd={admin || !readOnly}
              canPublish={canPublish}
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
          {siteEdgeOf(created, edge?.siteDomain) === 'tailnet' ? (
            <p className="flex-1 leading-relaxed">
              <code className="text-text">https://{created}</code> is a tailnet site: only users on this
              install&apos;s tailnet reach it.
              {edge !== undefined && edge.tailnet !== 'ready' && ` It does not answer yet: ${TAILNET_STATE[edge.tailnet]}.`}
            </p>
          ) : (
            <p className="flex-1 leading-relaxed">
              To make it public, add a public hostname <code className="text-text">{created}</code> to the
              install&apos;s Cloudflare tunnel, whose service is the router (
              <code className="text-text">yaac-site-router</code>, port 8080).
            </p>
          )}
          <button type="button" onClick={() => setCreated(null)} className={TEXT_BUTTON}>Dismiss</button>
        </div>
      )}

      {!readOnly && !canPublish && (
        <p className="mt-3 text-[11px] leading-relaxed text-text-faint">
          Only an admin of this yaac install can publish sites. You can still stop and delete this project&apos;s.
        </p>
      )}
      {canPublish && (form === null ? (
        <button type="button" onClick={() => setForm('new')} className={`${BUTTON} mt-3`}>New site</button>
      ) : (
        <SiteForm
          key={form === 'new' ? '' : form.name}
          project={project}
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
        {confirm?.action === 'deploy' && confirmed !== undefined && (
          <p className="mt-3 text-[11px] text-text-faint">{EDGE_REACH[confirmed.edge]}</p>
        )}
        {confirm?.action === 'deploy' && confirmed?.follow === true && (
          <p className="mt-3 text-[11px] text-text-faint">It follows its branches, so it deploys their tips.</p>
        )}
        {confirm?.action === 'deploy' && confirmed?.follow === false && confirmed.repos.map((r) => (
          <input
            key={r.dir}
            aria-label={`Ref to deploy ${r.dir} at`}
            value={refs[r.dir] ?? ''}
            onChange={(e) => setRefs({ ...refs, [r.dir]: e.target.value })}
            placeholder={`${r.dir}: branch or commit (default: ${r.branch ?? r.commit?.slice(0, 8) ?? ''})`}
            className={`${INPUT} mt-3 w-full`}
          />
        ))}
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

/** The state of the install's two site tunnels, and its site domain. */
function EdgeStatus({ edge }: { edge: SiteEdgeStatus | undefined }): JSX.Element | null {
  if (edge === undefined) return null
  return (
    <>
      {edge.cloudflare === 'absent' ? (
        <p className="mt-2 text-[11px] leading-relaxed text-warning">
          This install has no tunnel, so no site is reachable from the internet. Set one up with{' '}
          <code className="text-text-dim">CF_TUNNEL_TOKEN=… yaac cluster install</code>.
        </p>
      ) : (
        <p className={`mt-2 text-[11px] ${edge.cloudflare === 'connected' ? 'text-text-faint' : 'text-danger'}`}>
          Cloudflare tunnel {edge.cloudflare}
        </p>
      )}
      {edge.siteDomain !== undefined && (
        <p className={`text-[11px] ${edge.tailnet === 'ready' ? 'text-text-faint' : 'text-warning'}`}>
          Site domain <code className="text-text-dim">{edge.siteDomain}</code>: {TAILNET_STATE[edge.tailnet]}
        </p>
      )}
    </>
  )
}

/** One site: its address and actions, then its release lines. */
function SiteRow({ projectId, site, canEnd, canPublish, onAction, onEdit }: {
  projectId: string
  site: SiteEntry
  canEnd: boolean
  canPublish: boolean
  onAction: (action: Action) => void
  onEdit: () => void
}): JSX.Element {
  const { live, deploy, lastDeploy } = site
  const release = (workspaceId: string, commits: SiteCommit[]): JSX.Element => (
    <span className="font-mono"><WorkspaceLink projectId={projectId} workspaceId={workspaceId} title={short(commits)} /></span>
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
        <span
          className={`shrink-0 text-[10px] uppercase ${site.edge === 'tailnet' ? 'text-accent' : 'text-text-faint'}`}
          title={EDGE_REACH[site.edge]}
        >
          {site.edge}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-text-faint">
          :{site.port}{site.adminPort !== undefined && ` · admin :${site.adminPort}`}
          {site.volume !== undefined && ` · ${site.volume}`}
          {` · ${site.repos.map((r) => `${r.dir}@${r.branch ?? r.commit?.slice(0, 8) ?? '?'}`).join(' ')}`}
          {site.follow && ' · follows'}
        </span>
        {canEnd && (
          <>
            {canPublish && deploy === undefined
              && <button type="button" onClick={() => onAction('deploy')} className={TEXT_BUTTON}>Deploy</button>}
            {live !== undefined
              ? <button type="button" onClick={() => onAction('stop')} className={TEXT_BUTTON}>Stop</button>
              : canPublish && deploy === undefined && lastDeploy !== undefined
                && <button type="button" onClick={() => onAction('start')} className={TEXT_BUTTON}>Start</button>}
            {canPublish && <button type="button" onClick={onEdit} className={TEXT_BUTTON}>Edit</button>}
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
            <>Live {release(live.workspaceId, live.commits)} · {live.running ? `running, deployed ${relativeAge(live.since)}` : 'replacing'}</>
          ) : 'Not serving'}
        </div>
        {deploy !== undefined && (
          <div>
            {deploy.replacing ? 'Replacing the release at ' : 'Deploying '}{release(deploy.workspaceId, deploy.commits)} · {PHASE[deploy.phase]}
          </div>
        )}
        {site.followPaused !== undefined && <div className="text-warning">Not following: {site.followPaused}</div>}
        {site.followSkipped !== undefined && (
          <div>Not retrying {short(site.followSkipped)}, whose deploy failed; deploy to retry it</div>
        )}
        {lastDeploy !== undefined && (
          <div className={lastDeploy.outcome === 'failed' ? 'text-danger' : undefined}>
            Last deploy {release(lastDeploy.workspaceId, lastDeploy.commits)} {lastDeploy.outcome}{' '}
            {relativeAge(lastDeploy.finishedAt)}{lastDeploy.error !== undefined && `: ${lastDeploy.error}`}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Create a site, or edit `site`. Its releases start with the repos ticked,
 * each at the branch or full commit its field names, which starts empty:
 * which branch is published is the owner's choice. They run one of the
 * project's workflows. `onDone` gets a created site's hostname.
 */
function SiteForm({ project, site, onDone, onCancel }: {
  project: ProjectSummary
  site?: SiteEntry
  onDone: (createdHostname?: string) => void
  onCancel: () => void
}): JSX.Element {
  const projectId = project.id
  const volumes = useVolumes(projectId)
  const { data: workflows } = useWorkflows(projectId)
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
  const blocked = selection.included.length === 0 ? 'Tick a repo'
    : selection.included.some((r) => r.branch.trim() === '') ? 'Give each repo a branch or a full commit' : null

  const save = useMutation({
    mutationFn: async () => {
      const repos = selection.request.repos
      const body = { project: projectId, hostname: hostname.trim(), port: Number(port), workflow, repos, follow }
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
          placeholder={siteDomain !== undefined ? `app.${siteDomain}` : 'app.example.com'}
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
      {hostname.trim() !== '' && (
        <p className="text-[11px] text-text-faint">{EDGE_REACH[siteEdgeOf(hostname.trim(), siteDomain)]}</p>
      )}
      <fieldset className="space-y-1">
        <legend className="text-[11px] text-text-faint">Repos each release starts with: one at its root, several in their folders</legend>
        {selection.rows.map((row) => (
          <div key={row.repo.id} className="flex items-center gap-2">
            <label className="flex w-28 shrink-0 items-center gap-1.5 truncate font-mono text-xs text-text">
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
                className={`${INPUT} min-w-0 flex-1`}
              />
              <datalist id={`site-branches-${row.repo.id}`}>
                {row.branches?.map((b) => <option key={b} value={b} />)}
              </datalist>
            </>}
          </div>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-xs text-text">
        <input type="checkbox" role="switch" checked={follow} onChange={() => setFollow(!follow)} />
        Follow: deploy whenever a branch above moves
      </label>
      <select
        aria-label="Workflow"
        value={workflow}
        onChange={(e) => setWorkflow(e.target.value)}
        className={`${INPUT} w-full`}
      >
        <option value="" disabled>Pick a workflow</option>
        {workflows?.map((w) => <option key={w.id} value={w.name}>Workflow {w.name}</option>)}
      </select>
      {workflows?.length === 0 && (
        <p className="text-[11px] text-warning">This project has no workflows yet. Add one under Workflows first.</p>
      )}
      <p className="text-[11px] leading-relaxed text-text-faint">
        Each release runs the workflow&apos;s steps; one must be a{' '}
        <code className="text-text-dim">{'"service": true'}</code> serving the port. Steps that use the volume
        need <code className="text-text-dim">{'"volume"'}</code>, and run only once the old release has let it go.
        An admin port is one only you can open, as the release&apos;s preview; the internet never reaches it.
        A following site deploys whenever one of its branches moves, so whoever can push one, the project&apos;s
        agents included, publishes the site unless the remote&apos;s branch protection stops them. What fails to
        deploy leaves the last good release serving.
      </p>
      {save.error && <p className="text-xs text-red-400">{save.error.message}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={TEXT_BUTTON}>Cancel</button>
        <button
          type="submit"
          disabled={save.isPending || blocked !== null || hostname.trim() === '' || workflow === ''
            || (site === undefined && name.trim() === '')}
          title={blocked ?? undefined}
          className={BUTTON}
        >
          {save.isPending ? 'Saving…' : site !== undefined ? 'Save' : 'Create'}
        </button>
      </div>
    </form>
  )
}
