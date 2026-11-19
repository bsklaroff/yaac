import { useState, type JSX } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { BranchIcon, TOOL_LABEL } from '#lib/icons'
import { BranchPicker } from '#components/BranchPicker'
import { ProjectSelect, useSettingsProject } from '#components/settings/ProjectPicker'
import { SettingsPageTitle } from '#components/settings/SettingsPage'
import { MasterDetail } from '#components/MasterDetail'
import { api } from '#lib/api'
import { useRepoBranches } from '#lib/repoApi'
import { useIsMobile } from '#lib/viewport'
import { AGENT_TOOLS, type AgentTool, type ProjectRepo, type SkillSummary } from '@yaac/shared/types'
import {
  cn, YBadge, YButton, YChip, YEmptyState, YInput, YListSection, YPopover, YPopoverPopup, YSegmented, YSelect,
  type YSegmentedOption,
} from '#ui'

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

const AGENT_FILTER: YSegmentedOption<AgentTool | 'all'>[] = [
  { value: 'all', label: 'All agents' },
  ...AGENT_TOOLS.map((t) => ({ value: t, label: TOOL_LABEL[t] })),
]

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

/** The agents that read a section's dir, as badges. */
function AgentPills({ agents }: { agents: AgentTool[] }): JSX.Element {
  const labels = agents.length === AGENT_TOOLS.length ? ['All agents'] : agents.map((t) => TOOL_LABEL[t])
  return (
    <span className="flex flex-wrap items-center gap-1">
      {labels.map((l) => <YBadge key={l} className="font-normal">{l}</YBadge>)}
    </span>
  )
}

/** The read-only detail pane for the selected skill: metadata + full SKILL.md. */
function SkillDetailPane(
  { projectId, source, skill, note }:
  { projectId: string; source: { repo?: string; branch?: string }; skill: SkillSummary; note: string | null },
): JSX.Element {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['skill-body', projectId, source.repo ?? null, source.branch ?? null, skill.id],
    queryFn: () => api.project[':projectId'].skills.body.$get({
      param: { projectId },
      query: { id: skill.id, ...source },
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
    <div className="flex min-h-0 flex-1 flex-col border-l border-line pl-4 max-md:border-0 max-md:pl-0">
      {/* Only the body may shrink; otherwise a long SKILL.md clips the title
          on a short phone screen. */}
      <h3 className="shrink-0 text-base font-semibold text-text max-md:text-[0.9375rem]">/{skill.name}</h3>
      <div className="mt-1 flex shrink-0 flex-wrap items-center gap-1">
        {tags.map((t) => <YBadge key={t} className="font-normal text-subtle">{t}</YBadge>)}
      </div>
      <div className="mt-2 flex shrink-0 items-center gap-2 text-sm text-subtle">
        Read by <AgentPills agents={skill.agents} />
      </div>
      {note && <p className="mt-2 shrink-0 text-sm text-subtle">{note}</p>}
      {skill.description && (
        <p className="mt-3 shrink-0 text-md leading-relaxed text-muted">{skill.description}</p>
      )}
      {skill.allowedTools && skill.allowedTools.length > 0 && (
        <p className="mt-2 shrink-0 text-sm text-subtle">
          allowed-tools: <span className="text-muted">{skill.allowedTools.join(', ')}</span>
        </p>
      )}
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto bg-sunken p-3">
        {isLoading && <p className="text-md text-subtle">Loading…</p>}
        {isError && <p className="text-md text-danger">Could not load this skill.</p>}
        {data && (
          <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-muted">
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
 * from an origin branch the picker chooses, of the repo chosen beside it
 * when the project links several; the other tiers live in the project's
 * agent config dirs and have neither.
 */
function SkillsBrowser({ projectId, repos }: { projectId: string; repos: ProjectRepo[] }): JSX.Element {
  const [queryText, setQueryText] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [agent, setAgent] = useState<AgentTool | null>(null)
  // null = untouched: use origin's default branch.
  const [branch, setBranch] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const isMobile = useIsMobile()

  // The repo whose skills are read: the pick, else the project's first.
  const [repoPick, setRepoPick] = useState<string | null>(null)
  const repo = repos.find((r) => r.id === repoPick) ?? repos.at(0)
  const { data: branchData } = useRepoBranches(repo?.id ?? '', true)
  const defaultBranch = branchData?.defaultBranch
  const effectiveBranch = branch ?? defaultBranch
  const source = {
    ...(repo !== undefined && repos.length > 1 ? { repo: repo.id } : {}),
    ...(effectiveBranch ? { branch: effectiveBranch } : {}),
  }

  const { data, isLoading } = useQuery({
    queryKey: ['skills', projectId, source.repo ?? null, effectiveBranch ?? null],
    queryFn: () => api.project[':projectId'].skills.$get({ param: { projectId }, query: source }),
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

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <YSegmented
          ariaLabel="Filter by agent"
          options={AGENT_FILTER}
          value={agent ?? 'all'}
          onChange={(v) => setAgent(v === 'all' ? null : v)}
        />
        {repos.length > 1 && (
          <YSelect
            aria-label="Repo skills are read from"
            value={repo?.id ?? ''}
            onChange={(e) => { setRepoPick(e.target.value); setBranch(null) }}
            className="font-mono text-sm max-md:h-10"
          >
            {repos.map((r) => <option key={r.id} value={r.id}>{r.dir}/</option>)}
          </YSelect>
        )}
        {repo !== undefined && <YPopover.Root
          open={pickerOpen}
          onOpenChange={(o) => { setPickerOpen(o); if (!o) setPickerQuery('') }}
        >
          <YPopover.Trigger
            title="Choose the origin branch repo skills are read from"
            render={<YChip dropdown className="max-md:h-10" />}
          >
            <span className="shrink-0 text-subtle">Repo branch</span>
            <BranchIcon size={11} className="shrink-0 text-subtle" />
            <span className="max-w-[180px] truncate font-mono">{effectiveBranch ?? '…'}</span>
          </YPopover.Trigger>
          <YPopoverPopup side="bottom" align="start" sideOffset={6} className="w-[240px]">
            <div className="px-2 pb-1 pt-1 text-sm text-subtle">Repo skills branch</div>
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
          </YPopoverPopup>
        </YPopover.Root>}
      </div>

      {!isLoading && all.length === 0 ? (
        <YEmptyState
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
              <YInput
                value={queryText}
                onChange={(e) => setQueryText(e.target.value)}
                placeholder="Search skills…"
                className="shrink-0 max-md:h-10"
              />
              <ul className="min-h-0 flex-1 overflow-y-auto">
                {rows.length === 0 && (
                  <li className="px-2 py-2 text-md text-subtle">
                    {isLoading ? 'Loading…' : 'No matches.'}
                  </li>
                )}
                {rows.map((s, i) => {
                  const note = clashNote(s, all)
                  return (
                    <li key={s.id}>
                      {(i === 0 || groupTitle(rows[i - 1]) !== groupTitle(s)) && (
                        <YListSection
                          label={<>
                            <span className="shrink-0">{groupLabel(s)}</span>
                            {s.source === 'repo' && <span className="min-w-0 truncate font-mono">{s.sourceLabel}</span>}
                          </>}
                          actions={<AgentPills agents={s.agents} />}
                        />
                      )}
                      <YButton
                        variant="bare"
                        onClick={() => setSelectedId(s.id)}
                        aria-current={selected?.id === s.id || undefined}
                        className={cn(
                          'flex w-full flex-col gap-0.5 px-2.5 py-1.5 text-left max-md:py-2.5',
                          selected?.id === s.id ? 'bg-selected' : 'hover:bg-hover',
                        )}
                      >
                        <span className={cn('truncate text-md font-medium', unused(s) ? 'text-subtle' : 'text-muted')}>
                          /{s.name}
                        </span>
                        {s.description && (
                          <span className="truncate text-sm text-subtle">{s.description}</span>
                        )}
                        {note && <span className="text-sm italic text-subtle">{note}</span>}
                      </YButton>
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
                source={source}
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
        <SettingsPageTitle title="Skills">
          {selected && <>
            <div className="flex flex-wrap items-center gap-2">
              Skills available in
              <ProjectSelect projects={projects} value={selected.id} onChange={pick} />
            </div>
            <p className="mt-1 text-sm text-subtle">
              Each project has its own repo and agent config, so its skills differ from other projects&apos;.
            </p>
          </>}
        </SettingsPageTitle>
      </div>
      {selected
        ? <SkillsBrowser key={selected.id} projectId={selected.id} repos={selected.repos} />
        : <p className="text-md text-subtle">No projects yet. Add one from the rail first.</p>}
    </section>
  )
}
