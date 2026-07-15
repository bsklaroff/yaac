import { useEffect, useState, type JSX } from 'react'
import clsx from 'clsx'
import { useQuery, keepPreviousData, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@base-ui/react/dialog'
import { Popover } from '@base-ui/react/popover'
import { BranchIcon, ChevronIcon, CloseIcon, SkillsIcon, TOOL_LABEL } from '#lib/icons'
import { BranchPicker } from '#components/BranchPicker'
import { EmptyState } from '#components/ui/EmptyState'
import { getProjectSkills, getSkillBody } from '#lib/skillsApi'
import { getProjectBranches, projectBranchesKey } from '#lib/projectApi'
import { useUiStore } from '#store'
import { AGENT_TOOLS, type AgentTool, type SkillSource, type SkillSummary } from '@yaac/shared/types'

const SOURCE_LABEL: Record<SkillSource, string> = {
  personal: 'Personal',
  plugin: 'Plugin',
  project: 'Project',
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
  { projectSlug, tool, branch, skill }:
  { projectSlug: string; tool: AgentTool; branch: string | undefined; skill: SkillSummary },
): JSX.Element {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['skill-body', projectSlug, tool, branch ?? null, skill.id],
    queryFn: () => getSkillBody(projectSlug, skill.id, tool, branch),
    staleTime: 30_000,
  })
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-hairline-soft bg-bg/50 p-4">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold text-text">/{skill.name}</h3>
      </div>
      <div className="mt-1"><SkillTags skill={skill} /></div>
      {skill.description && (
        <p className="mt-3 text-xs leading-relaxed text-text-dim">{skill.description}</p>
      )}
      {skill.allowedTools && skill.allowedTools.length > 0 && (
        <p className="mt-2 text-[11px] text-text-faint">
          allowed-tools: <span className="text-text-dim">{skill.allowedTools.join(', ')}</span>
        </p>
      )}
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded bg-bg/80 p-3">
        {isLoading && <p className="text-xs text-text-faint">Loading…</p>}
        {isError && <p className="text-xs text-red-400/80">Could not load this skill.</p>}
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
 * Sidebar-header entry point to the project's skill viewer plus the full-screen
 * modal it opens. Skills (personal + plugin + project `SKILL.md` files the
 * agent can invoke) are a property of the project, not a session, so this lives
 * in the sidebar header and its open state lives in the store.
 *
 * The overlay is a search-filtered master/detail list grouped by source;
 * picking a row fetches and shows its full `SKILL.md`. Bundled skills (embedded
 * in the agent binary) are intentionally excluded — there is no supported way
 * to enumerate them.
 */
export function SkillsButton({ projectSlug }: { projectSlug: string }): JSX.Element {
  const open = useUiStore((s) => s.skillsOverlayOpen)
  const openOverlay = useUiStore((s) => s.openSkillsOverlay)
  const closeOverlay = useUiStore((s) => s.closeSkillsOverlay)

  const [queryText, setQueryText] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tool, setTool] = useState<AgentTool>('claude')
  // null = untouched: use the project's resolved default branch.
  const [branch, setBranch] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')

  const queryClient = useQueryClient()
  const { data: branchData } = useQuery({
    queryKey: projectBranchesKey(projectSlug),
    queryFn: () => getProjectBranches(projectSlug),
    enabled: open && projectSlug !== '',
  })
  // Freshen the branch list from the remote in the background so a just-pushed
  // branch appears, mirroring the changes/new-session pickers.
  useEffect(() => {
    if (!open || projectSlug === '') return
    let cancelled = false
    getProjectBranches(projectSlug, { refresh: true })
      .then((fresh) => { if (!cancelled) queryClient.setQueryData(projectBranchesKey(projectSlug), fresh) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [open, projectSlug, queryClient])

  const defaultBranch = branchData ? branchData.referenceBranch ?? branchData.defaultBranch : undefined
  const effectiveBranch = branch ?? defaultBranch

  const { data, isLoading } = useQuery({
    queryKey: ['skills', projectSlug, tool, effectiveBranch ?? null],
    queryFn: () => getProjectSkills(projectSlug, tool, effectiveBranch),
    enabled: open,
    staleTime: 5_000,
    // Keep the previous tool's list visible while the next one loads, so
    // switching agents doesn't flash the pane to empty and back.
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
  const selected = rows.find((s) => s.id === selectedId) ?? rows[0] ?? null

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (next) openOverlay(); else closeOverlay() }}>
      <button
        onClick={openOverlay}
        title="Skills"
        aria-label="Skills"
        className="flex h-5 w-5 items-center justify-center rounded text-text-faint transition
          hover:bg-surface-2 hover:text-text-dim"
      >
        <SkillsIcon size={14} />
      </button>

      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[1px] transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed inset-4 flex flex-col gap-3 rounded-xl border border-hairline
          bg-surface p-4 text-text shadow-[0_16px_48px_var(--shadow-color)] outline-none transition duration-150
          data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95
          data-[ending-style]:opacity-0">
          <div className="flex items-center justify-between gap-3">
            <Dialog.Title className="shrink-0 text-xs font-semibold text-text-dim">
              Skills{all.length > 0 && (
                <span className="ml-1.5 tabular-nums text-text-faint">({all.length})</span>
              )}
            </Dialog.Title>
            <div className="flex items-center gap-2">
              {/* Branch picker — project (repo) skills are read from origin/<branch>,
                  the same branch the changes pane diffs against. First in the row so
                  its variable-width label only shifts the group's left edge, leaving
                  the agent selector and Close pinned right (see below). */}
              <Popover.Root
                open={pickerOpen}
                onOpenChange={(o) => { setPickerOpen(o); if (!o) setPickerQuery('') }}
              >
                <Popover.Trigger
                  title="Choose the origin branch project skills are read from"
                  className="flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-dim outline-none
                    transition hover:bg-surface-2 hover:text-text data-[popup-open]:bg-surface-2 data-[popup-open]:text-text"
                >
                  <BranchIcon size={11} className="shrink-0 text-text-faint" />
                  <span className="max-w-[180px] truncate font-mono">{effectiveBranch ?? '…'}</span>
                  <ChevronIcon size={10} className="shrink-0 rotate-90 text-text-faint" />
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Positioner side="bottom" align="start" sideOffset={6}>
                    <Popover.Popup
                      className="w-[240px] rounded-lg border border-border bg-surface-2 p-1 text-text
                        shadow-[0_12px_32px_var(--shadow-color)] outline-none transition-opacity duration-100
                        data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
                    >
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
              {/* Per-agent selector — each tool loads skills from its own dirs.
                  Right-anchored beside Close so the variable-width title count
                  (which shrinks to nothing while a tool loads or when empty) can
                  never shift these buttons out from under the pointer. */}
              <div className="flex items-center gap-0.5 rounded-md bg-bg p-0.5">
                {AGENT_TOOLS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => { setTool(t); setSelectedId(null) }}
                    className={clsx(
                      'rounded px-2.5 py-1.5 text-[11px] leading-none transition',
                      tool === t
                        ? 'bg-surface-2 font-medium text-text'
                        : 'text-text-faint hover:text-text-dim',
                    )}
                  >
                    {TOOL_LABEL[t]}
                  </button>
                ))}
              </div>
              <Dialog.Close
                title="Close"
                aria-label="Close"
                className="flex h-6 w-6 items-center justify-center rounded text-text-faint transition
                  hover:bg-surface-2 hover:text-text"
              >
                <CloseIcon size={14} />
              </Dialog.Close>
            </div>
          </div>

          {!isLoading && all.length === 0 ? (
            <EmptyState
              className="flex-1"
              title={`No ${TOOL_LABEL[tool]} skills found`}
              description="Personal, plugin, and project SKILL.md files show up here. Skills built into the agent binary aren't listed."
            />
          ) : (
            <div className="flex min-h-0 flex-1 gap-3">
              {/* Master: search + grouped list */}
              <div className="flex w-80 shrink-0 flex-col gap-2">
                <input
                  value={queryText}
                  onChange={(e) => setQueryText(e.target.value)}
                  placeholder="Search skills…"
                  className="rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text
                    outline-none focus:border-border-strong"
                />
                <ul className="min-h-0 flex-1 overflow-y-auto">
                  {rows.length === 0 && (
                    <li className="px-2 py-2 text-xs text-text-faint">
                      {isLoading ? 'Loading…' : 'No matches.'}
                    </li>
                  )}
                  {rows.map((s, i) => {
                    const showHeader = i === 0 || rows[i - 1].source !== s.source
                    return (
                      <li key={s.id}>
                        {showHeader && (
                          <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-text-faint">
                            {SOURCE_LABEL[s.source]}
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => setSelectedId(s.id)}
                          className={clsx(
                            'flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left transition',
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
              </div>

              {/* Detail */}
              {selected
                ? <SkillDetailPane key={selected.id} projectSlug={projectSlug} tool={tool} branch={effectiveBranch} skill={selected} />
                : <div className="flex-1" />}
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
