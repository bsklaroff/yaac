import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { Popover } from '@base-ui/react/popover'
import { BranchIcon, ChevronIcon, TOOL_LABEL } from '#lib/icons'
import { BranchPicker } from '#components/BranchPicker'
import { ProjectSelect, useSettingsProject } from '#components/settings/ProjectPicker'
import { EmptyState } from '#components/ui/EmptyState'
import { MasterDetail } from '#components/ui/MasterDetail'
import { PopoverPopup } from '#components/ui/menu'
import { api } from '#lib/api'
import { useProjectBranches } from '#lib/useProjectBranches'
import { useIsMobile } from '#lib/viewport'
import { AGENT_TOOLS, type AgentTool, type SkillSummary } from '@yaac/shared/types'

/** The list section a skill sits under, one per skill dir (an agent's
 *  plugins share one); the server sorts rows by section. */
function groupLabel(s: SkillSummary): string {
  const agent = s.home ? TOOL_LABEL[s.home] : ''
  switch (s.source) {
    case 'repo': return 'Repo'
    case 'personal': return agent
    case 'plugin': return `${agent} plugins`
    case 'yaac': return 'yaac built-in'
  }
}

/** A section's full name: repo sections also name their dir. */
function groupTitle(s: SkillSummary): string {
  return s.source === 'repo' ? `Repo ${s.sourceLabel ?? ''}` : groupLabel(s)
}

/** "Claude", "Claude and Pi", "Claude, Codex and Pi". */
function agentList(agents: AgentTool[]): string {
  const names = agents.map((t) => TOOL_LABEL[t])
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/**
 * How a same-named skill elsewhere affects this one: which agents load that
 * one instead (each agent's precedence is the server's to decide), and, as
 * codex loads every copy, whether codex sees two. Null when no other skill
 * shares the name.
 */
function clashNote(skill: SkillSummary, all: SkillSummary[]): string | null {
  const twins = all.filter((o) => o.id !== skill.id && o.name === skill.name
    && (o.source === 'personal' || o.source === 'repo'))
  const byWinner = new Map<string, AgentTool[]>()
  for (const t of skill.overriddenFor) {
    const winner = twins.find((o) => o.agents.includes(t) && !o.overriddenFor.includes(t))
    const where = winner ? groupTitle(winner) : 'another dir'
    byWinner.set(where, [...(byWinner.get(where) ?? []), t])
  }
  const notes = [...byWinner].map(([where, agents]) =>
    `${agentList(agents)} ${agents.length === 1 ? 'uses' : 'use'} the /${skill.name} under ${where} instead.`)
  const codexTwin = skill.agents.includes('codex') && twins.find((o) => o.agents.includes('codex'))
  if (codexTwin) {
    notes.push(`Codex also loads the /${skill.name} under ${groupTitle(codexTwin)}, so $${skill.name} is ambiguous there.`)
  }
  return notes.length > 0 ? notes.join(' ') : null
}

/** The agents that read a section's dir, as small pills. */
function AgentPills({ agents }: { agents: AgentTool[] }): JSX.Element {
  const labels = agents.length === AGENT_TOOLS.length ? ['All agents'] : agents.map((t) => TOOL_LABEL[t])
  return (
    <span className="flex flex-wrap items-center gap-1">
      {labels.map((l) => (
        <span key={l} className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-normal normal-case tracking-normal text-text-dim">
          {l}
        </span>
      ))}
    </span>
  )
}

/** The read-only detail pane for the selected skill: metadata + full SKILL.md. */
function SkillDetailPane(
  { projectId, branch, skill, note }:
  { projectId: string; branch: string | undefined; skill: SkillSummary; note: string | null },
): JSX.Element {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['skill-body', projectId, branch ?? null, skill.id],
    queryFn: () => api.project[':projectId'].skills.body.$get({
      param: { projectId },
      query: { id: skill.id, ...(branch ? { branch } : {}) },
    }),
    staleTime: 30_000,
  })
  const tags = [
    groupLabel(skill),
    ...(skill.source === 'plugin' || skill.source === 'repo' ? [skill.sourceLabel ?? ''] : []),
    ...(skill.modelInvocable ? [] : ['manual only']),
    ...(skill.userInvocable ? [] : ['model only']),
  ]
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-hairline-soft bg-bg/50 p-4
      max-md:border-0 max-md:bg-transparent max-md:p-0">
      {/* Only the body may shrink; otherwise a long SKILL.md clips the title
          on a short phone screen. */}
      <h3 className="shrink-0 text-sm font-semibold text-text max-md:text-[0.9375rem]">/{skill.name}</h3>
      <div className="mt-1 flex shrink-0 flex-wrap items-center gap-1">
        {tags.map((t) => (
          <span key={t} className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-faint">{t}</span>
        ))}
      </div>
      <div className="mt-2 flex shrink-0 items-center gap-2 text-[11px] text-text-faint">
        Read by <AgentPills agents={skill.agents} />
      </div>
      {note && <p className="mt-2 shrink-0 text-[11px] text-text-faint">{note}</p>}
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
 * One project's skills: every agent's, in one searchable master/detail list
 * with a section per skill dir, headed by the agents that read it. The
 * agent filter narrows the list to one agent's. Repo skills are read
 * from an origin branch the picker chooses; the other tiers live in the
 * project's agent config dirs and have no branch.
 */
function SkillsBrowser({ projectId }: { projectId: string }): JSX.Element {
  const [queryText, setQueryText] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [agent, setAgent] = useState<AgentTool | null>(null)
  // null = untouched: use origin's default branch.
  const [branch, setBranch] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const isMobile = useIsMobile()

  const { data: branchData } = useProjectBranches(projectId, true)
  const defaultBranch = branchData?.defaultBranch
  const effectiveBranch = branch ?? defaultBranch

  const { data, isLoading } = useQuery({
    queryKey: ['skills', projectId, effectiveBranch ?? null],
    queryFn: () => api.project[':projectId'].skills.$get({
      param: { projectId },
      query: effectiveBranch ? { branch: effectiveBranch } : {},
    }),
    staleTime: 5_000,
    // Avoid flashing an empty list while switching branches.
    placeholderData: keepPreviousData,
  })

  const pickBranch = (b: string): void => {
    // Picking the resolved default clears the override back to it.
    setBranch(b === defaultBranch ? null : b)
    setPickerOpen(false)
    setPickerQuery('')
  }

  const all = data?.skills ?? []
  const q = queryText.trim().toLowerCase()
  const rows = all.filter((s) => (agent === null || s.agents.includes(agent))
    && (!q || `${s.name} ${s.description} ${s.sourceLabel ?? ''}`.toLowerCase().includes(q)))
  // Desktop shows the top row until the user picks one. A phone shows one
  // pane at a time, so it waits for a tap before fetching a SKILL.md.
  const picked = rows.find((s) => s.id === selectedId) ?? null
  const selected = picked ?? (isMobile ? null : rows[0] ?? null)
  // Dimmed when the filtered agent (or, unfiltered, every agent) loads
  // another skill of this name.
  const unused = (s: SkillSummary): boolean =>
    (agent ? s.overriddenFor.includes(agent) : s.overriddenFor.length === s.agents.length)

  const chip = (on: boolean): string => clsx(
    'rounded px-2.5 py-1.5 text-[11px] leading-none transition max-md:h-9 max-md:px-3',
    on ? 'bg-surface-2 font-medium text-text' : 'text-text-faint hover:text-text-dim',
  )

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter by agent" className="flex shrink-0 items-center gap-0.5 rounded-md bg-bg p-0.5">
          <button type="button" aria-pressed={agent === null} onClick={() => setAgent(null)} className={chip(agent === null)}>
            All agents
          </button>
          {AGENT_TOOLS.map((t) => (
            <button key={t} type="button" aria-pressed={agent === t} onClick={() => setAgent(t)} className={chip(agent === t)}>
              {TOOL_LABEL[t]}
            </button>
          ))}
        </div>
        <Popover.Root
          open={pickerOpen}
          onOpenChange={(o) => { setPickerOpen(o); if (!o) setPickerQuery('') }}
        >
          <Popover.Trigger
            title="Choose the origin branch repo skills are read from"
            className="flex min-w-0 items-center gap-1.5 rounded-md bg-bg px-2.5 py-1.5 text-[11px] text-text-dim
              outline-none transition hover:text-text data-[popup-open]:text-text max-md:h-10"
          >
            <span className="shrink-0 text-text-faint">Repo branch</span>
            <BranchIcon size={11} className="shrink-0 text-text-faint" />
            <span className="max-w-[180px] truncate font-mono">{effectiveBranch ?? '…'}</span>
            <ChevronIcon size={10} className="shrink-0 rotate-90 text-text-faint" />
          </Popover.Trigger>
          <PopoverPopup side="bottom" align="start" sideOffset={6} className="w-[240px]">
            <div className="px-2 pb-1 pt-1 text-[11px] uppercase tracking-wide text-text-faint">Repo skills branch</div>
            <BranchPicker
              branches={branchData?.branches ?? []}
              defaultBranch={defaultBranch}
              query={pickerQuery}
              onQueryChange={setPickerQuery}
              onSelect={pickBranch}
              showList
              placeholder={branchData ? 'filter branches…' : 'loading branches…'}
              ariaLabel="Repo skills branch"
              className="px-1 pb-1"
            />
          </PopoverPopup>
        </Popover.Root>
      </div>

      {!isLoading && all.length === 0 ? (
        <EmptyState
          className="flex-1"
          title="No skills found"
          description="Repo, agent, plugin, and built-in SKILL.md files show up here."
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
                  const note = clashNote(s, all)
                  return (
                    <li key={s.id}>
                      {(i === 0 || groupTitle(rows[i - 1]) !== groupTitle(s)) && (
                        <div className="flex items-center gap-2 px-2 pb-1 pt-3 text-[10px] font-semibold uppercase
                          tracking-wide text-text-faint">
                          <span className="shrink-0">{groupLabel(s)}</span>
                          {s.source === 'repo' && (
                            <span className="min-w-0 truncate font-mono font-normal normal-case tracking-normal">{s.sourceLabel}</span>
                          )}
                          <span className="ml-auto shrink-0"><AgentPills agents={s.agents} /></span>
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
                        <span className={clsx('truncate text-sm font-medium', unused(s) ? 'text-text-faint' : 'text-text-dim')}>
                          /{s.name}
                        </span>
                        {s.description && (
                          <span className="truncate text-[11px] text-text-faint">{s.description}</span>
                        )}
                        {note && <span className="text-[11px] italic text-text-faint">{note}</span>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          }
          detail={selected
            ? <SkillDetailPane
                key={selected.id}
                projectId={projectId}
                branch={effectiveBranch}
                skill={selected}
                note={clashNote(selected, all)}
              />
            : <div className="flex-1" />}
        />
      )}
    </>
  )
}

/**
 * The Skills settings section. Skills belong to a project (its repo, and
 * the agent config dirs yaac keeps per project), so a project picker heads
 * the section, defaulting to the one being viewed.
 */
export function SkillsSettings(): JSX.Element {
  const { projects, selected, pick } = useSettingsProject()
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="shrink-0">
        <h2 className="text-sm font-semibold">Skills</h2>
        {selected && <>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-dim">
            Skills available in
            <ProjectSelect projects={projects} value={selected.id} onChange={pick} />
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-text-faint">
            Each project has its own repo and agent config, so its skills differ from other projects&apos;.
          </p>
        </>}
      </div>
      {selected
        ? <SkillsBrowser key={selected.id} projectId={selected.id} />
        : <p className="text-xs text-text-faint">No projects yet. Add one from the rail first.</p>}
    </section>
  )
}
