/**
 * `yaac-tree`: the tree container's program (docs/node-local-workspaces.md
 * "The tree container"), built into a self-contained script that ships with
 * the other `workspace-bin` helpers.
 *
 *   yaac-tree run      --tree T --scratch S --ckpt K --life L [--trigger F] [--interval SECONDS]
 *   yaac-tree salvage  --tree T --scratch S --ckpt K --life L
 *   yaac-tree pass     --tree T --scratch S --ckpt K --life L
 *   yaac-tree import   --tree T --scratch S --ckpt K --life L
 *   yaac-tree probe    --scratch S --life L
 *
 * `run` waits for the life's start instruction, checks the tree out or
 * restores it (once per life: a restarted container finds its marker and
 * goes straight to its passes), then takes a pass every 30 seconds and
 * whenever the trigger file's mtime moves. On TERM, which Kubernetes sends
 * once the workspace container has exited, it takes the final pass,
 * compacts, and removes the tree and scratch repository. `salvage` does
 * that last part for a tree a killed pod left. `import` takes a checkpoint
 * of a workspace whose files are still on the shared tier, leaving them as
 * they are, for its next life to restore. `probe` is the startup probe.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { ChainError, checkOut, finish, makeMountPoints, removeLife, restore, takePass, type TreeContext } from './checkpoint'
import { LIVES_DIR, START_FILE, type StartInstruction } from '@yaac/shared/tree-records'

/** Seconds between passes, unless `--interval` says otherwise. */
const INTERVAL_S = 30
/** Written beside the start instruction when a restore cannot proceed. */
const RESTORE_FAILED_FILE = 'restore-failed.json'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false)
const startedMarker = (scratch: string, life: string): string => path.join(scratch, `started.${life}`)

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`)
    out[argv[i].slice(2)] = argv[i + 1]
  }
  return out
}

/** The start instruction, once the server has written one that parses. */
async function awaitStart(ckpt: string, life: string): Promise<StartInstruction> {
  const file = path.join(ckpt, LIVES_DIR, life, START_FILE)
  for (;;) {
    const text = await fs.readFile(file, 'utf8').catch(() => null)
    if (text !== null) {
      try {
        const s = JSON.parse(text) as StartInstruction
        if (s.version === 1 && s.life === life && Array.isArray(s.checkouts) && Array.isArray(s.excluded)) return s
      } catch { /* written partway: read again */ }
    }
    await sleep(1000)
  }
}

async function context(f: Record<string, string>): Promise<TreeContext> {
  for (const k of ['tree', 'scratch', 'ckpt', 'life']) if (!f[k]) throw new Error(`--${k} is required`)
  return { tree: f.tree, scratch: f.scratch, ckpt: f.ckpt, start: await awaitStart(f.ckpt, f.life) }
}

/** Check out or restore the tree, once per life. A restore that cannot
 *  read its chain says so beside the instruction and never reports ready,
 *  so the server can offer a restore from what does verify. */
async function startLife(c: TreeContext): Promise<boolean> {
  const marker = startedMarker(c.scratch, c.start.life)
  if (await exists(marker)) return true
  try {
    const restored = c.start.restore !== undefined
      ? await restore(c, c.start.restore, { newestReadable: c.start.restoreNewestReadable === true })
      : null
    if (!restored) await checkOut(c)
  } catch (err) {
    if (!(err instanceof ChainError)) throw err
    const file = path.join(c.ckpt, LIVES_DIR, c.start.life, RESTORE_FAILED_FILE)
    const cause = err.cause instanceof Error ? err.cause.message : String(err.cause)
    await fs.writeFile(file, `${JSON.stringify({ bundle: err.bundle, message: cause })}\n`)
    return false
  }
  await makeMountPoints(c)
  await fs.mkdir(c.scratch, { recursive: true })
  await fs.writeFile(marker, '')
  return true
}

async function run(c: TreeContext, trigger: string | undefined, intervalS: number): Promise<void> {
  let stopping = false
  let wake: () => void = () => {}
  process.on('SIGTERM', () => {
    stopping = true
    wake()
  })
  if (!(await startLife(c))) {
    while (!stopping) await new Promise<void>((r) => { wake = r; setTimeout(r, 60_000) })
    return
  }
  const mtime = async (): Promise<number> => (trigger ? (await fs.stat(trigger).catch(() => null))?.mtimeMs ?? 0 : 0)
  let seen = await mtime()
  // A random first pass, so workspaces on one node do not coincide.
  let due = Date.now() + Math.random() * intervalS * 1000
  while (!stopping) {
    const now = await mtime()
    if (Date.now() >= due || now !== seen) {
      seen = now
      due = Date.now() + intervalS * 1000
      await takePass(c).catch((err: unknown) => {
        process.stderr.write(`yaac-tree: pass failed: ${err instanceof Error ? err.message : String(err)}\n`)
      })
      continue
    }
    await new Promise<void>((r) => { wake = r; setTimeout(r, 1000) })
  }
  await finish(c)
  await removeLife(c)
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  const f = flags(rest)
  switch (cmd) {
    case 'probe':
      process.exit(await exists(startedMarker(f.scratch, f.life)) ? 0 : 1)
      break
    case 'run':
      await run(await context(f), f.trigger, f.interval !== undefined ? Number(f.interval) : INTERVAL_S)
      break
    case 'pass':
      await takePass(await context(f))
      break
    case 'salvage': {
      // A tree the pod never finished checking out or restoring holds
      // nothing of the agent's; the checkpoint it would make would record
      // its missing files as deleted. The life before it still stands.
      const c = await context(f)
      if (await exists(startedMarker(c.scratch, c.start.life))) await finish(c)
      await removeLife(c)
      break
    }
    case 'import':
      await finish(await context(f))
      break
    default:
      throw new Error('usage: yaac-tree run|salvage|import|pass|probe --tree T --scratch S --ckpt K --life L')
  }
}

// Exits at once when done: a wait's timer would otherwise hold the process.
main().then(() => process.exit(0), (err: unknown) => {
  process.stderr.write(`yaac-tree: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
