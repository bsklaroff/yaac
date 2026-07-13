import { useEffect, useState, type JSX } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Popover } from '@base-ui/react/popover'
import clsx from 'clsx'
import { AddIcon, BranchIcon, PinIcon, TOOL_LABEL } from '#lib/icons'
import { createSession } from '#lib/createSession'
import { getProjectBranches, setProjectReferenceBranch, type ProjectBranches } from '#lib/projectApi'
import { useProvisionSession } from '#lib/useProvisionSession'
import { AUTH_LIST_KEY, configuredTools, useAuthList } from '#lib/useAuthList'
import { useUiStore } from '#store'
import type { AgentTool } from '@yaac/shared/types'

const TOOLS: AgentTool[] = ['claude', 'codex', 'opencode']
const ITEM = 'flex w-full cursor-default items-center rounded-md px-2 py-1.5 text-xs outline-none '
  + 'text-text-dim hover:bg-surface-3 hover:text-text'

/** React Query key for a project's branch-picker data. */
export function projectBranchesKey(slug: string): readonly [string, string] {
  return ['project-branches', slug] as const
}

/**
 * "+ New session" for the active project: a popover with a branch picker
 * (typeahead over the remote's branches, prefilled with the project's
 * default) above the tool list. Picking a tool fires the create — on the
 * chosen branch — and the popover closes immediately; a provisioning row
 * appears in the sidebar and is auto-opened so progress streams into the
 * main pane. The id is generated up front so the row is selectable and
 * survives a reload.
 *
 * The branch is sent only when it differs from the project's default
 * resolution, so a default create claims a prewarmed spare with zero prep.
 * The pin persists the picked branch as the project default
 * (`referenceBranch` in yaac-config.json) for future creates and shortcuts.
 *
 * Tools without a stored credential can't create: their item reads "Sign in"
 * and opens settings → credentials with that tool's form expanded instead.
 */
export function NewSessionButton(
  { projectSlug, variant = 'icon' }: { projectSlug: string; variant?: 'icon' | 'cta' },
): JSX.Element {
  const provision = useProvisionSession()
  const auth = useAuthList()
  const configured = configuredTools(auth)
  const openSettings = useUiStore((s) => s.openSettings)
  const queryClient = useQueryClient()

  const [open, setOpen] = useState(false)
  // null = untouched: the input shows (and creates use) the project default.
  const [branchInput, setBranchInput] = useState<string | null>(null)
  const [pinPending, setPinPending] = useState(false)
  const [pinError, setPinError] = useState<string | null>(null)

  const branchesKey = projectBranchesKey(projectSlug)
  const { data: branchData } = useQuery({
    queryKey: branchesKey,
    queryFn: () => getProjectBranches(projectSlug),
    enabled: open,
  })

  // On open: re-pull credentials (may have changed CLI-side) and refresh the
  // branch list from the remote in the background — the instant local list
  // renders first, a just-pushed branch appears when the fetch lands.
  useEffect(() => {
    if (!open) return
    void queryClient.invalidateQueries({ queryKey: AUTH_LIST_KEY })
    getProjectBranches(projectSlug, { refresh: true })
      .then((fresh) => queryClient.setQueryData(projectBranchesKey(projectSlug), fresh))
      .catch(() => { /* stale-but-instant list stays */ })
  }, [open, projectSlug, queryClient])

  // The branch a create uses when the picker is untouched.
  const defaultResolved = branchData ? branchData.referenceBranch ?? branchData.defaultBranch : null
  const branchValue = (branchInput ?? defaultResolved ?? '').trim()
  const isDefault = branchValue === (defaultResolved ?? '')

  const filtered = (branchData?.branches ?? [])
    .filter((b) => branchInput === null || b.toLowerCase().includes(branchInput.trim().toLowerCase()))
    .slice(0, 8)

  const create = (tool: AgentTool): void => {
    const sessionId = crypto.randomUUID()
    const branch = branchValue && !isDefault ? branchValue : undefined
    setOpen(false)
    provision(projectSlug, tool, 'create', sessionId,
      (sid, onProgress) => createSession(projectSlug, tool, onProgress, sid, branch))
  }

  const pinAsDefault = (): void => {
    if (!branchValue || pinPending) return
    setPinPending(true)
    setPinError(null)
    setProjectReferenceBranch(projectSlug, branchValue)
      .then((referenceBranch) => {
        queryClient.setQueryData(branchesKey, (prev: ProjectBranches | undefined) =>
          prev ? { ...prev, referenceBranch } : prev)
        setBranchInput(null) // the input now shows the new default
      })
      .catch((err: unknown) => {
        setPinError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setPinPending(false))
  }

  const onOpenChange = (next: boolean): void => {
    setOpen(next)
    if (!next) {
      // Reset per-open state so the next open starts from the default.
      setBranchInput(null)
      setPinError(null)
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      {variant === 'cta' ? (
        // Labeled call-to-action for empty states — same popover, bigger target.
        <Popover.Trigger
          title="New session"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-1.5
            text-xs font-medium text-text-dim transition hover:border-accent/50 hover:text-accent
            data-[popup-open]:border-accent/50 data-[popup-open]:text-accent"
        >
          <AddIcon size={14} /> New session
        </Popover.Trigger>
      ) : (
        <Popover.Trigger
          title="New session"
          className="flex h-5 w-5 items-center justify-center rounded text-text-dim transition hover:bg-surface-2
            hover:text-accent data-[popup-open]:bg-surface-2 data-[popup-open]:text-accent"
        >
          <AddIcon size={14} />
        </Popover.Trigger>
      )}
      <Popover.Portal>
        {/* align=start: the popup extends right (over the pane area) instead of
            left across the sidebar content. */}
        <Popover.Positioner side="bottom" align="start" sideOffset={6}>
          <Popover.Popup className="w-[240px] rounded-lg border border-border bg-surface-2 p-1 text-text
            shadow-[0_12px_32px_var(--shadow-color)] outline-none transition-opacity duration-100
            data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
            <div className="px-2 pb-1 pt-1 text-[11px] uppercase tracking-wide text-text-faint">New session</div>

            <div className="flex items-center gap-1 px-1 pb-1">
              <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 py-1">
                <BranchIcon size={12} className="shrink-0 text-text-faint" />
                <input
                  aria-label="Reference branch"
                  value={branchInput ?? defaultResolved ?? ''}
                  placeholder={branchData ? defaultResolved ?? '' : 'loading branches…'}
                  onChange={(e) => { setBranchInput(e.target.value); setPinError(null) }}
                  spellCheck={false}
                  className="w-full min-w-0 bg-transparent font-mono text-xs text-text outline-none
                    placeholder:text-text-faint"
                />
              </div>
              <button
                type="button"
                title={isDefault ? 'This is the project default' : `Set ${branchValue} as the project default`}
                aria-label="Set as default branch"
                disabled={isDefault || !branchValue || pinPending}
                onClick={pinAsDefault}
                className={clsx(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md outline-none transition',
                  isDefault || !branchValue
                    ? 'text-text-faint/50'
                    : 'text-text-dim hover:bg-surface-3 hover:text-accent',
                )}
              >
                <PinIcon size={12} />
              </button>
            </div>
            {pinError && <div className="px-2 pb-1 text-[11px] text-[#d65858]">{pinError}</div>}

            {branchInput !== null && filtered.length > 0 && (
              <ul className="max-h-48 overflow-y-auto pb-1">
                {filtered.map((b) => (
                  <li key={b}>
                    <button
                      type="button"
                      onClick={() => setBranchInput(b)}
                      className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left font-mono text-xs
                        text-text-dim outline-none hover:bg-surface-3 hover:text-text"
                    >
                      <BranchIcon size={11} className="shrink-0 text-text-faint" />
                      <span className="truncate">{b}</span>
                      {b === branchData?.defaultBranch && (
                        <span className="ml-auto pl-2 text-[10px] text-text-faint">default</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mx-1 mb-1 border-t border-border" />
            {TOOLS.map((t) => configured.has(t) ? (
              <button key={t} type="button" className={ITEM} onClick={() => create(t)}>
                {TOOL_LABEL[t]}
              </button>
            ) : (
              <button
                key={t}
                type="button"
                className={ITEM}
                onClick={() => { setOpen(false); openSettings('credentials', t) }}
              >
                <span className="text-text-faint">{TOOL_LABEL[t]}</span>
                <span className="ml-auto pl-3 text-[11px] text-accent">Sign in</span>
              </button>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
