import { describe, it, expect } from 'vitest'
import { formatCheckResult } from '#checks'

describe('formatCheckResult', () => {
  it('renders pass/fail/warn/skip icons with name and detail', () => {
    expect(formatCheckResult({ name: 'kubectl', status: 'pass', detail: 'installed' }))
      .toBe('✓ kubectl: installed')
    expect(formatCheckResult({ name: 'registry', status: 'fail', detail: 'down' }))
      .toBe('✗ registry: down')
    expect(formatCheckResult({ name: 'nodes', status: 'warn', detail: '2 nodes' }))
      .toBe('! nodes: 2 nodes')
    expect(formatCheckResult({ name: 'probe', status: 'skip', detail: 'skipped' }))
      .toBe('- probe: skipped')
  })

  it('appends indented fix lines for failures', () => {
    const rendered = formatCheckResult({
      name: 'registry',
      status: 'fail',
      detail: 'nothing answering',
      fix: 'line one\nline two',
    })
    expect(rendered).toBe(
      '✗ registry: nothing answering\n    fix: line one\n         line two',
    )
  })

  it('renders the fix for warnings too, but never for pass/skip', () => {
    expect(formatCheckResult({ name: 'nodes', status: 'warn', detail: 'x', fix: 'use one node' }))
      .toContain('fix: use one node')
    expect(formatCheckResult({ name: 'ok', status: 'pass', detail: 'x', fix: 'irrelevant' }))
      .toBe('✓ ok: x')
    expect(formatCheckResult({ name: 'probe', status: 'skip', detail: 'x', fix: 'irrelevant' }))
      .toBe('- probe: x')
  })
})
