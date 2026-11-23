/**
 * Print the slowest test files and tests from the last vitest run, read
 * from `.vitest-last-run.json` as `pnpm test:failures` reads it. A file's
 * time is the sum of its tests', so a slow `beforeAll` shows only as the
 * gap between the two.
 *
 * Usage: `pnpm test:slowest [count]` (default 20) after any `vitest run`.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const RESULTS_FILE = path.join(process.cwd(), '.vitest-last-run.json')

/** The slice of vitest's json reporter output this reads. */
interface RunResults {
  testResults?: Array<{
    name?: string
    startTime?: number
    endTime?: number
    assertionResults?: Array<{ fullName?: string; duration?: number | null }>
  }>
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1).padStart(7)

async function main(): Promise<void> {
  const raw = await fs.readFile(RESULTS_FILE, 'utf8').catch(() => null)
  if (raw === null) {
    console.error(`No ${path.basename(RESULTS_FILE)} — run the suite first (e.g. pnpm test:unit).`)
    process.exitCode = 1
    return
  }
  const count = Number(process.argv[2] ?? 20)
  const files = ((JSON.parse(raw) as RunResults).testResults ?? []).map((f) => {
    const name = path.relative(process.cwd(), f.name ?? '')
    const tests = (f.assertionResults ?? []).map((t) => ({ file: name, name: t.fullName ?? '', ms: t.duration ?? 0 }))
    return { name, wall: (f.endTime ?? 0) - (f.startTime ?? 0), tests, ms: tests.reduce((sum, t) => sum + t.ms, 0) }
  })
  const total = files.reduce((sum, f) => sum + f.ms, 0)
  console.log(`${String(files.length)} files, ${seconds(total).trim()}s of tests in all.\n\nSlowest files (wall s, tests s):`)
  for (const f of [...files].sort((a, b) => b.wall - a.wall).slice(0, count)) {
    console.log(`${seconds(f.wall)}${seconds(f.ms)}  ${f.name}`)
  }
  console.log('\nSlowest tests (s):')
  for (const t of files.flatMap((f) => f.tests).sort((a, b) => b.ms - a.ms).slice(0, count)) {
    console.log(`${seconds(t.ms)}  ${t.file} > ${t.name}`)
  }
}

await main()
