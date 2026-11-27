/**
 * `yaac-tree`: the tree container's program (docs/node-local-workspaces.md
 * "The tree container"), built into a self-contained script that ships with
 * the other `workspace-bin` helpers.
 *
 *   yaac-tree start    --trigger F
 *   yaac-tree run      --tree T --scratch S --ckpt K --life L [--trigger F] [--interval SECONDS]
 *   yaac-tree salvage  --tree T --scratch S --ckpt K --life L
 *   yaac-tree pass     --tree T --scratch S --ckpt K --life L
 *   yaac-tree import   --tree T --scratch S --ckpt K --life L
 *
 * `start` is the container's command: it waits for mountd to write
 * the list of its pod's node-mounts directory, then becomes the agent's
 * `tree-start`, which makes the binds the list names, gives up
 * CAP_SYS_ADMIN for good and becomes `run` (docs/generic-workspace-pods.md
 * "A claim"). A restarted container does all of it again.
 *
 * `run` waits for the life's start instruction and fills the tree, which
 * the arborist built, or restores a checkpoint onto it (once per life:
 * a restarted container finds its marker and goes straight to its passes).
 * It then reports the files ready beside the trigger file, and takes a pass
 * every 30 seconds and whenever the trigger file's mtime moves. On TERM,
 * which Kubernetes sends once the workspace container has exited, it takes
 * the final pass and removes the tree and scratch repository. `salvage`
 * does that last part for a tree a killed pod left. A final pass that
 * cannot save everything fails instead, leaving the tree for a salvage to
 * try again. `run` and `salvage` first clear the locks a git killed
 * mid-write left. `import` takes a checkpoint of a workspace whose files
 * are still on the shared tier, leaving them as they are, for its next life
 * to restore.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { ChainError, clearStaleLocks, fill, finish, makeMountPoints, removeLife, restore, takePass, type TreeContext } from './checkpoint'
import { LIVES_DIR, START_FILE, TIMING_FILE, type StartInstruction, type TreeTiming } from '@yaac/shared/tree-records'

/** Seconds between passes, unless `--interval` says otherwise. */
const INTERVAL_S = 30
/** Written beside the start instruction when a restore cannot proceed. */
const RESTORE_FAILED_FILE = 'restore-failed.json'
/** Where mountd's list and program appear (k8s/mountd). */
const NODE_MOUNTS = '/node-mounts'
/** Between looks for mountd's list, in this one process: a look
 *  costs about a millisecond of CPU in the sandbox, a process start tens. */
const LIST_POLL_MS = 50
/** Between reads of a start instruction that is not there yet, which is
 *  while the server is still fetching a checkout. The file is on the shared
 *  tier, so a read may be a round trip to its file server. */
const START_POLL_MS = 100

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
    await sleep(START_POLL_MS)
  }
}

/** When this process read its start instruction (epoch ms). */
let instructionAt = 0

async function context(f: Record<string, string>): Promise<TreeContext> {
  for (const k of ['tree', 'scratch', 'ckpt', 'life']) if (!f[k]) throw new Error(`--${k} is required`)
  const start = await awaitStart(f.ckpt, f.life)
  instructionAt = Date.now()
  return { tree: f.tree, scratch: f.scratch, ckpt: f.ckpt, start }
}

/** Say when this process started, read its instruction and filled the
 *  tree, for the server's start timing. After the markers, so the claim
 *  never waits on it, and best-effort. */
async function writeTiming(c: TreeContext, filled: number): Promise<void> {
  const timing: TreeTiming = { process: Math.round(performance.timeOrigin), instruction: instructionAt, filled }
  const file = path.join(c.ckpt, LIVES_DIR, c.start.life, TIMING_FILE)
  await fs.writeFile(file, `${JSON.stringify(timing)}\n`)
  await fs.chown(file, c.start.uid, c.start.gid)
}

/**
 * Wait for mountd's list, then become its `tree-start`, which binds
 * this container's entries, drops CAP_SYS_ADMIN and runs `run` for the
 * list's life. Nothing here reads what an agent wrote.
 */
async function start(trigger: string): Promise<void> {
  const list = path.join(NODE_MOUNTS, 'list.json')
  let life: string | undefined
  for (;;) {
    const text = await fs.readFile(list, 'utf8').catch(() => null)
    if (text !== null) {
      life = (JSON.parse(text) as { life?: string }).life
      break
    }
    await sleep(LIST_POLL_MS)
  }
  if (life === undefined || !/^[A-Za-z0-9._-]+$/.test(life)) throw new Error('mountd\'s list names no life')
  if (process.execve === undefined) throw new Error('this node cannot replace its process (process.execve)')
  process.execve(path.join(NODE_MOUNTS, 'sandbox-bind'), [
    'sandbox-bind', 'tree-start', '--', process.execPath, process.argv[1],
    'run', '--tree', '/tree', '--scratch', '/scratch', '--ckpt', '/ckpt', '--life', life, '--trigger', trigger,
    // eslint-disable-next-line no-process-env -- the container's own environment, handed on unread to the process this one becomes
  ], process.env)
}

/** Fill or restore the tree, once per life, then report the files ready
 *  beside the trigger file, which the claim call waits for
 *  (daemons/streamd/claim.go; keep the name in sync with
 *  `treeStartedMarker` in pod-job.ts). A restore that cannot read its chain
 *  says so beside the instruction and never reports ready, so the server can
 *  offer a restore from what does verify. */
async function startLife(c: TreeContext, trigger: string | undefined): Promise<boolean> {
  const marker = startedMarker(c.scratch, c.start.life)
  if (await exists(marker)) return true
  try {
    const restored = c.start.restore !== undefined
      ? await restore(c, c.start.restore, { newestReadable: c.start.restoreNewestReadable === true })
      : null
    if (!restored) await fill(c)
  } catch (err) {
    if (!(err instanceof ChainError)) throw err
    const file = path.join(c.ckpt, LIVES_DIR, c.start.life, RESTORE_FAILED_FILE)
    const cause = err.cause instanceof Error ? err.cause.message : String(err.cause)
    await fs.writeFile(file, `${JSON.stringify({ bundle: err.bundle, message: cause })}\n`)
    return false
  }
  await makeMountPoints(c)
  await fs.mkdir(c.scratch, { recursive: true })
  const filled = Date.now()
  await fs.writeFile(marker, '')
  if (trigger !== undefined) await fs.writeFile(path.join(path.dirname(trigger), `started.${c.start.life}`), '')
  await writeTiming(c, filled).catch(() => { /* only the timing line misses it */ })
  return true
}

async function run(c: TreeContext, trigger: string | undefined, intervalS: number): Promise<void> {
  let stopping = false
  let wake: () => void = () => {}
  process.on('SIGTERM', () => {
    stopping = true
    wake()
  })
  await clearStaleLocks(c)
  if (!(await startLife(c, trigger))) {
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
    case 'start':
      if (!f.trigger) throw new Error('--trigger is required')
      await start(f.trigger)
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
      await clearStaleLocks(c)
      if (await exists(startedMarker(c.scratch, c.start.life))) await finish(c)
      await removeLife(c)
      break
    }
    case 'import':
      await finish(await context(f))
      break
    default:
      throw new Error('usage: yaac-tree start --trigger F | run|salvage|import|pass --tree T --scratch S --ckpt K --life L')
  }
}

// Exits at once when done: a wait's timer would otherwise hold the process.
main().then(() => process.exit(0), (err: unknown) => {
  process.stderr.write(`yaac-tree: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
