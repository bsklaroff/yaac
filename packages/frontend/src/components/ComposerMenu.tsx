import {
  useId, useLayoutEffect, useRef, useState,
  type JSX, type KeyboardEvent, type RefObject, type TextareaHTMLAttributes,
} from 'react'
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
 * A command can be typed anywhere in the message, not only at its start: the
 * menu completes the word ending at the caret when that word begins with the
 * sigil. Enter runs a slash command that takes no argument only when it is
 * the whole message. Mid-message, Enter completes only once the user has
 * moved the highlight, since a message that merely ends in a slash-word is
 * more likely meant to be sent; Tab always completes. `/model` is handled
 * here rather than sent, since a model switch is a protocol request, not a
 * prompt; it is offered whenever the session lists models, replacing any
 * `model` command of the agent's.
 */

/** What the draft is asking to complete, if anything, and the span of the
 *  draft (`from` to `to`) a completion replaces. */
type Menu = { kind: 'command' | 'model'; sigil: string; query: string; from: number; to: number }

function menuFor(draft: string, caret: number, hasModels: boolean): Menu | undefined {
  const model = /^\/model\s+(.*)$/s.exec(draft)
  if (model !== null && hasModels) return { kind: 'model', sigil: '/', query: model[1], from: 0, to: draft.length }
  // A word starting the message or following whitespace, with the caret at
  // its end. The query stops at a second sigil, so a path like `/tmp/x`
  // offers nothing.
  const command = /(?:^|\s)([/$])([^\s/$]*)$/.exec(draft.slice(0, caret))
  if (command === null || /^\S/.test(draft.slice(caret))) return undefined
  const from = caret - command[2].length - 1
  return { kind: 'command', sigil: command[1], query: command[2], from, to: caret }
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
  inputRef,
  draft,
  events,
  disabled,
  setDraft,
  runCommand,
  switchModel,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>
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
  /** ARIA attributes tying the composer to the open menu, and the caret
   *  tracking it completes at. */
  inputProps: TextareaHTMLAttributes<HTMLTextAreaElement>
  /** Handle a composer key the open menu owns; true when it did. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
} {
  const [dismissed, setDismissed] = useState<string | null>(null)
  /** The highlight, tagged with the query it was moved under, so a new query
   *  starts back at the top. */
  const [highlight, setHighlight] = useState({ key: '', index: 0 })
  const listId = useId()
  /** The caret, tagged with the draft it was read under. Typing changes the
   *  draft before the browser reports the new caret, so until it does the
   *  caret is taken to be at the end, where typing usually is. */
  const [selection, setSelection] = useState({ draft: '', caret: 0 })
  const caret = selection.draft === draft ? selection.caret : draft.length
  /** Where to put the caret once a completion is rendered. Applied on a new
   *  selection rather than a new draft, since completing a word that is
   *  already complete leaves the draft unchanged. */
  const placeRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (placeRef.current === null) return
    inputRef.current?.setSelectionRange(placeRef.current, placeRef.current)
    placeRef.current = null
  }, [selection, inputRef])

  const models = latest(events, 'models')
  const hasModels = (models?.models.length ?? 0) > 0
  const commands = latest(events, 'commands')?.commands ?? []
  const offered = hasModels ? [...commands.filter((c) => c.name !== 'model'), MODEL_COMMAND] : commands
  const at = disabled || dismissed === draft ? undefined : menuFor(draft, caret, hasModels)
  const rows = at === undefined
    ? []
    : filterSuggestions(
      at.kind === 'model'
        ? (models?.models ?? []).map(modelItem)
        : offered
          // The model picker opens only from the start of the message.
          .filter((c) => commandText(c.name).startsWith(at.sigil) && (at.from === 0 || c !== MODEL_COMMAND))
          .map(commandItem),
      at.query,
      // Uncapped, so the running model is always a row: opencode and pi
      // list hundreds, and the list scrolls.
      Number.POSITIVE_INFINITY,
    )
  const key = at === undefined ? '' : `${at.kind}:${String(at.from)}:${at.query}`
  // The model list opens on the running model, as a TUI's picker does.
  const start = at?.kind === 'model' ? Math.max(0, rows.findIndex((r) => r.value === models?.current)) : 0
  const active = highlight.key === key && highlight.index < rows.length ? highlight.index : start
  const open = at !== undefined && rows.length > 0
  /** The word is the whole message, so Enter may act on it unprompted. */
  const whole = at !== undefined && at.from === 0 && draft.slice(at.to).trim() === ''

  /** A row's command, typed out. */
  const typed = (value: string): string => (at?.sigil === '$' ? `$${value}` : `/${value}`)
  /** Replace the word being typed with the command and a space. */
  const complete = (value: string): void => {
    if (at === undefined) return
    const before = `${draft.slice(0, at.from)}${typed(value)} `
    const text = before + draft.slice(at.to).replace(/^ /, '')
    placeRef.current = before.length
    setSelection({ draft: text, caret: before.length })
    setDraft(text)
  }
  const pick = (value: string): void => {
    if (at === undefined) return
    if (at.kind === 'model') {
      if (switchModel(value)) setDraft('')
      return
    }
    const command = offered.find((c) => commandText(c.name) === typed(value))
    if (!whole || command === MODEL_COMMAND || command?.hint !== undefined || at.sigil === '$') complete(value)
    else runCommand(typed(value))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1
      setHighlight({ key, index: (active + step + rows.length) % rows.length })
    } else if (e.key === 'Enter' && !e.shiftKey) {
      if (!whole && highlight.key !== key) return false
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

  const inputProps: TextareaHTMLAttributes<HTMLTextAreaElement> = {
    onSelect: (e) => setSelection({ draft: e.currentTarget.value, caret: e.currentTarget.selectionStart }),
    ...(open
      ? { 'aria-autocomplete': 'list', 'aria-controls': listId, 'aria-activedescendant': suggestionId(listId, active) }
      : {}),
  }

  return { menu, inputProps, onKeyDown }
}
