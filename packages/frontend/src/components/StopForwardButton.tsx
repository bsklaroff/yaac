import type { JSX } from 'react'
import { CloseIcon } from '#lib/icons'
import { YButton } from '#ui'

/**
 * The × that stops forwarding a port, shown while its `group` parent (the
 * Preview button or a port menu row) is hovered or highlighted. It keeps
 * its click from the parent, so stopping a port never also opens it.
 */
export function StopForwardButton({
  containerPort,
  onStop,
}: {
  containerPort: number
  onStop: (containerPort: number) => void
}): JSX.Element {
  return (
    <YButton
      variant="ghost"
      size="sm"
      icon={CloseIcon}
      onClick={(e) => { e.stopPropagation(); onStop(containerPort) }}
      onMouseUp={(e) => e.stopPropagation()}
      title={`Stop forwarding port ${containerPort}`}
      aria-label={`Stop forwarding port ${containerPort}`}
      className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-data-[highlighted]:opacity-100"
    />
  )
}
