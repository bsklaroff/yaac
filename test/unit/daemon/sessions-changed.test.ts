import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  onSessionListChanged,
  notifySessionListChanged,
  _resetSessionListChangedForTests,
} from '@/daemon/sessions-changed'

afterEach(() => {
  _resetSessionListChangedForTests()
})

describe('session-list-changed signal', () => {
  it('fires the registered listener on notify', () => {
    const fn = vi.fn()
    onSessionListChanged(fn)
    notifySessionListChanged()
    notifySessionListChanged()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('is a no-op when nothing is registered', () => {
    expect(() => notifySessionListChanged()).not.toThrow()
  })

  it('keeps only the latest listener (last registration wins)', () => {
    const first = vi.fn()
    const second = vi.fn()
    onSessionListChanged(first)
    onSessionListChanged(second)
    notifySessionListChanged()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
