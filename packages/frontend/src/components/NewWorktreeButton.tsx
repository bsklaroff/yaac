import { useEffect, useRef, useState, type JSX } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Popover } from '@base-ui/react/popover'
import clsx from 'clsx'
import { AddIcon, PinIcon, TOOL_LABEL } from '#lib/icons'
import { BranchPicker } from '#components/BranchPicker'
import { createWorktree } from '#lib/createWorktree'
import { getProjectBranches, projectBranchesKey, setProjectReferenceBranch, type ProjectBranches } from '#lib/projectApi'
import { useProvisionWorktree } from '#lib/useProvisionWorktree'
import { randomUUID } from '#lib/uuid'
import { AUTH_LIST_KEY, configuredTools, useAuthList } from '#lib/useAuthList'
import { useUiStore } from '#store'
import { useSnapshot } from '#lib/useSnapshot'
import {
  ACP_TOOLS,
  defaultPermissionMode,
  PERMISSION_MODE_COPY,
  PERMISSION_MODES,
  SUPPORTED_PERMISSION_MODES,
  toolSupportsPermissionMode,
} from '@yaac/shared/types'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'

const TOOLS: AgentTool[] = ['claude', 'codex', 'opencode', 'pi']

/** Hover copy for the posture the dropdown is currently showing. */
const PERMISSION_MODE_HELP: Record<PermissionMode, string> = {
  bypass: 'The agent acts without ever asking.',
  auto: 'The agent acts without asking, but a reviewer model judges each action'
    + ' and blocks the dangerous ones. Claude gates this by subscription plan.',
  'accept-edits': 'The agent edits files in the worktree without asking, and still'
    + ' asks before running commands or reaching outside it.',
  plan: 'The agent explores and plans read-only; it cannot edit until you approve a plan.',
  manual: 'The agent asks before every action.',
}
const ITEM = 'flex w-full cursor-default items-center rounded-md px-2 py-1.5 text-xs outline-none '
  + 'text-text-dim hover:bg-surface-3 hover:text-text'

/**
 * "+ New worktree" for the active project: a popover with a branch picker
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
export function NewWorktreeButton(
  { projectSlug, variant = 'icon' }: { projectSlug: string; variant?: 'icon' | 'cta' },
): JSX.Element {
  const provision = useProvisionWorktree()
  const auth = useAuthList()
  const configured = configuredTools(auth)
  const openSettings = useUiStore((s) => s.openSettings)
  const queryClient = useQueryClient()

  const [open, setOpen] = useState(false)
  const popupRef = useRef<HTMLDivElement>(null)
  // null = untouched: the input shows (and creates use) the project default.
  const [branchInput, setBranchInput] = useState<string | null>(null)
  const [pinPending, setPinPending] = useState(false)
  const [pinError, setPinError] = useState<string | null>(null)
  // The posture picked in THIS popover, or `undefined` while untouched —
  // which stays undefined rather than being resolved here, for two reasons.
  // A create then OMITS the field, so the server applies the resolution it
  // owns (this project's last choice, else the per-driver default), and the
  // memory lives there rather than in this browser. And the displayed value
  // is derived at RENDER: `useSnapshot()` is undefined until the first events
  // frame lands, so an initializer would read a containerless server as
  // sandboxed and show the wrong default for the life of the component.
  const [permissionMode, setPermissionMode] = useState<PermissionMode | undefined>(undefined)
  const snapshot = useSnapshot()
  const driver = snapshot?.driver
  // What the server WOULD pick, mirrored so the dropdown shows the posture a
  // create would actually run in. `defaultPermissionMode` is the same
  // function the server resolves with, and the tool is not known until one is
  // clicked — claude is the list's first and the server's own fallback, so it
  // stands in for "what this form would do if submitted now".
  const remembered = snapshot?.projects.find((p) => p.slug === projectSlug)?.lastPermissionMode
  const modeShown = permissionMode
    ?? remembered
    ?? (driver !== undefined ? defaultPermissionMode(driver, 'claude') : 'bypass')

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

  const create = (tool: AgentTool, mode: AgentMode = 'tui'): void => {
    const worktreeId = randomUUID()
    const branch = branchValue && !isDefault ? branchValue : undefined
    setOpen(false)
    provision(projectSlug, tool, 'create', worktreeId,
      (sid, onProgress) =>
        createWorktree(projectSlug, tool, onProgress, sid, branch, mode, permissionMode))
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
      // The posture is reset too, but nothing is lost: an explicit pick was
      // recorded server-side as the project's default, so the next open shows
      // it again through `remembered`.
      setBranchInput(null)
      setPinError(null)
      setPermissionMode(undefined)
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      {variant === 'cta' ? (
        // Labeled call-to-action for empty states — same popover, bigger target.
        <Popover.Trigger
          title="New worktree"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-1.5
            text-xs font-medium text-text-dim transition hover:border-accent/50 hover:text-accent
            data-[popup-open]:border-accent/50 data-[popup-open]:text-accent"
        >
          <AddIcon size={14} /> New worktree
        </Popover.Trigger>
      ) : (
        <Popover.Trigger
          title="New worktree"
          className="flex h-5 w-5 items-center justify-center rounded text-text-dim transition hover:bg-surface-2
            hover:text-accent data-[popup-open]:bg-surface-2 data-[popup-open]:text-accent
            max-md:h-9 max-md:w-9"
        >
          <AddIcon size={14} />
        </Popover.Trigger>
      )}
      <Popover.Portal>
        {/* align=start: the popup extends right (over the pane area) instead of
            left across the sidebar content. */}
        <Popover.Positioner side="bottom" align="start" sideOffset={6}>
          <Popover.Popup
            ref={popupRef}
            // Focus the popup itself, not the branch input — a blinking text
            // cursor on every open is distracting. Focus stays inside the
            // dialog so Escape/Tab and focus-return still work.
            initialFocus={() => popupRef.current}
            className="w-[240px] rounded-lg border border-border bg-surface-2 p-1 text-text
            shadow-[0_12px_32px_var(--shadow-color)] outline-none transition-opacity duration-100
            data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
            <div className="px-2 pb-1 pt-1 text-[11px] uppercase tracking-wide text-text-faint">New worktree</div>

            <BranchPicker
              branches={branchData?.branches ?? []}
              defaultBranch={branchData?.defaultBranch}
              query={branchInput ?? defaultResolved ?? ''}
              onQueryChange={(q) => { setBranchInput(q); setPinError(null) }}
              onSelect={(b) => setBranchInput(b)}
              showList={branchInput !== null}
              placeholder={branchData ? defaultResolved ?? '' : 'loading branches…'}
              ariaLabel="Reference branch"
              className="px-1 pb-1"
              trailing={
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
              }
              belowInput={pinError && <div className="px-2 pb-1 text-[11px] text-[#d65858]">{pinError}</div>}
            />

            <label
              className="mx-1 mb-1 flex cursor-default flex-col gap-1 rounded-md px-1 py-1
                text-[11px] text-text-dim"
              title={PERMISSION_MODE_HELP[modeShown]}
            >
              <span className="flex items-center gap-2">
                Permissions
                <select
                  value={modeShown}
                  onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
                  className="flex-1 rounded-md border border-border bg-surface-2 px-1 py-0.5
                    text-[11px] text-text outline-none hover:bg-surface-3"
                >
                  {PERMISSION_MODES.map((m) => (
                    <option key={m} value={m}>{PERMISSION_MODE_COPY[m]}</option>
                  ))}
                </select>
              </span>
              {modeShown === 'bypass' && driver === 'containerless' && (
                <span className="text-text-faint">no sandbox — acts as you</span>
              )}
            </label>

            <div className="mx-1 mb-1 border-t border-border" />
            {/* A tool that has no such posture is shown but not clickable:
                the posture is picked before the tool, so the honest signal is
                which tools can honor the one already chosen (pi, having no
                permission system at all, only ever offers `bypass`). */}
            {TOOLS.map((t) => configured.has(t) ? (
              <div key={t} className="flex items-center">
                <button
                  type="button"
                  className={clsx(ITEM, 'flex-1', !toolSupportsPermissionMode(t, modeShown)
                    && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-text-dim')}
                  disabled={!toolSupportsPermissionMode(t, modeShown)}
                  title={toolSupportsPermissionMode(t, modeShown)
                    ? undefined
                    : `${TOOL_LABEL[t]} has no ${PERMISSION_MODE_COPY[modeShown].toLowerCase()} mode`}
                  onClick={() => create(t)}
                >
                  {TOOL_LABEL[t]}
                  {!toolSupportsPermissionMode(t, modeShown) && (
                    <span className="ml-auto pl-3 text-[11px] text-text-faint">
                      {SUPPORTED_PERMISSION_MODES[t].length === 1
                        ? `${PERMISSION_MODE_COPY[SUPPORTED_PERMISSION_MODES[t][0]].toLowerCase()} only`
                        : 'unsupported'}
                    </span>
                  )}
                </button>
                {/* The same tool, driven over ACP instead of its TUI: the
                    worktree opens with a chat pane rather than a terminal.
                    Only offered for tools whose adapter ships in the image. */}
                {/* Only under `bypass`: an ACP conversation's permission
                    prompts are answered automatically, so the server refuses
                    any other posture rather than pretend to enforce it. */}
                {ACP_TOOLS.includes(t) && modeShown === 'bypass' && (
                  <button
                    type="button"
                    title={`Run ${TOOL_LABEL[t]} as a chat pane (Agent Client Protocol)`}
                    className="mr-1 rounded-md px-2 py-1 text-[11px] text-text-faint outline-none transition hover:bg-surface-3 hover:text-accent"
                    onClick={() => create(t, 'acp')}
                  >
                    chat
                  </button>
                )}
              </div>
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
