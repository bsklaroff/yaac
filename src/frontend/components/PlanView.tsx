import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import { useUiStore } from '@/frontend/store'
import { fetchPlans, fetchPlanDoc, newPlan, continuePlan, promotePlan } from '@/frontend/lib/plansApi'
import { splitFrontmatter } from '@/shared/plan-docs'
import { SessionView } from './SessionView'
import { InputDialog } from './ui/InputDialog'
import { Pane, PaneHeader, PaneTitle } from './ui/Pane'
import {
  SidebarShell,
  SidebarHeader,
  SidebarTitle,
  SidebarBody,
  SidebarGroup,
  SidebarRow,
  SidebarEmpty,
} from './ui/SidebarChrome'
import { WorkspaceBar, BarIconButton } from './ui/WorkspaceBar'
import { AddIcon, LoadingIcon, SidebarIcon, TabsIcon, TilesIcon } from '@/frontend/lib/icons'
import type { LayoutNode } from '@/frontend/lib/layout'
import type { DaemonSnapshot, PlanDocEntry, PlanPhase, SessionListEntry } from '@/shared/types'

const PHASE_LABEL: Record<PlanPhase, string> = {
  plan: 'Plan',
  build: 'Build',
  review: 'Review',
}

/** Layout-tree target for the rendered-doc pane inside the workspace. */
const DOC_TARGET = 'doc'

/** First-open arrangement for a grill session: agent on the left, doc on
 *  the right. */
const PLAN_DEFAULT_LAYOUT: LayoutNode = {
  type: 'split',
  dir: 'row',
  ratio: 0.45,
  a: { type: 'leaf', target: 'agent' },
  b: { type: 'leaf', target: DOC_TARGET },
}

/** The rendered plan doc (frontmatter stripped), shared by the workspace
 *  doc pane and the no-session fallback card. */
function DocBody({
  docQuery,
}: {
  docQuery: { data?: { content: string }; isLoading: boolean }
}): JSX.Element {
  return (
    <div className="plan-md min-h-0 flex-1 overflow-y-auto px-6 py-4">
      {docQuery.data
        ? <ReactMarkdown>{splitFrontmatter(docQuery.data.content)?.body ?? docQuery.data.content}</ReactMarkdown>
        : (
            <div className="text-sm text-text-faint">
              {docQuery.isLoading ? 'Loading…' : 'The document will appear as the agent writes it.'}
            </div>
          )}
    </div>
  )
}

/**
 * The Plan tab: wiki plan docs on the left, the rendered document in the
 * middle, and — when the selected doc has a live plan-mode session — that
 * session's agent terminal on the right (the grill loop: answer in the
 * terminal, watch the doc re-render).
 */
export function PlanView({
  projectSlug,
  sessions,
  snapshot,
}: {
  projectSlug: string | null
  sessions: SessionListEntry[]
  /** Full daemon snapshot, passed through to the embedded workspace. */
  snapshot: DaemonSnapshot | undefined
}): JSX.Element {
  const selectedDocPath = useUiStore((s) => s.selectedDocPath)
  const selectDoc = useUiStore((s) => s.selectDoc)
  const sidebarOpen = useUiStore((s) => s.sidebarOpen)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const viewMode = useUiStore((s) => s.viewMode)
  const setViewMode = useUiStore((s) => s.setViewMode)
  const queryClient = useQueryClient()

  const [newPlanOpen, setNewPlanOpen] = useState(false)
  /** In-flight new-plan/promote progress message (one op at a time). */
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Session just spawned by this tab — embeddable before the snapshot
   *  catches up (and before a brand-new plan's doc file even exists). */
  const [spawned, setSpawned] = useState<{ sessionId: string; doc: string } | null>(null)

  const plansQuery = useQuery({
    queryKey: ['plans', projectSlug],
    queryFn: () => fetchPlans(projectSlug!),
    enabled: !!projectSlug,
    refetchInterval: 4000,
  })
  const plans = plansQuery.data
  const docs = plans?.docs ?? []

  // Auto-select: keep a valid selection whenever docs exist.
  useEffect(() => {
    if (docs.length === 0) return
    if (selectedDocPath && docs.some((d) => d.path === selectedDocPath)) return
    selectDoc(docs[0].path)
  }, [docs, selectedDocPath, selectDoc])

  const docQuery = useQuery({
    queryKey: ['plan-doc', projectSlug, selectedDocPath],
    queryFn: () => fetchPlanDoc(projectSlug!, selectedDocPath!),
    enabled: !!projectSlug && !!selectedDocPath,
    refetchInterval: 3000,
    retry: false,
  })

  // The live plan-mode session working on the selected doc. Freshest-draft
  // session first, then the container label (most robust — every plan-mode
  // spawn carries it), then frontmatter links, then a session this tab
  // just spawned for the doc.
  const liveById = new Map(sessions.map((s) => [s.sessionId, s]))
  const selected = docs.find((d) => d.path === selectedDocPath)
  const draftId = docQuery.data?.draftSessionId ?? selected?.draftSessionId
  const labeled = sessions.find((s) => s.planDoc === selectedDocPath)
  const linkedLive = selected?.sessions.find((id) => liveById.has(id))
  const terminalSessionId =
    // A session just spawned from this tab wins — with several sessions on
    // one doc (e.g. repeated promotes) the newest is the one to show.
    (spawned && spawned.doc === selectedDocPath && liveById.has(spawned.sessionId)
      ? spawned.sessionId
      : undefined)
    ?? (draftId && liveById.has(draftId) ? draftId : undefined)
    ?? labeled?.sessionId
    ?? linkedLive
    ?? (spawned && spawned.doc === selectedDocPath ? spawned.sessionId : undefined)
  // The embedded workspace needs the session in the snapshot (it reads the
  // session entry, terminals, layout). A just-spawned id shows a starting
  // placeholder until the snapshot catches up (seconds).
  const workspaceSessionId =
    terminalSessionId && liveById.has(terminalSessionId) ? terminalSessionId : undefined

  const runOp = (op: Promise<{ sessionId: string; doc: string }>): void => {
    setError(null)
    setBusy('starting…')
    op.then((result) => {
      setSpawned({ sessionId: result.sessionId, doc: result.doc })
      selectDoc(result.doc)
      void queryClient.invalidateQueries({ queryKey: ['plans', projectSlug] })
    }).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
    }).finally(() => {
      setBusy(null)
    })
  }

  // Doc-pane actions (its header in tiles mode, the strip end in tabs
  // mode, the fallback card when there's no session): promote / spawn
  // another build session, and — for session-less docs — resume planning.
  const ACTION_BTN = 'flex h-5 shrink-0 items-center rounded px-2 text-[11px] font-medium transition disabled:opacity-40'
  const promoteAction = selected && projectSlug ? (
    <button
      onClick={() => { runOp(promotePlan(projectSlug, selected.path, (m) => setBusy(m))) }}
      disabled={busy !== null}
      className={`${ACTION_BTN} bg-accent/15 text-accent hover:bg-accent/25`}
    >
      {busy !== null ? 'Working…' : selected.phase === 'plan' ? 'Promote to Build' : 'New build session'}
    </button>
  ) : null
  const continueAction = selected && projectSlug && selected.phase === 'plan' && !terminalSessionId ? (
    <button
      onClick={() => { runOp(continuePlan(projectSlug, selected.path, (m) => setBusy(m))) }}
      disabled={busy !== null}
      className={`${ACTION_BTN} bg-surface-2 text-text-dim hover:bg-surface-3 hover:text-text`}
    >
      Start plan session
    </button>
  ) : null
  const docActions = (promoteAction ?? continueAction) ? (
    <span className="flex shrink-0 items-center gap-1.5">
      {continueAction}
      {promoteAction}
    </span>
  ) : null

  if (!projectSlug) {
    return <Empty>Select a project to see its plans.</Empty>
  }
  if (plansQuery.isLoading) {
    return <Empty>Loading plans…</Empty>
  }
  if (plansQuery.isError) {
    return <Empty>Could not load plans: {plansQuery.error.message}</Empty>
  }
  if (plans && !plans.available) {
    return (
      <Empty>
        <div className="max-w-md text-center">
          <div className="mb-1 font-medium text-text-dim">Plan mode needs a GitHub wiki</div>
          <div className="text-sm">{plans.reason}</div>
        </div>
      </Empty>
    )
  }

  return (
    // Same skeleton as the Build tab: toggleable flush sidebar, a
    // WorkspaceBar with the entity title + actions, and floating Pane
    // cards below. Only the contents differ.
    <div className="flex min-h-0 flex-1">
      {/* Doc list */}
      {sidebarOpen && (
        <SidebarShell>
          <SidebarHeader>
            <SidebarTitle>Plans</SidebarTitle>
            <BarIconButton
              title="New plan"
              onClick={() => setNewPlanOpen(true)}
              disabled={busy !== null}
              className="ml-auto"
            >
              {busy !== null ? <LoadingIcon size={13} className="animate-spin" /> : <AddIcon size={14} />}
            </BarIconButton>
          </SidebarHeader>
          <SidebarBody>
            {(['plan', 'build', 'review'] as PlanPhase[]).map((phase) => {
              const group = docs.filter((d) => d.phase === phase)
              if (group.length === 0) return null
              return (
                <SidebarGroup key={phase} label={PHASE_LABEL[phase]} count={group.length}>
                  {group.map((d) => (
                    <DocRow
                      key={d.path}
                      doc={d}
                      selected={d.path === selectedDocPath}
                      onSelect={() => selectDoc(d.path)}
                    />
                  ))}
                </SidebarGroup>
              )
            })}
            {docs.length === 0 && (
              <SidebarEmpty>No plan docs yet — start one with +.</SidebarEmpty>
            )}
          </SidebarBody>
          {error && (
            <div className="px-4 py-2 text-xs text-[#d65858]">{error}</div>
          )}
        </SidebarShell>
      )}

      <main className="flex h-full min-w-0 flex-1 flex-col">
        {/* Doc bar — mirrors the session bar: toggle, title, actions. */}
        <WorkspaceBar>
          {!sidebarOpen && (
            <BarIconButton title="Open sidebar" onClick={toggleSidebar}>
              <SidebarIcon size={14} />
            </BarIconButton>
          )}
          {/* No doc title/phase here — the sidebar row and the doc pane's
              header already carry them; the bar is workspace controls. */}
          <span className="flex-1" />
          {workspaceSessionId && (
            <BarIconButton
              tone="dim"
              title={viewMode === 'tiles' ? 'Switch to tabs' : 'Switch to tiles'}
              onClick={() => setViewMode(viewMode === 'tiles' ? 'tabs' : 'tiles')}
            >
              {viewMode === 'tiles' ? <TabsIcon size={13} /> : <TilesIcon size={13} />}
            </BarIconButton>
          )}
        </WorkspaceBar>

        <div className="flex min-h-0 flex-1 p-2 pt-0">
          {workspaceSessionId ? (
            // The doc's live session: one workspace running the same window
            // manager as the Build tab. The rendered doc is just another
            // pane in it (a tab in tabs mode, a tile in tiles mode) — the
            // default tree is doc | agent side by side.
            <div className="min-h-0 min-w-0 flex-1">
              <SessionView
                snapshot={snapshot}
                sessionIdOverride={workspaceSessionId}
                hideBar
                layoutKey={`plan:${workspaceSessionId}`}
                defaultLayout={PLAN_DEFAULT_LAYOUT}
                extraPanes={[{
                  target: DOC_TARGET,
                  name: selected?.path ?? 'Document',
                  render: () => <DocBody docQuery={docQuery} />,
                  actions: docActions,
                }]}
              />
            </div>
          ) : (
            // No live session yet: mirror the workspace's default doc|agent
            // arrangement — the doc stays readable, and while a spawn is
            // provisioning a placeholder Agent pane streams progress where
            // the terminal will land.
            <div className="flex min-h-0 min-w-0 flex-1 gap-2">
              <Pane className="min-h-0 min-w-0 flex-[11]">
                {selected || spawned ? (
                  <>
                    <PaneHeader>
                      <PaneTitle>{selected?.path ?? spawned?.doc ?? 'Document'}</PaneTitle>
                      {docActions}
                    </PaneHeader>
                    <DocBody docQuery={docQuery} />
                  </>
                ) : (
                  <Empty>Select a plan, or start a new one.</Empty>
                )}
              </Pane>
              {(busy !== null || terminalSessionId) && (
                <Pane className="min-h-0 min-w-0 flex-[9]">
                  <PaneHeader>
                    <PaneTitle>Agent</PaneTitle>
                  </PaneHeader>
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                    <span className="flex items-center gap-2 text-sm text-text">
                      <LoadingIcon size={14} className="animate-spin text-text-dim" />
                      Starting plan session
                    </span>
                    <p className="text-xs text-text-faint">{busy ?? 'waiting for the session…'}</p>
                  </div>
                </Pane>
              )}
            </div>
          )}
        </div>
      </main>

      <InputDialog
        open={newPlanOpen}
        onOpenChange={setNewPlanOpen}
        title="New plan"
        placeholder="What are we planning?"
        confirmLabel="Start grilling"
        onSubmit={(topic) => {
          const trimmed = topic.trim()
          if (!trimmed) return
          runOp(newPlan(projectSlug, trimmed, (message) => setBusy(message)))
        }}
      />
    </div>
  )
}

function DocRow({
  doc,
  selected,
  onSelect,
}: {
  doc: PlanDocEntry
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <SidebarRow onClick={onSelect} selected={selected} className="items-center gap-2">
      <span className="truncate font-medium">{doc.title}</span>
    </SidebarRow>
  )
}

function Empty({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center p-4 text-sm text-text-faint">
      {children}
    </div>
  )
}
