import { useId, useState, type JSX } from 'react'
import clsx from 'clsx'
import { modelItem } from '#components/ComposerMenu'
import {
  AcceptEditsIcon, AskFirstIcon, AutoReviewIcon, BypassIcon, ChevronIcon, PlanIcon, ReadOnlyIcon, type Icon,
} from '#lib/icons'
import { useSnapshotSelect } from '#lib/useSnapshot'
import type { AcpModel } from '@yaac/shared/acp'
import {
  AGENT_OPTIONS,
  effortLabel,
  PERMISSION_MODE_COPY,
  type AgentOption,
  type AgentOptions,
  type PermissionMode,
} from '@yaac/shared/types'
import {
  filterSuggestions, MENU_ITEM, suggestionId, YCheckbox, YChip, YInput, YMenu, YMenuPopup, YMenuRadioItem, YPopover,
  YPopoverPopup, YRadioGrid, YSuggestionList,
} from '#ui'

/*
 * The composer's agent settings, as two pills, the same in a chat and in
 * the new-workspace pane. One is the
 * permission posture (docs/permission-modes.md), kept on its own so what
 * the agent may do without asking is always in view. The other holds the
 * model, its effort level (docs/effort-levels.md) and the agent options
 * (docs/sessions.md), since the effort levels on offer follow the model. In
 * a narrow pane the posture shrinks to a bare icon, and both pills truncate
 * their labels rather than run under the buttons beside them
 * (`COMPOSER_ROW`); the model name gives way faster than the effort.
 */

/** What each posture lets the agent do, for hover text and the menu. */
const PERMISSION_MODE_HELP: Record<PermissionMode, string> = {
  bypass: 'The agent acts without ever asking.',
  auto: 'The agent acts without asking, but a reviewer model judges each action'
    + ' and blocks the dangerous ones. Claude gates this by subscription plan.',
  'accept-edits': 'The agent edits files in the workspace without asking, and still'
    + ' asks before running commands or reaching outside it.',
  manual: 'The agent asks before every action.',
  plan: 'The agent explores and plans read-only; it cannot edit until you approve a plan.',
  'read-only': 'The agent reads and explores freely inside a read-only sandbox, and asks before'
    + ' every edit and anything that reaches the network.',
}

/** Why containerless `bypass` is tinted: the agent then acts as the user on
 *  this machine. */
const NO_SANDBOX = 'No sandbox — acts as you.'

const PERMISSION_MODE_ICON: Record<PermissionMode, Icon> = {
  bypass: BypassIcon,
  auto: AutoReviewIcon,
  'accept-edits': AcceptEditsIcon,
  manual: AskFirstIcon,
  plan: PlanIcon,
  'read-only': ReadOnlyIcon,
}

/** The permission posture as plain text, where it has no menu. */
const PILL = 'flex min-w-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1 text-md text-subtle'

/**
 * The conversation's permission posture. Where it can't be switched
 * (opencode, pi) the pill is plain text. Under containerless, `bypass` is
 * tinted, and carries a warning in its menu row, hover text and accessible
 * name, since there the agent acts as the user on this machine.
 */
export function PermissionModeSelect({ current, available, disabled, onSelect }: {
  current: PermissionMode
  available: readonly PermissionMode[]
  disabled: boolean
  onSelect: (mode: PermissionMode) => void
}): JSX.Element {
  const containerless = useSnapshotSelect((s) => s?.driver) === 'containerless'
  const ModeIcon = PERMISSION_MODE_ICON[current]
  const unsandboxed = current === 'bypass' && containerless
  const help = `${PERMISSION_MODE_HELP[current]}${unsandboxed ? ` ${NO_SANDBOX}` : ''}`
  const label = (
    <>
      <ModeIcon size={13} className="shrink-0" />
      {/* Visually hidden rather than removed when narrow, so a screen reader
          still names a posture that has no menu (pi, opencode). */}
      <span className="sr-only @min-[30rem]:not-sr-only @min-[30rem]:truncate">
        {PERMISSION_MODE_COPY[current].replace(/ permissions$/, '')}
      </span>
      {unsandboxed && <span className="sr-only"> ({NO_SANDBOX})</span>}
    </>
  )
  const tint = unsandboxed && 'text-warning'
  if (available.length === 0) return <span className={clsx(PILL, tint)} title={help}>{label}</span>
  return (
    <YMenu.Root>
      <YMenu.Trigger
        aria-label="Permission mode"
        title={help}
        disabled={disabled}
        render={<YChip className={clsx('shrink', tint)} />}
      >
        {label}
        <ChevronIcon size={11} className="hidden -rotate-90 @min-[30rem]:block" />
      </YMenu.Trigger>
      <YMenuPopup side="top" align="start" sideOffset={6} className="w-[280px]">
        <YMenu.RadioGroup value={current} onValueChange={(mode: PermissionMode) => onSelect(mode)}>
          {available.map((m) => (
            <YMenuRadioItem key={m} value={m} closeOnClick className="items-start">
              <span className="flex flex-col gap-0.5">
                <span className="text-text">{PERMISSION_MODE_COPY[m]}</span>
                <span className="text-sm text-subtle">{PERMISSION_MODE_HELP[m]}</span>
                {m === 'bypass' && containerless && (
                  <span className="text-sm text-warning">{NO_SANDBOX}</span>
                )}
              </span>
            </YMenuRadioItem>
          ))}
        </YMenu.RadioGroup>
      </YMenuPopup>
    </YMenu.Root>
  )
}

/** The models to pick from; `tag` marks a row (the running model, the
 *  project's default). */
interface ModelChoice {
  current: string | undefined
  items: readonly AcpModel[]
  onSelect: (id: string) => void
  tag: (id: string) => string | false
}
/** The effort levels its current model offers, in the tool's words. */
interface EffortChoice {
  current: string
  available: readonly string[]
  onSelect: (effort: string) => void
}
/** The agent options it can change (`AGENT_OPTIONS`); `onChange` gets the
 *  one that changed. */
interface OptionsChoice {
  list: readonly AgentOption[]
  value: AgentOptions
  onChange: (changed: AgentOptions) => void
}

/**
 * The model pill: the model and effort level as its label, opening a
 * popover with a searchable model list, the effort levels and the agent
 * options. A section is left out when its prop is undefined, and the pill
 * when all three are. Picking a model closes the popover; effort and
 * options stay open, since several may be changed at once.
 */
export function AgentSettings({ model, effort, options: given, disabled }: {
  model: ModelChoice | undefined
  effort: EffortChoice | undefined
  options: OptionsChoice | undefined
  disabled: boolean
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const options = given !== undefined && given.list.length > 0 ? given : undefined
  if (model === undefined && effort === undefined && options === undefined) return null
  const modelName = model === undefined
    ? undefined
    : model.items.find((m) => m.id === model.current)?.name ?? model.current ?? 'Model'
  const effortName = effort === undefined ? undefined : effortLabel(effort.current)
  const on = options?.list.filter((o) => options.value[o] === true).length ?? 0
  const title = [
    ...(modelName !== undefined ? [`Model: ${modelName}`] : []),
    ...(effortName !== undefined ? [`Effort: ${effortName}`] : []),
    ...(options?.list.map((o) => `${AGENT_OPTIONS[o].label}: ${options.value[o] === true ? 'on' : 'off'}`) ?? []),
  ].join('\n')
  return (
    <YPopover.Root open={open} onOpenChange={setOpen}>
      <YPopover.Trigger aria-label="Agent settings" title={title} disabled={disabled} render={<YChip className="shrink" />}>
        {modelName !== undefined && <span className="min-w-0 max-w-[14rem] truncate">{modelName}</span>}
        {effortName !== undefined && (
          <span className="min-w-0 shrink-[0.2] truncate">
            {modelName !== undefined ? `· ${effortName}` : `${effortName} effort`}
          </span>
        )}
        {modelName === undefined && effortName === undefined && (
          <span className="truncate">{on === 0 ? 'Options' : `Options (${String(on)})`}</span>
        )}
        <ChevronIcon size={11} className="shrink-0 -rotate-90" />
      </YPopover.Trigger>
      <YPopoverPopup
        side="top"
        align="start"
        sideOffset={6}
        className="flex w-[320px] max-w-[calc(100vw-1rem)] flex-col gap-1"
        // React events bubble through the portal, and the new-workspace pane
        // creates on an Enter from anywhere inside it.
        onKeyDown={(e) => { if (e.key === 'Enter') e.stopPropagation() }}
      >
        {model !== undefined && <ModelPicker {...model} onSelect={(id) => { model.onSelect(id); setOpen(false) }} />}
        {effort !== undefined && (
          <Section title="Effort">
            <YRadioGrid
              ariaLabel="Effort"
              value={effort.current}
              onChange={(level) => effort.onSelect(level)}
              options={effort.available.map((level) => ({ value: level, label: effortLabel(level) }))}
              className="mx-1"
            />
          </Section>
        )}
        {options !== undefined && (
          <Section title="Options">
            {options.list.map((o) => (
              <label key={o} className={clsx(MENU_ITEM, 'items-start hover:bg-line-strong')}>
                <YCheckbox
                  checked={options.value[o] === true}
                  onCheckedChange={(checked) => options.onChange({ [o]: checked })}
                  className="mt-0.5"

                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-text">{AGENT_OPTIONS[o].label}</span>
                  <span className="text-sm text-subtle">{AGENT_OPTIONS[o].hint}</span>
                </span>
              </label>
            ))}
          </Section>
        )}
      </YPopoverPopup>
    </YPopover.Root>
  )
}


function Section({ title, children }: { title: string; children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <div className="flex flex-col gap-1 border-t border-line pt-1.5 first:border-t-0 first:pt-0">
      <div className="px-2 text-xs font-medium uppercase tracking-wide text-subtle">{title}</div>
      {children}
    </div>
  )
}

/**
 * A search box over the model list, which opens on the current model as a
 * TUI's picker does. The search box comes first so a mouse or keyboard open
 * focuses it; a touch open focuses the popup instead (Base UI's default),
 * so a phone's keyboard stays down until the box is tapped.
 */
function ModelPicker({ current, items, onSelect, tag }: ModelChoice): JSX.Element {
  const [query, setQuery] = useState('')
  /** The highlight, tagged with the query it was moved under. */
  const [highlight, setHighlight] = useState({ query: '', index: -1 })
  const listId = useId()
  // Uncapped: opencode and pi list hundreds, and the list scrolls.
  const rows = filterSuggestions(items.map(modelItem), query, Number.POSITIVE_INFINITY)
  const start = query === '' ? Math.max(0, rows.findIndex((r) => r.value === current)) : 0
  const active = highlight.query === query && highlight.index >= 0 && highlight.index < rows.length ? highlight.index : start
  return (
    <Section title="Model">
      <YInput
        aria-label="Search models"
        role="combobox"
        aria-expanded
        aria-autocomplete="list"
        aria-controls={listId}
        {...(rows.length > 0 ? { 'aria-activedescendant': suggestionId(listId, active) } : {})}
        placeholder="Search models…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (rows.length === 0 || e.nativeEvent.isComposing) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const step = e.key === 'ArrowDown' ? 1 : -1
            setHighlight({ query, index: (active + step + rows.length) % rows.length })
          } else if (e.key === 'Enter') {
            onSelect(rows[active].value)
          } else {
            return
          }
          e.preventDefault()
        }}
        className="mx-1 font-mono"
      />

      {rows.length === 0
        ? <div className="px-2 py-1 text-sm text-subtle">No matches</div>
        : (
          <YSuggestionList
            id={listId}
            rows={rows}
            active={active}
            onSelect={onSelect}
            onHover={(index) => setHighlight({ query, index })}
            tag={(item) => tag(item.value)}
            className="max-h-60"
          />
        )}
    </Section>
  )
}
