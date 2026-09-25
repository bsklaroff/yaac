import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Popover } from '@base-ui/react/popover'
import clsx from 'clsx'
import { AddIcon, PinIcon, TOOL_LABEL } from '#lib/icons'
import { BranchPicker } from '#components/BranchPicker'
import { Typeahead } from '#components/ui/Typeahead'
import { getProjectBranches, projectBranchesKey, setProjectReferenceBranch, type ProjectBranches } from '#lib/projectApi'
import { AUTH_LIST_KEY } from '#lib/useAuthList'
import { useCreateDefaults, useCreateWorktree } from '#lib/useCreateDefaults'
import { useUiStore } from '#store'
import { useSnapshot } from '#lib/useSnapshot'
import {
  AGENT_TOOLS,
  MODEL_RE,
  PERMISSION_MODE_COPY,
  supportedPermissionModes,
  toolSupportsPermissionMode,
} from '@yaac/shared/types'
import type { AgentMode, AgentTool, PermissionMode, ToolCreateDefaults } from '@yaac/shared/types'

/** Hover copy for the posture the dropdown is currently showing. */
const PERMISSION_MODE_HELP: Record<PermissionMode, string> = {
  bypass: 'The agent acts without ever asking.',
  auto: 'The agent acts without asking, but a reviewer model judges each action'
    + ' and blocks the dangerous ones. Claude gates this by subscription plan.',
  'accept-edits': 'The agent edits files in the worktree without asking, and still'
    + ' asks before running commands or reaching outside it.',
  manual: 'The agent asks before every action.',
  plan: 'The agent explores and plans read-only; it cannot edit until you approve a plan.',
  'read-only': 'The agent reads and explores freely inside a read-only sandbox, and asks before'
    + ' every edit and anything that reaches the network.',
}

const MODE_COPY: Record<AgentMode, string> = { tui: 'Terminal', acp: 'Chat' }
const MODE_HELP: Record<AgentMode, string> = {
  tui: 'The agent\'s own terminal UI, in a terminal pane.',
  acp: 'The agent driven over the Agent Client Protocol, in a chat pane.',
}

const SELECT = 'min-w-0 flex-1 rounded-md border border-border bg-surface-2 h-[26px] px-1 text-xs text-text '
  + 'outline-none hover:bg-surface-3'

/**
 * "+ New worktree" for the active project: a popover with a branch picker
 * (typeahead over the remote's branches, prefilled with the project's
 * default), then the agent, its model, its permission posture and its UI,
 * and a Create button — Enter anywhere but on a button does the same. The
 * popover closes on create; a provisioning row appears in the sidebar and is
 * auto-opened so progress streams into the main pane.
 *
 * Every field opens on what an untouched create would run: the agent this
 * project was last created with, and that agent's last model, posture and UI
 * (`useCreateDefaults`). Changing the agent reloads the other three from its
 * own memory. Create sends all of them, so they become the next defaults.
 *
 * The branch is sent only when it differs from the project's default
 * resolution. The pin persists the picked branch as the project default
 * (`referenceBranch` in yaac-config.json) for future creates and shortcuts.
 *
 * An agent without a stored credential can't create: picking it turns the
 * button into "Sign in", which opens settings → credentials on that agent.
 * Nor can a project without a git credential: the button is then "Add git
 * authentication", which opens settings → credentials on the project.
 */
export function NewWorktreeButton(
  { projectSlug, variant = 'icon' }: { projectSlug: string; variant?: 'icon' | 'cta' },
): JSX.Element {
  const defaults = useCreateDefaults(projectSlug)
  const createWorktree = useCreateWorktree()
  const openSettings = useUiStore((s) => s.openSettings)
  const queryClient = useQueryClient()
  const driver = useSnapshot()?.driver

  const [open, setOpen] = useState(false)
  const popupRef = useRef<HTMLDivElement>(null)
  // null = untouched: the input shows (and creates use) the project default.
  const [branchInput, setBranchInput] = useState<string | null>(null)
  const [pinPending, setPinPending] = useState(false)
  const [pinError, setPinError] = useState<string | null>(null)
  // What was picked in THIS popover; anything unpicked shows the default.
  const [toolPick, setToolPick] = useState<AgentTool | undefined>(undefined)
  const [picks, setPicks] = useState<ToolCreateDefaults>({})
  // null = not editing: the model field shows the chosen model's name.
  const [modelQuery, setModelQuery] = useState<string | null>(null)

  const tool = toolPick ?? defaults.lastTool
  const base = defaults.forTool(tool)
  const model = picks.model ?? base.model
  const mode = picks.mode ?? base.mode
  const permissionMode = picks.permissionMode ?? base.permissionMode
  const modelName = base.models.find((m) => m.id === model)?.name
  const signedIn = defaults.configured.has(tool)
  // Only once the snapshot has said so — before it lands nothing creates anyway.
  const needsGitAuth = defaults.ready && !defaults.hasGitCredential

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

  const onOpenChange = (next: boolean): void => {
    setOpen(next)
    if (!next) {
      // Reset per-open state so the next open starts from the defaults —
      // which include whatever was just created, since a create records them.
      setBranchInput(null)
      setPinError(null)
      setToolPick(undefined)
      setPicks({})
      setModelQuery(null)
    }
  }

  // Why Create cannot run right now, or null when it can. Mid-edit model text
  // blocks it: it is a search, not a pick, and creating with the previous
  // model instead would not be what the field shows.
  const blocked = !defaults.ready ? 'Loading…'
    : modelQuery !== null ? 'Pick a model from the list'
    : !toolSupportsPermissionMode(tool, permissionMode, mode) ? 'Pick a permission mode this UI offers'
    : null

  const submit = (): void => {
    if (needsGitAuth) {
      onOpenChange(false)
      openSettings('credentials', undefined, projectSlug)
      return
    }
    if (!signedIn) {
      onOpenChange(false)
      openSettings('credentials', tool)
      return
    }
    if (blocked !== null) return
    onOpenChange(false)
    createWorktree(projectSlug, tool, {
      model,
      ...(modelName !== undefined ? { modelName } : {}),
      permissionMode,
      mode,
    }, branchValue && !isDefault ? branchValue : undefined)
  }

  // Enter anywhere in the popover creates — except on a button, which has its
  // own Enter (the pin, a suggestion row, Create itself). A highlighted
  // suggestion takes Enter before it gets here (see Typeahead).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.target instanceof HTMLButtonElement) return
    e.preventDefault()
    submit()
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

  const pickModel = (id: string): void => {
    setPicks((p) => ({ ...p, model: id }))
    setModelQuery(null)
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
            // cursor on every open is distracting, and it is what makes
            // "open, Enter" a create with every default.
            initialFocus={() => popupRef.current}
            onKeyDown={onKeyDown}
            className="w-[280px] rounded-lg border border-border bg-surface-2 p-1 text-text
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

            <Row label="Agent">
              <select
                aria-label="Agent"
                value={tool}
                onChange={(e) => {
                  // Another agent brings its own memory for the other three.
                  setToolPick(e.target.value as AgentTool)
                  setPicks({})
                  setModelQuery(null)
                }}
                className={SELECT}
              >
                {AGENT_TOOLS.map((t) => (
                  <option key={t} value={t}>
                    {TOOL_LABEL[t]}{defaults.configured.has(t) ? '' : ' (sign in)'}
                  </option>
                ))}
              </select>
            </Row>

            {needsGitAuth ? (
              <div className="mx-1 mb-1 px-1 py-1 text-[11px] text-text-faint">
                This project has no git credential
              </div>
            ) : signedIn ? (
              <>
                <Row label="Model">
                  <div className="min-w-0 flex-1">
                    <Typeahead
                      items={base.models.map((m) => ({
                        value: m.id,
                        label: m.name ?? m.id,
                        ...(m.name !== undefined ? { detail: m.id } : {}),
                      }))}
                      query={modelQuery ?? modelName ?? model}
                      onQueryChange={setModelQuery}
                      onSelect={pickModel}
                      showList={modelQuery !== null}
                      ariaLabel="Model"
                      autoHighlight
                      freeEntry={(text) => MODEL_RE.test(text)
                        ? { value: text, label: `Use "${text}" as a model id` }
                        : null}
                      tag={(item) => item.value === base.defaultModel && <span>default</span>}
                      onBlur={() => setModelQuery(null)}
                    />
                  </div>
                </Row>

                <Row label="Permissions" title={PERMISSION_MODE_HELP[permissionMode]}>
                  <select
                    aria-label="Permissions"
                    value={permissionMode}
                    onChange={(e) => setPicks((p) => ({ ...p, permissionMode: e.target.value as PermissionMode }))}
                    className={SELECT}
                  >
                    {/* The terminal UI's postures are a superset of the chat
                        adapter's, so the list is per agent and a posture the
                        chosen UI lacks is shown but not pickable. */}
                    {supportedPermissionModes(tool, 'tui').map((m) => {
                      const offered = toolSupportsPermissionMode(tool, m, mode)
                      return (
                        <option key={m} value={m} disabled={!offered}>
                          {PERMISSION_MODE_COPY[m]}{offered ? '' : ' (terminal only)'}
                        </option>
                      )
                    })}
                  </select>
                </Row>
                {permissionMode === 'bypass' && driver === 'containerless' && (
                  <div className="-mt-1 mb-1 pl-[92px] text-[11px] text-text-faint">no sandbox — acts as you</div>
                )}

                <Row label="UI" title={MODE_HELP[mode]}>
                  <select
                    aria-label="UI"
                    value={mode}
                    onChange={(e) => setPicks((p) => ({ ...p, mode: e.target.value as AgentMode }))}
                    className={SELECT}
                  >
                    {(['tui', 'acp'] as const).map((m) => {
                      // An adapter can offer fewer postures than its CLI
                      // (codex-acp has no plan mode), so the chat UI is only
                      // pickable under a posture it has.
                      const offered = toolSupportsPermissionMode(tool, permissionMode, m)
                      return (
                        <option key={m} value={m} disabled={!offered}>
                          {MODE_COPY[m]}
                          {offered ? '' : ` (no ${PERMISSION_MODE_COPY[permissionMode].toLowerCase()})`}
                        </option>
                      )
                    })}
                  </select>
                </Row>
              </>
            ) : (
              <div className="mx-1 mb-1 px-1 py-1 text-[11px] text-text-faint">
                {TOOL_LABEL[tool]} has no credentials
              </div>
            )}

            <div className="p-1">
              <button
                type="button"
                onClick={submit}
                disabled={!needsGitAuth && signedIn && blocked !== null}
                title={!needsGitAuth && signedIn ? blocked ?? undefined : undefined}
                className="w-full rounded-md border border-border-strong bg-surface-3 px-2 py-1.5 text-xs font-medium
                  text-text outline-none transition hover:bg-border-strong disabled:cursor-not-allowed disabled:opacity-50"
              >
                {needsGitAuth ? 'Add git authentication…' : signedIn ? 'Create' : `Sign in to ${TOOL_LABEL[tool]}…`}
              </button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** One field of the form: a fixed label column, then the control (which
 *  carries its own aria-label). */
function Row({ label, title, children }: { label: string; title?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="mx-1 mb-1 flex items-start gap-2 px-1 py-0.5 text-xs text-text-dim" title={title}>
      <span className="w-[76px] shrink-0 pt-[5px]">{label}</span>
      {children}
    </div>
  )
}
