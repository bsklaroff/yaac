import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { countMatches, type QuerySpec } from '#lib/matchCount'

/*
 * Setup for every unit:frontend file (named in the root vitest.config.ts):
 * stand-ins for the browser APIs jsdom lacks, and an unmount after each
 * test. jsdom does no layout, so a test says when an element resizes
 * (`resizeAll`) or comes into view (`intersect`). Tests import these
 * helpers from this module; it is the same instance setup installed.
 */

const resizeObservers = new Set<FakeResizeObserver>()

class FakeResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(): void { resizeObservers.add(this) }
  unobserve(): void { resizeObservers.delete(this) }
  disconnect(): void { resizeObservers.delete(this) }
  fire(): void { this.cb([], this) }
}

/** Fire every live ResizeObserver, as a layout change would. */
export function resizeAll(): void {
  for (const o of [...resizeObservers]) o.fire()
}

/** Whether an element is in view when first observed. A file about
 *  scrolling sets it false; it is reset after each test. */
export const intersection = { startInView: true }

const watched = new Map<Element, Set<FakeIntersectionObserver>>()

class FakeIntersectionObserver {
  constructor(private readonly cb: IntersectionObserverCallback) {}
  observe(el: Element): void {
    watched.set(el, (watched.get(el) ?? new Set()).add(this))
    if (intersection.startInView) this.notify(el, true)
  }
  unobserve(el: Element): void {
    watched.get(el)?.delete(this)
    if (watched.get(el)?.size === 0) watched.delete(el)
  }
  disconnect(): void {
    for (const el of [...watched.keys()]) this.unobserve(el)
  }
  takeRecords(): IntersectionObserverEntry[] { return [] }
  notify(el: Element, isIntersecting: boolean): void {
    this.cb([{ target: el, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

/** The elements observed now, in the order they were first observed. */
export function observedElements(): Element[] {
  return [...watched.keys()]
}

/** Move observed elements (`targets`, or all of them) into or out of view. */
export function intersect(near = true, targets = observedElements()): void {
  for (const el of targets) for (const o of [...watched.get(el) ?? []]) o.notify(el, near)
}

/** A regex that backtracks forever; `FakeWorker` never answers it. */
export const HANGS = '(a|aa)+b'

/** `MatchCounter`'s worker: runs the real `countMatches` a tick later, and
 *  never answers for HANGS. */
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  private terminated = false
  postMessage(msg: { id: number; doc: string; spec: QuerySpec; limit: number }): void {
    if (msg.spec.search === HANGS) return
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: { id: msg.id, matches: countMatches(msg.doc, msg.spec, msg.limit) } } as MessageEvent)
    }, 0)
  }
  terminate(): void { this.terminated = true }
}

/** Every media query reports no match: a desktop viewport, light OS theme. */
function matchMedia(media: string): MediaQueryList {
  return {
    media, matches: false, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  }
}

globalThis.ResizeObserver = FakeResizeObserver
globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver
globalThis.Worker = FakeWorker as unknown as typeof Worker
window.matchMedia = matchMedia

afterEach(() => {
  cleanup()
  intersection.startInView = true
})
