import { useState, type FormEvent, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApprovalDetails } from '#components/ApprovalDetails'
import { api } from '#lib/api'
import { MoreIcon, SiteIcon } from '#lib/icons'
import { durationText, relativeAge } from '#lib/time'
import { useVolumes } from '#lib/volumes'
import { useIsAdmin, useReadOnly } from '#lib/viewer'
import { useSnapshotSelect } from '#lib/useSnapshot'
import { useShallow } from 'zustand/react/shallow'
import { useStartSelection } from '#lib/useStartSelection'
import { useUiStore } from '#lib/store'
import type { RepoPick } from '#lib/newWorkspace'
import { siteEdgeOf } from '@yaac/shared/site-edge'
import { formatCommits } from '@yaac/shared/steps'
import { formatDuration } from '@yaac/shared/schedule'
import { DEPLOY_TIMEOUT_FORMAT, parseDeployTimeout } from '@yaac/shared/types'
import type {
  ProjectSummary, SiteCommit, SiteDeployPhase, SiteEdge, SiteEdgeStatus, SiteEntry, SiteSummary, SiteTailnetState,
} from '@yaac/shared/types'
import {
  YBadge, YButton, YCheckbox, YConfirm, YEmptyState, YInput, YListRow, YMenu, YMenuItem, YMenuPopup, YPageBody, YSection, YSelect,
  YSettingGroup, YSettingRow, YSwitch,
} from '#ui'

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

/** Who asked for a requested deploy, as its pane and review say it. */
const REQUESTER: Record<NonNullable<SiteEntry['requested']>['from'], string> = {
  agent: 'An agent',
  following: 'Following',
  person: 'A deploy of content no person approved',
}

const UNPUBLISHED = 'Unpublished: only you reach it, as its release’s preview.'

/** Commits per repo: `<dir>@<short>` each, bare for a lone repo. */
const short = (commits: SiteCommit[]): string => formatCommits(commits, 8)

/** A site's state in a few words, for its sidebar row. */
export function siteState(site: SiteSummary): string {
  if (site.deploy !== undefined) return site.deploy.replacing ? 'replacing its release' : PHASE[site.deploy.phase]
  if (site.awaitingApproval === true) return 'awaiting approval'
  if (site.live !== undefined) return site.published ? 'serving' : 'previewing'
  if (site.lastDeploy?.outcome === 'failed') return 'deploy failed'
  return 'not serving'
}

type Action = 'deploy' | 'approve' | 'publish' | 'unpublish' | 'stop' | 'delete'

/** What can be done to a site, from its sidebar row or its pane. */
export interface SiteActions {
  /** Ask, then act. `approve` reviews the deploy waiting for approval. */
  ask: (action: Action) => void
  start: () => void
  edit: () => void
  /** The owner deploys, starts and edits an unpublished site; a published
   *  one, and publishing, need an admin. Stop, Unpublish and Delete need
   *  the owner or an admin. */
  canDeploy: boolean
  canPublish: boolean
  canEnd: boolean
  error: string | null
  dialog: JSX.Element
}

/** A site's actions (docs/public-sites.md). A deploy of a site that does
 *  not follow its branches asks which ref of each repo to deploy. A review
 *  shows the requested deploy as it was when opened, and approves exactly
 *  that. */
export function useSiteActions(site: SiteSummary): SiteActions {
  const admin = useIsAdmin()
  const readOnly = useReadOnly()
  const openObject = useUiStore((s) => s.openObject)
  const [confirm, setConfirm] = useState<Action | null>(null)
  const [refs, setRefs] = useState<Record<string, string>>({})
  const [hostname, setHostname] = useState('')
  const [reviewing, setReviewing] = useState<SiteEntry['requested']>(undefined)
  const siteDomain = useSiteEdge()?.siteDomain
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
        case 'approve': {
          if (reviewing === undefined) return
          await api.site.deploy.$post({ json: { ...json, approve: { workflowId: reviewing.workflowId, commits: reviewing.commits } } })
          return
        }
        case 'publish': {
          const release = site.live?.workspaceId
          await api.site.publish.$post({ json: { ...json, hostname: hostname.trim(), ...(release !== undefined ? { release } : {}) } })
          return
        }
        case 'unpublish': await api.site.unpublish.$post({ json }); return
        case 'start': await api.site.start.$post({ json }); return
        case 'stop': await api.site.stop.$post({ json }); return
        case 'delete': await api.site.delete.$post({ json })
      }
    },
    onSuccess: () => setConfirm(null),
  })
  const canPublish = admin && !readOnly
  return {
    ask: (action) => {
      act.reset()
      setRefs({})
      setHostname(site.hostname ?? '')
      if (action !== 'approve') {
        setConfirm(action)
        return
      }
      // Freeze what the review shows: that is what gets approved.
      void api.site.show.$get({ query: json }).then((e) => {
        setReviewing(e.requested)
        setConfirm('approve')
      })
    },
    start: () => act.mutate('start'),
    edit: () => openObject(site.projectId, { kind: 'site', id: site.name, edit: true }),
    canDeploy: !readOnly && (!site.published || canPublish),
    canPublish,
    canEnd: admin || !readOnly,
    error: confirm === null && act.error ? act.error.message : null,
    dialog: (
      <YConfirm
        open={confirm !== null}
        onOpenChange={(open) => { if (!open) { setConfirm(null); act.reset() } }}
        {...confirmText(confirm, site.name)}
        busy={act.isPending}
        blocked={confirm === 'publish' && hostname.trim() === ''}
        error={act.error?.message ?? (confirm === 'approve' && reviewing === undefined ? 'Nothing is waiting for approval now' : undefined)}
        onConfirm={() => { if (confirm !== null) act.mutate(confirm) }}
      >
        {(confirm === 'deploy' || confirm === 'approve') && (
          <p className="mt-3 text-sm text-subtle">{site.edge !== undefined ? EDGE_REACH[site.edge] : UNPUBLISHED}</p>
        )}
        {confirm === 'approve' && reviewing !== undefined && (
          <>
            <p className="mt-3 text-sm text-subtle">
              {REQUESTER[reviewing.from]} asked to deploy this. Approving deploys exactly these commits with this
              workflow, approving them for this site&apos;s settings; it approves no branch.
              {reviewing.changes.length > 0 && ` It changes the live release's ${reviewing.changes.join(', ')}.`}
            </p>
            <ApprovalDetails request={reviewing} />
          </>
        )}
        {confirm === 'publish' && (
          <>
            <YInput
              aria-label="Hostname"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder={siteDomain !== undefined ? `app.${siteDomain}` : 'app.example.com'}
              className="mt-3 w-full font-mono"
            />
            {hostname.trim() !== '' && (
              <p className="mt-2 text-sm text-subtle">{EDGE_REACH[siteEdgeOf(hostname.trim(), siteDomain)]}</p>
            )}
            <p className="mt-2 text-sm text-subtle">
              {site.live !== undefined
                ? <>It goes live serving release {short(site.live.commits)}, the one you can preview now.</>
                : 'It serves nothing until it is deployed.'}
            </p>
          </>
        )}
        {confirm === 'deploy' && site.follow && (
          <p className="mt-3 text-sm text-subtle">It follows its branches, so it deploys their tips.</p>
        )}
        {confirm === 'deploy' && !site.follow && entry?.repos.map((r) => (
          <YInput
            key={r.dir}
            aria-label={`Ref to deploy ${r.dir} at`}
            value={refs[r.dir] ?? ''}
            onChange={(e) => setRefs({ ...refs, [r.dir]: e.target.value })}
            placeholder={`${r.dir}: branch or commit (default: ${r.branch ?? r.commit?.slice(0, 8) ?? ''})`}
            className="mt-3 w-full font-mono"
          />
        ))}
      </YConfirm>
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
      description: 'A new release runs the site’s workflow at these commits and takes over once it is ready.',
      confirmLabel: 'Deploy',
      destructive: false,
    }
    case 'approve': return {
      title: `Approve and deploy “${site}”?`,
      description: 'Review what runs: a new release runs this workflow at these commits, with its run secrets, and takes over once it is ready.',
      confirmLabel: 'Approve and deploy',
      destructive: false,
    }
    case 'publish': return {
      title: `Publish “${site}”?`,
      description: 'Its hostname is routed to the release it serves, and to each release it deploys from now on.',
      confirmLabel: 'Publish',
      destructive: false,
    }
    case 'unpublish': return {
      title: `Unpublish “${site}”?`,
      description: 'Its hostname stops answering and is let go; its release keeps running for your preview.',
      confirmLabel: 'Unpublish',
      destructive: true,
    }
    case 'stop': return {
      title: `Stop “${site}”?`,
      description: 'Its live release stops, and a published site’s hostname answers 503 until it is started again.',
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
 * row. The bar holds Deploy and Stop or Start, and Edit, Publish,
 * Unpublish and Delete. The body shows its address and who reaches it (or
 * that it is unpublished), its live release, a deploy in progress, one
 * waiting for approval, the last deploy and what following is doing, and
 * its recent releases. With `site` absent, or `editing`, it is the site's form.
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
      <div className="flex h-full flex-col bg-surface">
        {bar !== null && createPortal(
          <span className="titlebar-drag flex min-w-0 flex-1 items-center gap-1.5">
            <SiteIcon size={12} className="shrink-0 text-subtle" />
            <h2 className="min-w-0 truncate font-medium text-text">{site !== undefined ? `Edit “${site.name}”` : 'New site'}</h2>
          </span>,
          bar,
        )}
        <YPageBody>
          <SiteForm project={project} {...(site !== undefined ? { site: site.name } : {})} onDone={done} onCancel={() => done(site?.name)} />
        </YPageBody>
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
  const workflow = useSnapshotSelect((s) => s?.workflows.find((w) => w.projectId === site.projectId && w.name === site.workflow))
  // Refetched whenever the snapshot's summary of it changes.
  const { data: detail } = useQuery({
    queryKey: ['site', site.projectId, site.name, JSON.stringify(site)],
    queryFn: () => api.site.show.$get({ query: { project: site.projectId, name: site.name } }),
  })
  const { live, deploy, lastDeploy } = site
  const release = (workspaceId: string, commits: SiteCommit[]): JSX.Element => (
    <YButton variant="link" onClick={() => openWorkspace(site.projectId, workspaceId)} className="font-mono text-md">
      {short(commits)}
    </YButton>
  )

  return (
    <div className="flex h-full flex-col bg-surface">
      {bar !== null && createPortal(
        <>
          <span className="titlebar-drag flex min-w-0 flex-1 items-center gap-1.5">
            <SiteIcon size={12} className="shrink-0 text-subtle" />
            <h2 className="min-w-0 truncate font-medium text-text">{site.name}</h2>
            {actions.error !== null && <span className="truncate text-danger" title={actions.error}>{actions.error}</span>}
          </span>
          {actions.canDeploy && deploy === undefined && (
            <YButton variant="ghost" size="sm" onClick={() => actions.ask('deploy')} className="no-drag">Deploy</YButton>
          )}
          {actions.canEnd && live !== undefined && (
            <YButton variant="ghost" size="sm" onClick={() => actions.ask('stop')} className="no-drag">Stop</YButton>
          )}
          {actions.canDeploy && live === undefined && deploy === undefined && lastDeploy !== undefined && (
            <YButton variant="ghost" size="sm" onClick={actions.start} className="no-drag">Start</YButton>
          )}
          {actions.canEnd && (
            <YMenu.Root>
              <YMenu.Trigger
                render={<YButton variant="ghost" size="sm" icon={MoreIcon} aria-label="Site actions" title="Site actions" className="no-drag" />}
              />
              <YMenuPopup side="bottom" align="end" sideOffset={4} className="min-w-[140px]">
                {actions.canDeploy && <YMenuItem onClick={actions.edit}>Edit…</YMenuItem>}
                {actions.canPublish && (
                  <YMenuItem onClick={() => actions.ask('publish')}>{site.published ? 'Move…' : 'Publish…'}</YMenuItem>
                )}
                {site.published && <YMenuItem onClick={() => actions.ask('unpublish')}>Unpublish…</YMenuItem>}
                <YMenuItem onClick={() => actions.ask('delete')}>Delete…</YMenuItem>
              </YMenuPopup>
            </YMenu.Root>
          )}
          {actions.dialog}
        </>,
        bar,
      )}
      <YPageBody>
        {site.hostname !== undefined && site.edge !== undefined ? (
          <YSection title="Address" description={EDGE_REACH[site.edge]}>
            <YSettingGroup>
              <YSettingRow
                label={(
                  <a href={`https://${site.hostname}`} target="_blank" rel="noreferrer noopener" className="font-mono hover:underline">
                    https://{site.hostname}
                  </a>
                )}
                hint={site.edge === 'public' && <>
                  It answers once the install&apos;s Cloudflare tunnel has a public hostname{' '}
                  <code className="text-muted">{site.hostname}</code> whose service is the router
                  (<code className="text-muted">yaac-site-router</code>, port 8080).
                  {edge?.cloudflare === 'absent' && (
                    <span className="mt-1 block text-warning">
                      This install has no tunnel, so no site is reachable from the internet. Set one up with{' '}
                      <code className="text-muted">CF_TUNNEL_TOKEN=… yaac cluster install</code>.
                    </span>
                  )}
                </>}
              >
                {edge !== undefined && <EdgeBadge edge={edge} siteEdge={site.edge} />}
              </YSettingRow>
            </YSettingGroup>
          </YSection>
        ) : (
          <YSection
            title="Address"
            description={<>
              {UNPUBLISHED} The project&apos;s agents may build and deploy it; once published, a deploy you did not
              make waits for your approval.
            </>}
          />
        )}

        <YSection title="Status">
          <YSettingGroup>
            <YSettingRow
              label="Live"
              hint={live !== undefined && (detail?.live?.running === false ? 'Replacing' : `Deployed ${relativeAge(live.since)}`)}
            >
              {live !== undefined ? release(live.workspaceId, live.commits) : <YBadge>Not serving</YBadge>}
            </YSettingRow>
            {deploy !== undefined && (
              <YSettingRow label={deploy.replacing ? 'Replacing the release' : 'Deploying'} hint={PHASE[deploy.phase]}>
                {release(deploy.workspaceId, deploy.commits)}
              </YSettingRow>
            )}
            {detail?.requested !== undefined && (
              <YSettingRow
                label="Awaiting approval"
                hint={`${REQUESTER[detail.requested.from]} asked to deploy this ${relativeAge(detail.requested.at)}`}
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono text-md text-warning">{short(detail.requested.commits)}</span>
                  {actions.canDeploy && deploy === undefined && (
                    <YButton size="sm" onClick={() => actions.ask('approve')}>Review…</YButton>
                  )}
                </span>
              </YSettingRow>
            )}
            {lastDeploy !== undefined && (
              <YSettingRow
                label="Last deploy"
                hint={(
                  <span className={lastDeploy.outcome === 'failed' ? 'text-danger' : undefined}>
                    {lastDeploy.outcome} {relativeAge(lastDeploy.finishedAt)}{lastDeploy.error !== undefined && `: ${lastDeploy.error}`}
                  </span>
                )}
              >
                {release(lastDeploy.workspaceId, lastDeploy.commits)}
              </YSettingRow>
            )}
            {detail?.followPaused !== undefined && (
              <YSettingRow label="Following" hint={detail.followPaused}><YBadge tone="warning">Paused</YBadge></YSettingRow>
            )}
            {detail?.followSkipped !== undefined && (
              <YSettingRow label="Not retrying" hint={`${short(detail.followSkipped)}, whose deploy failed; deploy to retry it`} />
            )}
          </YSettingGroup>
        </YSection>

        {detail !== undefined && (
          <YSection title="Releases" description="Newest first. Each opens its workspace.">
            {detail.releases.length === 0 ? <YEmptyState compact title="No releases yet" className="py-4" /> : (
              <div className="border-t border-line">
                {detail.releases.map((r) => (
                  <YListRow
                    key={r.workspaceId}
                    label={`Open the release of ${short(r.commits)}`}
                    onSelect={() => openWorkspace(site.projectId, r.workspaceId)}
                    leading={<span className="ml-1.5 w-28 shrink-0 text-md text-subtle">{relativeAge(r.createdAt)}</span>}
                    title={<span className="font-mono">{short(r.commits)}</span>}
                    sub={r.stoppedAt !== undefined ? <YBadge>stopped</YBadge> : <YBadge tone="success">running</YBadge>}
                  />
                ))}
              </div>
            )}
          </YSection>
        )}

        {detail !== undefined && (
          <YSection title="Settings">
            <YSettingGroup>
              <Fact label="Workflow">
                {workflow !== undefined
                  ? (
                    <YButton variant="link" onClick={() => openObject(site.projectId, { kind: 'workflow', id: workflow.id })} className="text-md">
                      {site.workflow}
                    </YButton>
                  )
                  : site.workflow}
              </Fact>
              <Fact label="Port"><span className="font-mono">{detail.port}</span></Fact>
              {detail.adminPort !== undefined && <Fact label="Admin port"><span className="font-mono">{detail.adminPort}</span></Fact>}
              <Fact label="Deploy timeout">{formatDuration(detail.deployTimeoutMinutes)}</Fact>
              <Fact label="Repos">
                <span className="font-mono">{detail.repos.map((r) => `${r.dir}@${r.branch ?? r.commit?.slice(0, 8) ?? '?'}`).join(' ')}</span>
              </Fact>
              <Fact label="Follows">{detail.follow ? 'Yes: it deploys whenever one of these branches moves' : 'No'}</Fact>
              {detail.volume !== undefined && <Fact label="Volume">{detail.volume}</Fact>}
            </YSettingGroup>
          </YSection>
        )}
      </YPageBody>
    </div>
  )
}

/** A read-only setting: its name, and its value on the right. */
function Fact({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return <YSettingRow label={label}><span className="text-md text-muted">{children}</span></YSettingRow>
}

/** The state of the install's tunnel for a site of `siteEdge`. */
function EdgeBadge({ edge, siteEdge }: { edge: SiteEdgeStatus; siteEdge: SiteEdge }): JSX.Element {
  if (siteEdge === 'tailnet') {
    return <YBadge tone={edge.tailnet === 'ready' ? 'success' : 'warning'}>{TAILNET_STATE[edge.tailnet]}</YBadge>
  }
  if (edge.cloudflare === 'absent') return <YBadge tone="warning">No Cloudflare tunnel</YBadge>
  return <YBadge tone={edge.cloudflare === 'connected' ? 'success' : 'danger'}>Cloudflare tunnel {edge.cloudflare}</YBadge>
}

/**
 * Create a site, unpublished, or edit how the one named `site` is built.
 * Its releases start with the repos ticked, each at the branch or full
 * commit its field names, which starts empty: which branch is deployed is
 * the owner's choice. They run
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
  if (editing !== undefined && site === undefined) return <p className="text-md text-subtle">Loading…</p>
  return <SiteFields project={project} {...(site !== undefined ? { site } : {})} onDone={onDone} {...(onCancel !== undefined ? { onCancel } : {})} />
}

function SiteFields({ project, site, onDone, onCancel }: {
  project: ProjectSummary
  site?: SiteEntry
  onDone: (name: string) => void
  onCancel?: () => void
}): JSX.Element {
  const projectId = project.id
  const queryClient = useQueryClient()
  const volumes = useVolumes(projectId)
  const workflows = useSnapshotSelect(useShallow((s) => (s?.workflows ?? []).filter((w) => w.projectId === projectId)))
  const openObject = useUiStore((s) => s.openObject)
  const admin = useIsAdmin()
  const [name, setName] = useState('')
  const [port, setPort] = useState(site !== undefined ? String(site.port) : '')
  const [adminPort, setAdminPort] = useState(site?.adminPort !== undefined ? String(site.adminPort) : '')
  const [volume, setVolume] = useState(site?.volume ?? '')
  const [follow, setFollow] = useState(site?.follow ?? false)
  const [deployTimeout, setDeployTimeout] = useState(site !== undefined ? durationText(site.deployTimeoutMinutes) : '')
  // Blank means the default when creating; an edit must name one.
  const deployTimeoutMinutes = deployTimeout.trim() === '' ? undefined : parseDeployTimeout(deployTimeout)
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
  const blocked = site?.published === true && !admin ? 'Only an admin of this yaac install can change a published site'
    : selection.included.length === 0 ? 'Tick a repo'
    : selection.included.some((r) => r.branch.trim() === '') ? 'Give each repo a branch or a full commit'
    : workflow === '' ? 'Pick a workflow'
    : deployTimeoutMinutes === undefined && (site !== undefined || deployTimeout.trim() !== '')
      ? `Give the deploy timeout as ${DEPLOY_TIMEOUT_FORMAT}`
    : site === undefined && name.trim() === '' ? 'Name the site'
    : null

  const save = useMutation({
    mutationFn: async () => {
      const repos = selection.request.repos
      const body = { project: projectId, port: Number(port), workflow, repos, follow, deployTimeoutMinutes }
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
    // The site's detail is cached by its snapshot summary, which carries
    // none of its settings, so a saved edit would otherwise read stale.
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['site', projectId] })
      onDone(saved)
    },
  })
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    save.mutate()
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <YSettingGroup>
        {site === undefined && (
          <YSettingRow label="Name">
            <YInput aria-label="Site name" value={name} onChange={(e) => setName(e.target.value)} placeholder="app" className="w-56" />
          </YSettingRow>
        )}
        <YSettingRow label="Port" hint="The port each release serves.">
          <YInput aria-label="Port" value={port} onChange={(e) => setPort(e.target.value)} placeholder="3000" inputMode="numeric" className="w-24" />
        </YSettingRow>
        <YSettingRow label="Admin port" hint="A port of each release that only you can reach, as a preview or with yaac forward.">
          <YInput
            aria-label="Admin port"
            value={adminPort}
            onChange={(e) => setAdminPort(e.target.value)}
            placeholder="none"
            inputMode="numeric"
            className="w-24"
          />
        </YSettingRow>
        <YSettingRow label="Deploy timeout" hint="A deploy fails if its release is not ready this long after it starts.">
          <YInput
            aria-label="Deploy timeout"
            value={deployTimeout}
            onChange={(e) => setDeployTimeout(e.target.value)}
            placeholder="1h"
            className="w-24"
          />
        </YSettingRow>
        <YSettingRow label="Volume">
          <YSelect aria-label="Volume" value={volume} onChange={(e) => setVolume(e.target.value)} className="w-36">
            <option value="">No volume</option>
            {volumes?.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
          </YSelect>
        </YSettingRow>
        <YSettingRow label="Workflow" hint="Each release runs its steps; one must be a service serving the port.">
          <YSelect
            aria-label="Workflow"
            value={workflow}
            onChange={(e) => {
              if (e.target.value === NEW_WORKFLOW) openObject(projectId, { kind: 'workflow', id: '' })
              else setWorkflow(e.target.value)
            }}
            className="w-56"
          >
            <option value="" disabled>Pick a workflow</option>
            {workflows.map((w) => <option key={w.id} value={w.name}>{w.name}</option>)}
            <option value={NEW_WORKFLOW}>+ New workflow…</option>
          </YSelect>
        </YSettingRow>
        <YSettingRow stacked label="Repos" hint="What each release starts with: one at its root, several in their folders.">
          <div role="group" aria-label="Repos" className="flex flex-col gap-1">
            {selection.rows.map((row) => (
              <div key={row.repo.id} className="flex items-center gap-2">
                <YCheckbox
                  aria-label={`Include ${row.repo.dir}`}
                  checked={row.included}
                  onCheckedChange={(included) => pick(row.repo.id, { included })}
                  className="w-28 shrink-0 truncate font-mono"
                >
                  {row.repo.dir}
                </YCheckbox>
                {row.included && <>
                  <YInput
                    aria-label={`Branch or commit of ${row.repo.dir}`}
                    value={row.branch}
                    onChange={(e) => pick(row.repo.id, { branch: e.target.value })}
                    placeholder="branch or full commit"
                    list={`site-branches-${row.repo.id}`}
                    className="flex-1 font-mono"
                  />
                  <datalist id={`site-branches-${row.repo.id}`}>
                    {row.branches?.map((b) => <option key={b} value={b} />)}
                  </datalist>
                </>}
              </div>
            ))}
          </div>
        </YSettingRow>
        <YSettingRow label="Follow" hint="Deploy whenever a branch above moves.">
          <YSwitch aria-label="Follow" checked={follow} onCheckedChange={setFollow} />
        </YSettingRow>
      </YSettingGroup>
      <p className="text-sm leading-relaxed text-subtle">
        Steps that use the volume need <code className="text-muted">{'"volume"'}</code>, and run only once the old
        release has let it go. An admin port is one only you can open, as the release&apos;s preview; the internet
        never reaches it. A new site is unpublished until you publish it at a hostname. A following site deploys
        whenever one of its branches moves, so once it is published, whoever can push one, the project&apos;s agents
        included, publishes what they push unless the remote&apos;s branch protection stops them. A change here is
        new settings, so a published site&apos;s next deploy waits for your approval. What fails to deploy leaves
        the last good release serving.
      </p>
      {save.error && <p className="text-md text-danger">{save.error.message}</p>}
      <div className="flex justify-end gap-2">
        {onCancel !== undefined && <YButton variant="ghost" onClick={onCancel}>Cancel</YButton>}
        <YButton variant="primary" type="submit" disabled={save.isPending || blocked !== null} title={blocked ?? undefined}>
          {save.isPending ? 'Saving…' : site !== undefined ? 'Save' : 'Create site'}
        </YButton>
      </div>
    </form>
  )
}

/** The workflow picker's "+ New workflow…" option. */
const NEW_WORKFLOW = '\u0000new'
