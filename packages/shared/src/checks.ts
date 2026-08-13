import type { CheckResult } from '#types'

/**
 * How one `CheckResult` line prints.
 *
 * Here rather than beside either check that produces one: `yaac cluster
 * check` and `yaac host check` answer the same question about different
 * substrates, they are read side by side in the same terminal, and a driver
 * may not import another driver — so the one thing they genuinely share,
 * which is how a result looks, belongs with the type itself.
 */
export function formatCheckResult(r: CheckResult): string {
  const icon = { pass: '✓', fail: '✗', warn: '!', skip: '-' }[r.status]
  const head = `${icon} ${r.name}: ${r.detail}`
  return r.fix && r.status !== 'pass' && r.status !== 'skip'
    ? `${head}\n    fix: ${r.fix.split('\n').join('\n         ')}`
    : head
}
