import { useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ProjectChip, railChipStyle } from '#components/ProjectRail'
import { BUTTON, TEXT_BUTTON } from '#components/ui/button'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { api } from '#lib/api'
import { imageFiles } from '#lib/attachments'
import { identityColor, projectIconUrl } from '#lib/projectIdentity'
import type { ProjectSummary } from '@yaac/shared/types'

/*
 * The project's icon setting: an image the user pastes, drops or picks is
 * cropped to a square in `IconCropper` and uploaded as a PNG. Every image,
 * SVG included, is drawn to a canvas first, so the server only ever stores
 * a raster image; an SVG can carry script, which a stored copy served from
 * yaac's origin could run if opened directly.
 */

const icon = api.project[':projectId'].icon

/** Edge of the stored picture in pixels: sharp on the 40px rail chip up to
 *  6.4 device pixels per CSS pixel, a 2x screen with the page zoomed 300%. */
const ICON_EDGE = 256
/** Edge of the crop square on screen, in CSS pixels. */
const VIEW = 240
const MAX_ZOOM = 4

/** The image's natural size. */
interface Size { w: number; h: number }
/** How the image sits under the crop square: its zoom over just covering
 *  the square, and its top-left corner relative to the square's. */
interface Crop { zoom: number; x: number; y: number }

/** CSS pixels per image pixel at `zoom`. */
const scaleOf = (size: Size, zoom: number): number => VIEW / Math.min(size.w, size.h) * zoom

/** `crop` moved as little as needed for the image to cover the square. */
function clamped(size: Size, crop: Crop): Crop {
  const scale = scaleOf(size, crop.zoom)
  const fit = (at: number, length: number): number => Math.min(0, Math.max(VIEW - length * scale, at))
  return { zoom: crop.zoom, x: fit(crop.x, size.w), y: fit(crop.y, size.h) }
}

/** Read a file as a data URL, which the SPA's CSP lets an `<img>` load
 *  (a `blob:` URL it does not). */
function dataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('could not read the image'))
    reader.readAsDataURL(file)
  })
}

/**
 * A square crop over `src`: drag the image to place it, zoom with the slider,
 * the scroll wheel or +/-, and nudge with the arrow keys. It starts centered
 * and just covering the square, and never lets an edge show inside it. The
 * shaded corners show the chip's rounded outline. `onCrop` receives the
 * square drawn at `ICON_EDGE` as a PNG.
 */
function IconCropper({ src, busy, error, onCancel, onCrop }: {
  src: string
  busy: boolean
  error: string | undefined
  onCancel: () => void
  onCrop: (png: Blob) => void
}): JSX.Element {
  const img = useRef<HTMLImageElement>(null)
  const [size, setSize] = useState<Size | null>(null)
  const [crop, setCrop] = useState<Crop>({ zoom: 1, x: 0, y: 0 })
  const [readError, setReadError] = useState<string>()

  const move = (dx: number, dy: number): void => {
    if (size) setCrop((c) => clamped(size, { ...c, x: c.x + dx, y: c.y + dy }))
  }
  /** Zoom about the square's center. */
  const zoomTo = (zoom: number): void => {
    if (!size) return
    setCrop((c) => {
      const next = Math.min(MAX_ZOOM, Math.max(1, zoom))
      const k = next / c.zoom
      return clamped(size, { zoom: next, x: VIEW / 2 - (VIEW / 2 - c.x) * k, y: VIEW / 2 - (VIEW / 2 - c.y) * k })
    })
  }
  const drag = (e: ReactPointerEvent): void => {
    let last = { x: e.clientX, y: e.clientY }
    const onMove = (m: PointerEvent): void => {
      move(m.clientX - last.x, m.clientY - last.y)
      last = { x: m.clientX, y: m.clientY }
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }
  const save = async (): Promise<void> => {
    if (!size || !img.current) return
    const scale = scaleOf(size, crop.zoom)
    const canvas = new OffscreenCanvas(ICON_EDGE, ICON_EDGE)
    canvas.getContext('2d')?.drawImage(
      img.current, -crop.x / scale, -crop.y / scale, VIEW / scale, VIEW / scale, 0, 0, ICON_EDGE, ICON_EDGE,
    )
    try {
      onCrop(await canvas.convertToBlob({ type: 'image/png' }))
    } catch (err) {
      setReadError(`could not draw this image: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const scale = size ? scaleOf(size, crop.zoom) : 0
  const shown = readError ?? error

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open) onCancel() }}
      title="Crop icon"
      description="Drag the image to choose what the icon shows, and zoom with the slider or the scroll wheel."
      confirmLabel="Save"
      destructive={false}
      busy={busy}
      {...(shown !== undefined ? { error: shown } : {})}
      onConfirm={() => { void save() }}
    >
      <div
        role="group"
        aria-label="Crop area"
        tabIndex={0}
        onPointerDown={drag}
        onWheel={(e) => zoomTo(crop.zoom * Math.exp(-e.deltaY * 0.002))}
        onKeyDown={(e) => {
          const step = { ArrowLeft: [8, 0], ArrowRight: [-8, 0], ArrowUp: [0, 8], ArrowDown: [0, -8] }[e.key]
          if (step) { e.preventDefault(); move(step[0], step[1]) }
          if (e.key === '+' || e.key === '=') zoomTo(crop.zoom * 1.1)
          if (e.key === '-') zoomTo(crop.zoom / 1.1)
        }}
        className="relative mx-auto mt-4 cursor-move touch-none select-none overflow-hidden rounded-md bg-bg
          outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
        style={{ width: VIEW, height: VIEW }}
      >
        <img
          ref={img}
          src={src}
          alt=""
          draggable={false}
          onLoad={(e) => {
            const { naturalWidth: w, naturalHeight: h } = e.currentTarget
            if (w === 0 || h === 0) { setReadError('this image has no size to crop'); return }
            const fit = scaleOf({ w, h }, 1)
            setSize({ w, h })
            setCrop({ zoom: 1, x: (VIEW - w * fit) / 2, y: (VIEW - h * fit) / 2 })
          }}
          onError={() => setReadError('could not read this image')}
          className="absolute max-w-none"
          style={size
            ? { left: crop.x, top: crop.y, width: size.w * scale, height: size.h * scale }
            : { visibility: 'hidden' }}
        />
        {/* The chip's rounded outline; the shade outside it is cropped off by its corners. */}
        <div className="pointer-events-none absolute inset-0 rounded-[30%] shadow-[0_0_0_200px_rgb(0_0_0/0.45)]" />
      </div>
      <input
        type="range"
        aria-label="Zoom"
        min={1}
        max={MAX_ZOOM}
        step={0.01}
        value={crop.zoom}
        disabled={size === null}
        onChange={(e) => zoomTo(Number(e.target.value))}
        className="mx-auto mt-3 block w-[240px]"
      />
    </ConfirmDialog>
  )
}

/**
 * The picture the project's rail chip shows instead of its initial: pasted
 * or dropped on the preview chip, or picked from a file, then cropped. Its
 * Download link keeps dots out of the suggested file name, since a browser
 * reads one as the extension and then adds none from the picture's type.
 */
export function ProjectIcon({ project, readOnly }: { project: ProjectSummary; readOnly: boolean }): JSX.Element {
  const param = { projectId: project.id }
  const [picked, setPicked] = useState<string | null>(null)
  const upload = useMutation({
    mutationFn: (png: Blob) => icon.$put({ param }, { init: { body: png, headers: { 'Content-Type': 'image/png' } } }),
    onSuccess: () => setPicked(null),
  })
  const remove = useMutation({ mutationFn: () => icon.$delete({ param }) })
  const [readError, setReadError] = useState<string>()
  const take = (files: File[]): void => {
    if (readOnly || files[0] === undefined) return
    setReadError(undefined)
    upload.reset()
    dataUrl(files[0]).then(setPicked, (err: unknown) => setReadError(err instanceof Error ? err.message : String(err)))
  }
  const error = readError ?? remove.error?.message

  return (
    <div>
      <div className="text-xs font-medium text-text">Icon</div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        Shown in the project rail in place of the project&apos;s initial.
        {!readOnly && ' Click the icon and paste an image, drop one on it, or choose a file.'}
      </p>
      <div
        className="mt-2 flex items-center gap-2"
        onPaste={(e) => take(imageFiles(e.clipboardData))}
        onDragOver={(e) => { if (!readOnly) e.preventDefault() }}
        onDrop={(e) => { e.preventDefault(); take(imageFiles(e.dataTransfer)) }}
      >
        <div
          tabIndex={readOnly ? -1 : 0}
          aria-label="Project icon"
          className="rounded-xl outline-none focus:ring-2 focus:ring-border-strong"
        >
          <ProjectChip
            project={project}
            op={undefined}
            iconSize={18}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-[16px] font-semibold"
            style={railChipStyle(identityColor(project.id), true)}
          />
        </div>
        {!readOnly && (
          <label className={`${BUTTON} cursor-pointer`}>
            Choose image…
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => { take([...e.target.files ?? []]); e.target.value = '' }}
            />
          </label>
        )}
        {project.iconHash !== undefined && <>
          <a href={projectIconUrl(project.id, project.iconHash)} download={`${project.name.replaceAll('.', '-')} icon`} className={TEXT_BUTTON}>
            Download
          </a>
          {!readOnly && (
            <button type="button" onClick={() => remove.mutate()} disabled={remove.isPending} className={TEXT_BUTTON}>
              Remove
            </button>
          )}
        </>}
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      {picked !== null && (
        <IconCropper
          key={picked}
          src={picked}
          busy={upload.isPending}
          error={upload.error?.message}
          onCancel={() => setPicked(null)}
          onCrop={(png) => upload.mutate(png)}
        />
      )}
    </div>
  )
}
