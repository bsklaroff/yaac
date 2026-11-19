import { useRef, type InputHTMLAttributes, type JSX } from 'react'
import { cn } from './cn'
import { StepDownIcon, StepUpIcon } from '#lib/icons'
import { FIELD_BOX } from './YInput'

/**
 * A number field whose step arrows are drawn to match the app, in place of
 * the browser's spin buttons (which ignore the theme). `className` styles the
 * outer box (size, background); the rest goes to the <input>, so it works
 * controlled or as a plain form field.
 *
 * The arrows call the input's own stepUp/stepDown, so min, max and step
 * apply as they do for the arrow keys, and then fire an input event, which
 * React reports as a change. They keep focus on the field and stay out of
 * the tab order, since the arrow keys already step it.
 */
export function YNumberInput({ className, ...props }: { className?: string }
  & Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'>): JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const step = (up: boolean): void => {
    const el = input.current
    if (!el || el.disabled) return
    if (up) el.stepUp()
    else el.stepDown()
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.focus()
  }
  const arrow = 'flex flex-1 items-center justify-center px-1 text-subtle transition hover:bg-hover hover:text-text'
  return (
    <div className={cn(FIELD_BOX, 'flex overflow-hidden', className)}>
      <input
        ref={input}
        type="number"
        {...props}
        className="min-w-0 flex-1 bg-transparent pl-2 outline-none [appearance:textfield]
          [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <div className="flex flex-col border-l border-line">
        {([true, false] as const).map((up) => (
          <button
            key={String(up)}
            type="button"
            tabIndex={-1}
            aria-label={up ? 'Increase' : 'Decrease'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => step(up)}
            className={cn(arrow, !up && 'border-t border-line')}
          >
            {up ? <StepUpIcon size={10} strokeWidth={2.5} /> : <StepDownIcon size={10} strokeWidth={2.5} />}
          </button>
        ))}
      </div>
    </div>
  )
}
