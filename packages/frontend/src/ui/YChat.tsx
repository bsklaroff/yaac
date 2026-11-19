import { useState, type JSX, type ReactNode } from 'react'
import { cn } from './cn'
import { SendIcon } from '#lib/icons'
import { YButton, type YButtonVariant } from './YButton'

/*
 * The parts of a chat: the user's message, the agent's prose, an ask the
 * agent is blocked on, and the composer's frame.
 */

/** What the user sent, right-aligned on the selected fill. */
export function YUserMessage({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={cn('ml-auto w-fit max-w-[min(560px,85%)] rounded-md bg-selected px-3.5 py-2.5 text-base text-text',
      'break-words', className)}>
      {children}
    </div>
  )
}

/** The agent's prose. Wraps rendered markdown. */
export function YAgentText({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={cn('min-w-0 text-base text-text', className)}>{children}</div>
}

export interface YAskAction {
  label: string
  variant?: YButtonVariant
  onClick: () => void
}

/**
 * Something the agent is blocked on until you answer: a command to allow,
 * a question, an edit or a plan. `actions` answer it (the first is the
 * primary); `options` are numbered choices for a question; `onReply` adds
 * the "tell it what to do instead" field. `children` show what is being
 * asked about (the command, the diff). Without answers it says who it is
 * waiting on (`waiting`).
 */
export function YAsk({ title, description, actions = [], options, onReply, busy = false, waiting, children, className }: {
  title: ReactNode
  description?: ReactNode
  actions?: readonly YAskAction[]
  options?: readonly { label: ReactNode; onPick: () => void }[]
  onReply?: (text: string) => void
  busy?: boolean
  waiting?: ReactNode
  children?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div role="group" aria-label="Waiting for your answer"
      className={cn('rounded-md border border-warning/40 bg-warning-soft p-3.5', className)}>
      <div className="flex items-center gap-2 text-base font-semibold text-text">
        <AskMark />
        <span className="min-w-0">{title}</span>
      </div>
      {description && <p className="mt-2 text-md text-muted">{description}</p>}
      {children && <div className="mt-2 min-w-0">{children}</div>}
      {options && options.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {options.map((o, i) => (
            <button
              key={i}
              type="button"
              disabled={busy}
              onClick={o.onPick}
              className="flex min-h-8 items-center gap-2.5 rounded-sm bg-sunken px-2.5 text-left text-md text-text
                outline-none hover:bg-selected focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
            >
              <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-xs text-xs text-subtle shadow-inset">
                {i + 1}
              </span>
              {o.label}
            </button>
          ))}
        </div>
      )}
      {actions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {actions.map((a, i) => (
            <YButton key={a.label} variant={a.variant ?? (i === 0 ? 'primary' : 'secondary')} disabled={busy} onClick={a.onClick}>
              {a.label}
            </YButton>
          ))}
        </div>
      )}
      {waiting && <p className="mt-2 text-md text-subtle">{waiting}</p>}
      {onReply && <AskReply onReply={onReply} busy={busy} />}
    </div>
  )
}

function AskReply({ onReply, busy }: { onReply: (text: string) => void; busy: boolean }): JSX.Element {
  const [text, setText] = useState('')
  const send = (): void => { const t = text.trim(); if (t) { onReply(t); setText('') } }
  return (
    <div className="mt-3 flex h-9 items-center gap-2 rounded-sm bg-sunken pl-3 pr-1 shadow-inset">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send() } }}
        disabled={busy}
        placeholder="Or tell it what to do instead"
        aria-label="Tell it what to do instead"
        className="min-w-0 flex-1 bg-transparent text-md text-text outline-none placeholder:text-subtle"
      />
      <YButton variant="ghost" size="sm" icon={SendIcon} aria-label="Send" disabled={busy || !text.trim()} onClick={send} />
    </div>
  )
}

/** The amber question mark an ask leads with. */
function AskMark(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="shrink-0">
      <rect x="1" y="1" width="12" height="12" fill="var(--warning)" />
      <path d="M5.25 5.35a1.8 1.8 0 1 1 2.5 1.65c-.5.22-.75.6-.75 1.05v.25" stroke="var(--on-warning)" strokeWidth="1.6"
        strokeLinecap="square" />
      <rect x="6.15" y="9.45" width="1.7" height="1.7" fill="var(--on-warning)" />
    </svg>
  )
}

/** The composer's frame: the text area (`children`), then a toolbar with
 *  its chips on the left (`tools`) and the send control on the right. */
export function YComposer({ tools, send, children, className }: {
  tools?: ReactNode
  send?: ReactNode
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={cn('flex flex-col rounded-md bg-surface shadow-inset focus-within:shadow-control', className)}>
      {children}
      <div className="flex min-h-10 items-center gap-1 px-2 pb-2">
        <div className="flex min-w-0 flex-1 items-center gap-0.5">{tools}</div>
        {send}
      </div>
    </div>
  )
}
