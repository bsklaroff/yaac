import { useId, useState, type JSX, type KeyboardEvent } from 'react'
import { filterSuggestions, suggestionId, SuggestionList, type TypeaheadItem } from '#components/ui/Typeahead'
import type { AcpCommand, AcpEvent, AcpModel } from '@yaac/shared/acp'

/**
 * The chat composer's completion menu, as a TUI offers one: typing `/` lists
 * the slash commands the agent advertises, and `/model ` lists the models the
 * session can switch to. The lists come from the conversation's latest
 * `commands` and `models` events.
 *
 * Skills arrive as commands too, spelled as each tool's TUI spells them:
 * claude's as plain `/name`, pi's as `/skill:name`, and codex's as `$name`,
 * a mention codex resolves inside the message. So a command named `$name` is
 * offered on `$` and inserted without a slash.
 *
 * Enter runs a slash command that takes no argument and completes the rest;
 * Tab always completes. `/model` is handled here rather than sent, since a
 * model switch is a protocol request, not a prompt; it is offered whenever
 * the session lists models, replacing any `model` command of the agent's.
 */

/** What the draft is asking to complete, if anything. */
type Menu = { kind: 'command' | 'model'; sigil: string; query: string }

function menuFor(draft: string, hasModels: boolean): Menu | undefined {
  const model = /^\/model\s+(.*)$/s.exec(draft)
  if (model !== null && hasModels) return { kind: 'model', sigil: '/', query: model[1] }
  const command = /^([/$])(\S*)$/.exec(draft)
  return command === null ? undefined : { kind: 'command', sigil: command[1], query: command[2] }
}

/** The text a command is typed as. */
function commandText(name: string): string {
  return name.startsWith('$') ? name : `/${name}`
}

function latest<T extends AcpEvent['type']>(
  events: readonly AcpEvent[],
  type: T,
): Extract<AcpEvent, { type: T }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === type) return events[i] as Extract<AcpEvent, { type: T }>
  }
  return undefined
}

const MODEL_COMMAND: AcpCommand = { name: 'model', description: 'Switch the model' }

/** A command as a row. Its value drops a `$`, so the typed query ranks it as
 *  a prefix match; the menu lists one sigil's commands at a time, so values
 *  stay unique. */
function commandItem(c: AcpCommand): TypeaheadItem {
  return {
    value: c.name.replace(/^\$/, ''),
    label: commandText(c.name),
    ...(c.description !== undefined ? { detail: c.description } : {}),
  }
}

function modelItem(m: AcpModel): TypeaheadItem {
  const detail = m.name !== undefined ? m.id : m.description
  return { value: m.id, label: m.name ?? m.id, ...(detail !== undefined ? { detail } : {}) }
}

export function useComposerMenu({
  draft,
  events,
  disabled,
  setDraft,
  runCommand,
  switchModel,
}: {
  draft: string
  events: readonly AcpEvent[]
  /** The composer is locked (a message is in flight); offer nothing. */
  disabled: boolean
  setDraft: (text: string) => void
  /** Send a command that takes no argument, as the message `text`. */
  runCommand: (text: string) => void
  /** Ask for a model switch; false when it could not be sent. */
  switchModel: (modelId: string) => boolean
}): {
  menu: JSX.Element | null
  /** ARIA attributes tying the composer to the open menu. */
  inputProps: Record<string, string>
  /** Handle a composer key the open menu owns; true when it did. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
} {
  const [dismissed, setDismissed] = useState<string | null>(null)
  /** The highlight, tagged with the query it was moved under, so a new query
   *  starts back at the top. */
  const [highlight, setHighlight] = useState({ key: '', index: 0 })
  const listId = useId()

  const models = latest(events, 'models')
  const hasModels = (models?.models.length ?? 0) > 0
  const commands = latest(events, 'commands')?.commands ?? []
  const offered = hasModels ? [...commands.filter((c) => c.name !== 'model'), MODEL_COMMAND] : commands
  const at = disabled || dismissed === draft ? undefined : menuFor(draft, hasModels)
  const rows = at === undefined
    ? []
    : filterSuggestions(
      at.kind === 'model'
        ? (models?.models ?? []).map(modelItem)
        : offered.filter((c) => commandText(c.name).startsWith(at.sigil)).map(commandItem),
      at.query,
      // Uncapped, so the running model is always a row: opencode and pi
      // list hundreds, and the list scrolls.
      Number.POSITIVE_INFINITY,
    )
  const key = at === undefined ? '' : `${at.kind}:${at.query}`
  // The model list opens on the running model, as a TUI's picker does.
  const start = at?.kind === 'model' ? Math.max(0, rows.findIndex((r) => r.value === models?.current)) : 0
  const active = highlight.key === key && highlight.index < rows.length ? highlight.index : start
  const open = at !== undefined && rows.length > 0

  /** A row's command, typed out. */
  const typed = (value: string): string => (at?.sigil === '$' ? `$${value}` : `/${value}`)
  const complete = (value: string): void => setDraft(`${typed(value)} `)
  const pick = (value: string): void => {
    if (at?.kind === 'model') {
      if (switchModel(value)) setDraft('')
      return
    }
    const command = offered.find((c) => commandText(c.name) === typed(value))
    if (command === MODEL_COMMAND || command?.hint !== undefined || at?.sigil === '$') complete(value)
    else runCommand(typed(value))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1
      setHighlight({ key, index: (active + step + rows.length) % rows.length })
    } else if (e.key === 'Enter' && !e.shiftKey) {
      pick(rows[active].value)
    } else if (e.key === 'Tab' && !e.shiftKey) {
      if (at.kind === 'model') pick(rows[active].value)
      else complete(rows[active].value)
    } else if (e.key === 'Escape') {
      // Hidden until the draft changes.
      setDismissed(draft)
      e.stopPropagation()
    } else {
      return false
    }
    e.preventDefault()
    return true
  }

  const menu = open
    ? (
      <div className="mb-2 rounded-xl border border-border bg-surface p-1 shadow-sm">
        <SuggestionList
          id={listId}
          rows={rows}
          active={active}
          onSelect={pick}
          onHover={(index) => setHighlight({ key, index })}
          {...(at.kind === 'model' ? { tag: (item: TypeaheadItem) => item.value === models?.current && 'current' } : {})}
          className="max-h-60"
        />
      </div>
    )
    : null

  const inputProps: Record<string, string> = open
    ? { 'aria-autocomplete': 'list', 'aria-controls': listId, 'aria-activedescendant': suggestionId(listId, active) }
    : {}

  return { menu, inputProps, onKeyDown }
}
