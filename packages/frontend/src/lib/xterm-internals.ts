import type { Terminal } from '@xterm/xterm'

/**
 * The private xterm internals the terminal patches reach into (#lib/selection,
 * #lib/wheel-pacing, #lib/touch-scroll). xterm has no public hooks for them.
 * @xterm/xterm is pinned to an exact version and the unit tests run
 * `xtermCore` against the real package, so an upgrade that renames any of
 * these fails there rather than in the browser.
 */

/** Pixel position and zero-based cell of a mouse event. */
export type ReportCoords = { col: number; row: number; x: number; y: number }

/** xterm's ICoreMouseEvent: a mouse event to report to the pty. */
export type CoreMouseEvent = ReportCoords & {
  button: number
  action: number
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
}

export interface XtermCore {
  /** The wrapper xterm binds its mouse listeners to. */
  element: HTMLElement
  /** What mouse-report coordinates are measured against. */
  screenElement: HTMLElement
  _selectionService: {
    shouldForceSelection(e: MouseEvent): boolean
    clearSelection(): void
    disable(): void
  }
  coreService: { triggerDataEvent(data: string, wasUserInput?: boolean): void }
  _mouseService: { getMouseReportCoords(e: MouseEvent, element: HTMLElement): ReportCoords | undefined }
  coreMouseService: {
    readonly areMouseEventsActive: boolean
    /** Mutates its argument, so pass a fresh object each call. */
    triggerMouseEvent(e: CoreMouseEvent): boolean
    consumeWheelEvent(e: WheelEvent, cellHeight: number, dpr: number): number
  }
  _renderService: {
    readonly dimensions: { css: { cell: { height: number } }; device: { cell: { height: number } } }
  }
  _coreBrowserService: { dpr: number }
}

// xterm's CoreMouseButton / CoreMouseAction values, which are const enums
// and not exported. Wheel-up is UP and wheel-down is DOWN.
export const MOUSE_BUTTON_LEFT = 0
export const MOUSE_BUTTON_WHEEL = 4
export const MOUSE_ACTION_UP = 0
export const MOUSE_ACTION_DOWN = 1

/** Every member of XtermCore, as a property path. */
const PATHS = [
  'element',
  'screenElement',
  '_selectionService.shouldForceSelection',
  '_selectionService.clearSelection',
  '_selectionService.disable',
  'coreService.triggerDataEvent',
  '_mouseService.getMouseReportCoords',
  'coreMouseService.areMouseEventsActive',
  'coreMouseService.triggerMouseEvent',
  'coreMouseService.consumeWheelEvent',
  '_renderService.dimensions.css.cell.height',
  '_renderService.dimensions.device.cell.height',
  '_coreBrowserService.dpr',
]

/** An opened terminal's internals. Throws naming every member that is
 *  missing. Call after `term.open()`. */
export function xtermCore(term: Terminal): XtermCore {
  const core = (term as unknown as { _core: unknown })._core
  const missing = PATHS.filter((p) =>
    p.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], core) === undefined)
  if (missing.length > 0) throw new Error(`xterm internals changed, missing: ${missing.join(', ')}`)
  return core as XtermCore
}
