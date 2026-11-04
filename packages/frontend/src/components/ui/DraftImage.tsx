import { useMemo, type JSX } from 'react'
import type { AcpImage } from '@yaac/shared/acp'
import { CloseIcon } from '#lib/icons'

/** An image attached to a draft, removable until it is sent. Memoized
 *  because the data URL can be megabytes. */
export function DraftImage({ image, onRemove }: { image: AcpImage; onRemove?: () => void }): JSX.Element {
  const src = useMemo(() => `data:${image.mimeType};base64,${image.data}`, [image])
  return (
    <div className="relative">
      <img src={src} alt="" className="h-14 rounded-lg border border-hairline" />
      {onRemove && (
        <button
          type="button"
          aria-label="Remove image"
          onClick={onRemove}
          className="absolute -top-1.5 -right-1.5 rounded-full border border-hairline bg-surface-2
            p-0.5 text-text-dim hover:text-text"
        >
          <CloseIcon size={10} />
        </button>
      )}
    </div>
  )
}
