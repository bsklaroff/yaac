/**
 * Run `probe` until it returns a truthy value or `timeoutMs` has passed,
 * sleeping `intervalMs` between tries. Resolves the last result, so a
 * falsy one means the deadline passed. The probe always runs at least once,
 * and a probe that throws ends the wait with its error.
 */
export async function waitFor<T>(
  probe: () => Promise<T>,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs
  for (;;) {
    const result = await probe()
    if (result || Date.now() >= deadline) return result
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs))
  }
}
