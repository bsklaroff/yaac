import type { JSX } from 'react'
import { CloseIcon } from '#lib/icons'

/**
 * The × that stops forwarding a port, shown while its `group` parent (the
 * Preview button or a port menu row) is hovered or highlighted. It keeps
 * its click from the parent, so stopping a port never also opens it.
 */
export function StopForwardButton({
  containerPort,
  iconSize,
  onStop,
}: {
  containerPort: number
  iconSize: number
  onStop: (containerPort: number) => void
}): JSX.Element {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onStop(containerPort) }}
      onMouseUp={(e) => e.stopPropagation()}
      title={`Stop forwarding port ${containerPort}`}
      aria-label={`Stop forwarding port ${containerPort}`}
      className="-ml-0.5 mr-0.5 flex items-center text-text-faint opacity-0 transition
        hover:text-text focus-visible:opacity-100 group-hover:opacity-100
        group-data-[highlighted]:opacity-100"
    >
      <CloseIcon size={iconSize - 2} />
    </button>
  )
}
