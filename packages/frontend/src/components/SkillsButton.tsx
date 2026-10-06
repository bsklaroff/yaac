import { useEffect, useState, type JSX } from 'react'
import clsx from 'clsx'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { Popover } from '@base-ui/react/popover'
import { BranchIcon, ChevronIcon, SkillsIcon, TOOL_LABEL } from '#lib/icons'
import { BranchPicker } from '#components/BranchPicker'
import { EmptyState } from '#components/ui/EmptyState'
import { MasterDetail } from '#components/ui/MasterDetail'
import { Modal } from '#components/ui/Modal'
import { POPUP } from '#components/ui/menu'
import { api } from '#lib/api'
import { useProjectBranches } from '#lib/useProjectBranches'
import { useIsMobile } from '#lib/viewport'
import { useUiStore } from '#lib/store'
import { AGENT_TOOLS, type AgentTool, type SkillSource, type SkillSummary } from '@yaac/shared/types'

const SOURCE_LABEL: Record<SkillSource, string> = {
  personal: 'Personal',
  plugin: 'Plugin',
  project: 'Project',
  system: 'Built-in',
}

/**
 * List sections. Finer than `source`: `system` skills split into yaac's own
 * (`sourceLabel` `yaac`) and the agent binary's bundled ones.
 */
type SkillGroup = 'personal' | 'plugin' | 'project' | 'yaac' | 'tool'

function skillGroup(s: SkillSummary): SkillGroup {
  if (s.source !== 'system') return s.source
  return s.sourceLabel === 'yaac' ? 'yaac' : 'tool'
}

function groupLabel(group: SkillGroup, tool: AgentTool): string {
  switch (group) {
    case 'personal': return 'Personal'
    case 'plugin': return 'Plugin'
    case 'project': return 'Project'
    case 'yaac': return 'yaac built-in'
    case 'tool': return `${TOOL_LABEL[tool]} built-in`
  }
}

/** A one-line tag row: source, plugin name, and invocation caveats. */
function SkillTags({ skill }: { skill: SkillSummary }): JSX.Element {
  const tags: string[] = [SOURCE_LABEL[skill.source]]
  if (skill.sourceLabel) tags.push(skill.sourceLabel)
  if (!skill.modelInvocable) tags.push('manual only')
  if (!skill.userInvocable) tags.push('model only')
  if (skill.shadowedBy) tags.push(`overridden by ${skill.shadowedBy}`)
  return (
    <span className="flex flex-wrap items-center gap-1">
      {tags.map((t) => (
        <span key={t} className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-faint">
          {t}
        </span>
      ))}
    </span>
  )
}

/** The read-only detail pane for the selected skill: metadata + full SKILL.md. */
function SkillDetailPane(
  { projectId, tool, branch, skill }:
  { projectId: string; tool: AgentTool; branch: string | undefined; skill: SkillSummary },
): JSX.Element {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['skill-body', projectId, tool, branch ?? null, skill.id],
    queryFn: () => api.project[':projectId'].skills.body.$get({
      param: { projectId },
      query: { id: skill.id, tool, ...(branch ? { branch } : {}) },
    }),
    staleTime: 30_000,
  })
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-hairline-soft bg-bg/50 p-4
      max-md:border-0 max-md:bg-transparent max-md:p-0">
      {/* Only the body may shrink; otherwise a long SKILL.md clips the title
          on a short phone screen. */}
      <div className="flex shrink-0 items-baseline gap-2">
        <h3 className="text-sm font-semibold text-text max-md:text-[0.9375rem]">/{skill.name}</h3>
      </div>
      <div className="mt-1 shrink-0"><SkillTags skill={skill} /></div>
      {skill.description && (
        <p className="mt-3 shrink-0 text-xs leading-relaxed text-text-dim">{skill.description}</p>
      )}
      {skill.allowedTools && skill.allowedTools.length > 0 && (
        <p className="mt-2 shrink-0 text-[11px] text-text-faint">
          allowed-tools: <span className="text-text-dim">{skill.allowedTools.join(', ')}</span>
        </p>
      )}
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded bg-bg/80 p-3">
        {isLoading && <p className="text-xs text-text-faint">Loading…</p>}
        {isError && <p className="text-xs text-red-400">Could not load this skill.</p>}
        {data && (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text-dim">
            {data.body.trim() || '(no body)'}
          </pre>
        )}
      </div>
    </div>
  )
}

/**
 * Sidebar-header button for the project's skill viewer, and the full-screen
 * modal it opens. Skills belong to the project, not a workspace, so open state
 * lives in the store.
 *
 * The modal is a searchable master/detail list grouped by source; picking a
 * row shows its full `SKILL.md`. Agent-bundled built-ins are list-only (name
 * and description), with a placeholder body.
 */
export function SkillsButton({ projectId }: { projectId: string }): JSX.Element {
  const open = useUiStore((s) => s.skillsOverlayOpen)
  const openOverlay = useUiStore((s) => s.openSkillsOverlay)
  const closeOverlay = useUiStore((s) => s.closeSkillsOverlay)

  const [queryText, setQueryText] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tool, setTool] = useState<AgentTool>('claude')
  // null = untouched: use origin's default branch.
  const [branch, setBranch] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const isMobile = useIsMobile()

  const { data: branchData } = useProjectBranches(projectId, open)

  const defaultBranch = branchData?.defaultBranch
  const effectiveBranch = branch ?? defaultBranch

  const { data, isLoading } = useQuery({
    queryKey: ['skills', projectId, tool, effectiveBranch ?? null],
    queryFn: () => api.project[':projectId'].skills.$get({
      param: { projectId },
      query: { tool, ...(effectiveBranch ? { branch: effectiveBranch } : {}) },
    }),
    enabled: open,
    staleTime: 5_000,
    // Avoid flashing an empty list while switching agents.
    placeholderData: keepPreviousData,
  })

  const pickBranch = (b: string): void => {
    // Picking the resolved default clears the override back to it.
    setBranch(b === defaultBranch ? null : b)
    setPickerOpen(false)
    setPickerQuery('')
    setSelectedId(null)
  }

  const all = data?.skills ?? []
  const q = queryText.trim().toLowerCase()
  const rows = q
    ? all.filter((s) => `${s.name} ${s.description} ${s.sourceLabel ?? ''}`.toLowerCase().includes(q))
    : all
  // Desktop shows the top row until the user picks one. A phone shows one
  // pane at a time, so it waits for a tap before fetching a SKILL.md.
  const picked = rows.find((s) => s.id === selectedId) ?? null
  const selected = picked ?? (isMobile ? null : rows[0] ?? null)

  // Reopening on a phone lands on the list, not on the last skill read.
  useEffect(() => { if (!open) setSelectedId(null) }, [open])

  return (
    <>
      <button
        onClick={openOverlay}
        title="Skills"
        aria-label="Skills"
        className="flex h-5 w-5 items-center justify-center rounded text-text-faint transition
          hover:bg-surface-2 hover:text-text-dim max-md:h-9 max-md:w-9"
      >
        <SkillsIcon size={14} />
      </button>

      <Modal
        open={open}
        onOpenChange={(next) => { if (next) openOverlay(); else closeOverlay() }}
        variant="sheet"
        title={(
          <>
            Skills{all.length > 0 && <span className="ml-1.5 tabular-nums text-text-faint">({all.length})</span>}
          </>
        )}
        actions={(
          // On a phone the pickers wrap onto a second line.
          <div className="flex items-center gap-2
            max-md:order-last max-md:w-full max-md:justify-between max-md:overflow-x-auto">
            {/* Project skills are read from origin/<branch>. First in the row so
                its variable-width label cannot shift the buttons to its right. */}
            <Popover.Root
              open={pickerOpen}
              onOpenChange={(o) => { setPickerOpen(o); if (!o) setPickerQuery('') }}
            >
              <Popover.Trigger
                title="Choose the origin branch project skills are read from"
                className="flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-dim outline-none
                  transition hover:bg-surface-2 hover:text-text data-[popup-open]:bg-surface-2 data-[popup-open]:text-text
                  max-md:rounded-md max-md:bg-bg max-md:px-2 max-md:py-2 max-md:text-xs"
              >
                <BranchIcon size={11} className="shrink-0 text-text-faint" />
                <span className="max-w-[180px] truncate font-mono">{effectiveBranch ?? '…'}</span>
                <ChevronIcon size={10} className="shrink-0 rotate-90 text-text-faint" />
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Positioner side="bottom" align="start" sideOffset={6}>
                  <Popover.Popup className={clsx('w-[240px]', POPUP)}>
                    <div className="px-2 pb-1 pt-1 text-[11px] uppercase tracking-wide text-text-faint">Skills branch</div>
                    <BranchPicker
                      branches={branchData?.branches ?? []}
                      defaultBranch={defaultBranch}
                      query={pickerQuery}
                      onQueryChange={setPickerQuery}
                      onSelect={pickBranch}
                      showList
                      placeholder={branchData ? 'filter branches…' : 'loading branches…'}
                      ariaLabel="Skills branch"
                      className="px-1 pb-1"
                    />
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>
            {/* Agent selector: each tool reads skills from its own dirs. Anchored
                right so the changing title count cannot move it. */}
            <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-bg p-0.5">
              {AGENT_TOOLS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => { setTool(t); setSelectedId(null) }}
                  className={clsx(
                    'rounded px-2.5 py-1.5 text-[11px] leading-none transition max-md:h-9 max-md:px-3',
                    tool === t
                      ? 'bg-surface-2 font-medium text-text'
                      : 'text-text-faint hover:text-text-dim',
                  )}
                >
                  {TOOL_LABEL[t]}
                </button>
              ))}
            </div>
          </div>
        )}
      >
        {!isLoading && all.length === 0 ? (
          <EmptyState
            className="flex-1"
            title={`No ${TOOL_LABEL[tool]} skills found`}
            description="Personal, plugin, project, and built-in SKILL.md files show up here."
          />
        ) : (
          <MasterDetail
            detailOpen={isMobile && picked !== null}
            onBack={() => setSelectedId(null)}
            backLabel="Back to skills"
            master={
              <>
                <input
                  value={queryText}
                  onChange={(e) => setQueryText(e.target.value)}
                  placeholder="Search skills…"
                  className="shrink-0 rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text
                    outline-none focus:border-border-strong max-md:py-2.5"
                />
                <ul className="min-h-0 flex-1 overflow-y-auto">
                  {rows.length === 0 && (
                    <li className="px-2 py-2 text-xs text-text-faint">
                      {isLoading ? 'Loading…' : 'No matches.'}
                    </li>
                  )}
                  {rows.map((s, i) => {
                    const group = skillGroup(s)
                    const showHeader = i === 0 || skillGroup(rows[i - 1]) !== group
                    return (
                      <li key={s.id}>
                        {showHeader && (
                          <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-text-faint">
                            {groupLabel(group, tool)}
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => setSelectedId(s.id)}
                          className={clsx(
                            'flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left transition max-md:py-2.5',
                            selected?.id === s.id ? 'bg-surface-2' : 'hover:bg-surface-2/50',
                          )}
                        >
                          <span className={clsx(
                            'truncate text-sm font-medium',
                            s.shadowedBy ? 'text-text-faint line-through' : 'text-text-dim',
                          )}>
                            /{s.name}
                          </span>
                          {s.description && (
                            <span className="truncate text-[11px] text-text-faint">{s.description}</span>
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </>
            }
            detail={selected
              ? <SkillDetailPane key={selected.id} projectId={projectId} tool={tool} branch={effectiveBranch} skill={selected} />
              : <div className="flex-1" />}
          />
        )}
      </Modal>
    </>
  )
}
