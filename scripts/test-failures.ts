/**
 * Print the failing tests from the last vitest run.
 *
 * Every run writes `.vitest-last-run.json` (see `reporters` in
 * vitest.config.ts), so a failure is always recoverable by reading rather
 * than by running the suite again — which matters when the console output
 * was truncated, scrolled away, or the run took minutes.
 *
 * Usage: `pnpm test:failures` after any `vitest run`.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const RESULTS_FILE = path.join(process.cwd(), '.vitest-last-run.json')

/** Past this, the recorded run is old enough that it may not be the one the
 *  caller has in mind (a killed run never overwrites the file). */
const STALE_AFTER_MIN = 10

/** The slice of vitest's json reporter output this reads. */
interface RunResults {
  numFailedTests?: number
  numTotalTests?: number
  /** Epoch ms the run started, from vitest's json reporter. */
  startTime?: number
  testResults?: Array<{
    name?: string
    assertionResults?: Array<{
      status?: string
      fullName?: string
      title?: string
      failureMessages?: string[]
    }>
  }>
}

async function main(): Promise<void> {
  let raw: string
  try {
    raw = await fs.readFile(RESULTS_FILE, 'utf8')
  } catch {
    console.error(`No ${path.basename(RESULTS_FILE)} — run the suite first (e.g. pnpm test:unit).`)
    process.exitCode = 1
    return
  }

  let results: RunResults
  try {
    results = JSON.parse(raw) as RunResults
  } catch {
    // A run killed mid-write leaves a truncated file; say so rather than
    // reporting "no failures", which would read as a pass.
    console.error(`${path.basename(RESULTS_FILE)} is not valid JSON — the run was probably interrupted.`)
    process.exitCode = 1
    return
  }

  // The reporter only writes at the end of a run, so a run that was killed
  // (Ctrl-C, OOM) leaves the *previous* run's file in place — which would
  // otherwise read as a pass. Always say which run this is, and flag one
  // old enough to be a different run than the one you just watched fail.
  const startedMs = results.startTime
  if (startedMs !== undefined) {
    const ageMin = Math.round((Date.now() - startedMs) / 60_000)
    const when = new Date(startedMs).toISOString().replace('T', ' ').slice(0, 19)
    console.log(`Run started ${when}Z (${ageMin} min ago).`)
    if (ageMin >= STALE_AFTER_MIN) {
      console.log(
        `  ⚠ that is over ${STALE_AFTER_MIN} minutes old — if the run you are asking\n`
        + '    about was killed before it finished, this is the previous run.',
      )
    }
  }

  const failures = (results.testResults ?? []).flatMap((file) =>
    (file.assertionResults ?? [])
      .filter((t) => t.status === 'failed')
      .map((t) => ({
        file: file.name ?? '<unknown file>',
        name: t.fullName ?? t.title ?? '<unnamed test>',
        messages: t.failureMessages ?? [],
      })))

  if (failures.length === 0) {
    console.log(`No failures recorded (${results.numTotalTests ?? 0} tests).`)
    return
  }

  console.log(`${failures.length} failing test(s) of ${results.numTotalTests ?? 0}:\n`)
  for (const f of failures) {
    console.log(`✗ ${f.name}`)
    console.log(`  ${path.relative(process.cwd(), f.file)}`)
    for (const m of f.messages) {
      console.log(m.split('\n').map((line) => `    ${line}`).join('\n'))
    }
    console.log('')
  }
  process.exitCode = 1
}

await main()
