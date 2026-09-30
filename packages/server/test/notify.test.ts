import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  coalesceCalls,
  onWorkspaceListChanged,
  notifyWorkspaceListChanged,
  _resetWorkspaceListChangedForTests,
} from '#notify'

afterEach(() => {
  _resetWorkspaceListChangedForTests()
})

describe('session-list-changed signal', () => {
  it('fires the registered listener on notify', () => {
    const fn = vi.fn()
    onWorkspaceListChanged(fn)
    notifyWorkspaceListChanged()
    notifyWorkspaceListChanged()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('is a no-op when nothing is registered', () => {
    expect(() => notifyWorkspaceListChanged()).not.toThrow()
  })

  it('keeps only the latest listener (last registration wins)', () => {
    const first = vi.fn()
    const second = vi.fn()
    onWorkspaceListChanged(first)
    onWorkspaceListChanged(second)
    notifyWorkspaceListChanged()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('coalesceCalls', () => {
  it('fires the first call immediately', () => {
    const fn = vi.fn()
    const wrapped = coalesceCalls(fn, 50)
    wrapped()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('collapses a burst into one trailing call', async () => {
    const fn = vi.fn()
    const wrapped = coalesceCalls(fn, 20)
    wrapped()
    wrapped()
    wrapped()
    wrapped()
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(2))
    // No further pending call after the trailing one.
    await new Promise((r) => setTimeout(r, 30))
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does not fire a trailing call when nothing arrived during the window', async () => {
    const fn = vi.fn()
    const wrapped = coalesceCalls(fn, 10)
    wrapped()
    await new Promise((r) => setTimeout(r, 30))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('fires immediately again once the window has passed', async () => {
    const fn = vi.fn()
    const wrapped = coalesceCalls(fn, 10)
    wrapped()
    await new Promise((r) => setTimeout(r, 30))
    wrapped()
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
