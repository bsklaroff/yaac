import { useCallback, useEffect, useState, type JSX } from 'react'
import { addSchedule, listSchedules, removeSchedule } from '#lib/scheduleApi'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { TOOL_LABEL } from '#lib/icons'
import { useSnapshot } from '#lib/useSnapshot'
import { useUiStore } from '#store'
import { AGENT_TOOLS, type AgentTool, type ScheduleEntry } from '@yaac/shared/types'

const inputClass = 'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text '
  + 'outline-none focus:border-border-strong'

/**
 * Settings section for cron-scheduled session starts: pick a project, list
 * its schedules, add one (cron spec + initial prompt + optional tool), or
 * remove one. Fired sessions appear in the normal session list.
 */
export function ScheduleSettings(): JSX.Element {
  const projects = useSnapshot()?.projects ?? []
  const activeProjectSlug = useUiStore((s) => s.activeProjectSlug)
  // Same picker/fallback shape as ProjectSettings: default to the active
  // project, keep the selection valid as projects load/change.
  const [picked, setPicked] = useState<string | null>(activeProjectSlug)
  const slug = picked && projects.some((p) => p.slug === picked)
    ? picked
    : (activeProjectSlug && projects.some((p) => p.slug === activeProjectSlug)
        ? activeProjectSlug
        : (projects[0]?.slug ?? null))

  const [schedules, setSchedules] = useState<ScheduleEntry[]>([])
  const [spec, setSpec] = useState('')
  const [prompt, setPrompt] = useState('')
  const [tool, setTool] = useState<AgentTool | ''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<ScheduleEntry | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!slug) return
    setSchedules(await listSchedules(slug))
  }, [slug])

  useEffect(() => {
    setError(null)
    void refresh().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [refresh])

  const onAdd = async (): Promise<void> => {
    if (!slug || !spec.trim() || !prompt.trim()) return
    setBusy(true)
    setError(null)
    try {
      await addSchedule(slug, spec.trim(), prompt, tool || undefined)
      setSpec('')
      setPrompt('')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onRemove = async (): Promise<void> => {
    if (!confirmRemove) return
    setBusy(true)
    setError(null)
    try {
      await removeSchedule(confirmRemove.id)
      setConfirmRemove(null)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h2 className="text-sm font-semibold">Schedules</h2>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        Start sessions automatically on a cron expression (server-local time), with an initial
        prompt typed into the agent.
      </p>

      {projects.length === 0 || !slug ? (
        <p className="mt-6 text-xs text-text-faint">No projects yet. Add one from the rail first.</p>
      ) : (
        <>
          <div className="mt-6">
            <div className="text-xs font-medium text-text">Project</div>
            <select
              value={slug}
              onChange={(e) => setPicked(e.target.value)}
              className={`mt-2 ${inputClass}`}
            >
              {projects.map((p) => (
                <option key={p.slug} value={p.slug}>{p.slug}</option>
              ))}
            </select>
          </div>

          <div className="mt-6">
            <div className="text-xs font-medium text-text">Add a schedule</div>
            <div className="mt-2 flex gap-2">
              <input
                value={spec}
                onChange={(e) => setSpec(e.target.value)}
                placeholder='Cron, e.g. "0 9 * * 1-5"'
                aria-label="Cron expression"
                className={inputClass}
              />
              <select
                value={tool}
                onChange={(e) => setTool(e.target.value as AgentTool | '')}
                aria-label="Agent tool"
                className={`${inputClass} w-40`}
              >
                <option value="">Default tool</option>
                {AGENT_TOOLS.map((t) => (
                  <option key={t} value={t}>{TOOL_LABEL[t]}</option>
                ))}
              </select>
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Initial prompt for each session"
              aria-label="Initial prompt"
              rows={3}
              className={`mt-2 resize-y ${inputClass}`}
            />
            <button
              type="button"
              onClick={() => { void onAdd() }}
              disabled={busy || !spec.trim() || !prompt.trim()}
              className="mt-2 flex h-8 items-center rounded-md bg-accent px-3 text-xs font-medium
                text-bg transition hover:brightness-110 disabled:opacity-50"
            >
              Add schedule
            </button>
          </div>

          {error && <p className="mt-3 text-xs text-[#c94a4a]">{error}</p>}

          <div className="mt-6">
            <div className="text-xs font-medium text-text">Schedules for {slug}</div>
            {schedules.length === 0 ? (
              <p className="mt-2 text-xs text-text-faint">No schedules yet.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {schedules.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-start justify-between gap-3 rounded-md border border-border
                      bg-bg px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-xs text-text">
                        <code>{s.spec}</code>
                        <span className="ml-2 text-text-dim">{s.tool ? TOOL_LABEL[s.tool] : 'Default tool'}</span>
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-text-dim" title={s.prompt}>
                        {s.prompt}
                      </div>
                      <div className="mt-0.5 text-[11px] text-text-faint">
                        {s.lastFiredAt
                          ? `Last fired ${new Date(s.lastFiredAt).toLocaleString()}`
                          : 'Never fired'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setConfirmRemove(s)}
                      className="shrink-0 rounded-md px-2 py-1 text-xs text-text-dim transition
                        hover:bg-surface-3 hover:text-text"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <ConfirmDialog
            open={confirmRemove !== null}
            onOpenChange={(open) => { if (!open) setConfirmRemove(null) }}
            title="Remove schedule?"
            description={confirmRemove
              ? `"${confirmRemove.spec}" in ${confirmRemove.projectSlug} will stop starting sessions.`
              : ''}
            confirmLabel="Remove"
            busy={busy}
            onConfirm={() => { void onRemove() }}
          />
        </>
      )}
    </section>
  )
}
