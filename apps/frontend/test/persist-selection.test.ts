// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { loadSelection, persistSelection } from '#store'

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState({}, '', '/')
})

describe('persistSelection', () => {
  it('writes localStorage and mirrors into the URL query', () => {
    persistSelection('proj', 'sess')
    expect(JSON.parse(localStorage.getItem('yaac.selection.v1')!)).toEqual({
      projectSlug: 'proj', sessionId: 'sess',
    })
    const params = new URLSearchParams(window.location.search)
    expect(params.get('project')).toBe('proj')
    expect(params.get('session')).toBe('sess')
  })

  it('drops the query params (and stores nulls) when both values are null', () => {
    persistSelection('proj', 'sess')
    persistSelection(null, null)
    expect(window.location.search).toBe('')
    expect(JSON.parse(localStorage.getItem('yaac.selection.v1')!)).toEqual({
      projectSlug: null, sessionId: null,
    })
  })

  it('keeps the project but clears the session when only the session is null', () => {
    persistSelection('proj', 'sess')
    persistSelection('proj', null)
    const params = new URLSearchParams(window.location.search)
    expect(params.get('project')).toBe('proj')
    expect(params.has('session')).toBe(false)
  })

  it('preserves unrelated query params such as bootstrap', () => {
    window.history.replaceState({}, '', '/?bootstrap=abc')
    persistSelection('proj', 'sess')
    const params = new URLSearchParams(window.location.search)
    expect(params.get('bootstrap')).toBe('abc')
    expect(params.get('project')).toBe('proj')
    expect(params.get('session')).toBe('sess')
  })

  it('is a no-op without localStorage', () => {
    const real = globalThis.localStorage
    // Simulate a browser that denies storage access.
    delete (globalThis as Record<string, unknown>).localStorage
    expect(() => persistSelection('proj', 'sess')).not.toThrow()
    // The URL is still mirrored even when storage is unavailable.
    expect(new URLSearchParams(window.location.search).get('project')).toBe('proj')
    ;(globalThis as Record<string, unknown>).localStorage = real
  })
})

describe('loadSelection', () => {
  it('reads the URL query first, ignoring localStorage', () => {
    window.history.replaceState({}, '', '/?project=urlproj&session=urlsess')
    localStorage.setItem('yaac.selection.v1', JSON.stringify({
      projectSlug: 'lsproj', sessionId: 'lssess',
    }))
    expect(loadSelection()).toEqual({ projectSlug: 'urlproj', sessionId: 'urlsess' })
  })

  it('treats a URL project with no session as a null session', () => {
    window.history.replaceState({}, '', '/?project=urlproj')
    expect(loadSelection()).toEqual({ projectSlug: 'urlproj', sessionId: null })
  })

  it('falls back to localStorage when the URL has no project', () => {
    localStorage.setItem('yaac.selection.v1', JSON.stringify({
      projectSlug: 'lsproj', sessionId: 'lssess',
    }))
    expect(loadSelection()).toEqual({ projectSlug: 'lsproj', sessionId: 'lssess' })
  })

  it('returns nulls when nothing is persisted', () => {
    expect(loadSelection()).toEqual({ projectSlug: null, sessionId: null })
  })

  it('survives malformed or partial localStorage', () => {
    localStorage.setItem('yaac.selection.v1', '{{{')
    expect(loadSelection()).toEqual({ projectSlug: null, sessionId: null })
    localStorage.setItem('yaac.selection.v1', JSON.stringify({ projectSlug: 'p' }))
    expect(loadSelection()).toEqual({ projectSlug: 'p', sessionId: null })
    localStorage.setItem('yaac.selection.v1', '"a string"')
    expect(loadSelection()).toEqual({ projectSlug: null, sessionId: null })
  })

  it('round-trips through persistSelection', () => {
    persistSelection('proj', 'sess')
    // A bare reload (no URL params) should restore from localStorage.
    window.history.replaceState({}, '', '/')
    expect(loadSelection()).toEqual({ projectSlug: 'proj', sessionId: 'sess' })
  })
})
