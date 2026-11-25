/**
 * The `claim` stream: everything a pod is told when it becomes one
 * workspace's, done inside streamd's own process (docs/generic-workspace-pods.md
 * "A claim"). Each process started inside a gVisor sandbox costs 12
 * to 50 ms, so files are written here rather than by commands, and tmux is
 * told everything in one invocation.
 *
 * The request is a JSON object (see `claimWorkspace`); the reply is one JSON
 * line, `{ok: true}` or `{ok: false, error}`.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** Keep in sync with CONTAINER_TMUX_SOCK (packages/shared/src/paths.ts). */
const TMUX_SOCKET = '/tmp/yaac-tmux/server'
/** Between looks for the tree container's started marker. */
const MARKER_POLL_MS = 25
/** How often the running pod checkpoints opencode's history; a killed pod
 *  loses at most this much (docs/workspace-storage.md "opencode"). */
const OPENCODE_CHECKPOINT_INTERVAL_SECONDS = 300

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const exists = (p) => fs.lstat(p).then(() => true, () => false)

/** A git config value, quoted so any character but a newline survives. */
function gitValue(v) {
  if (/[\n\r\0]/.test(v)) throw new Error('a git config value cannot hold a line break')
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * `~/.gitconfig`: the identity, each checkout trusted, and checkouts written
 * by 8 processes at once (keep in sync with CHECKOUT_WORKERS in
 * packages/server/src/domain/git/repo.ts). Written whole: the image's own
 * home holds none, and nothing else writes it before the claim.
 */
export function gitConfigText({ name, email, safeDirectories }) {
  return [
    '[user]',
    `\tname = ${gitValue(name)}`,
    `\temail = ${gitValue(email)}`,
    '[checkout]',
    '\tworkers = 8',
    ...(safeDirectories.length > 0 ? ['[safe]', ...safeDirectories.map((d) => `\tdirectory = ${gitValue(d)}`)] : []),
    '',
  ].join('\n')
}

/** Write `file` whole, through a temp file renamed over it. */
async function writeWhole(file, text) {
  const tmp = `${file}.yaac-${process.pid}`
  await fs.writeFile(tmp, text, { mode: 0o644 })
  await fs.rename(tmp, file)
}

/**
 * The install's npm cache as the DEFAULT registry, at user-config
 * precedence: pnpm and npm read `~/.npmrc` below a project's own `.npmrc`,
 * so a project that names a registry keeps it, which an env var would
 * override. Skipped when the file already names one.
 */
async function writeNpmRegistry(home, url) {
  const file = path.join(home, '.npmrc')
  const text = await fs.readFile(file, 'utf8').catch(() => '')
  if (/^registry=/m.test(text)) return
  await fs.appendFile(file, `registry=${url}\n`)
}

/**
 * opencode's history: the node-local working copy is restored from the
 * global checkpoint, the only source of truth. A working copy whose
 * database (or its WAL) is newer than the checkpoint's is checkpointed
 * first, so an unclean stop on a node that survived costs nothing.
 * Returns whether the pod keeps a working copy, which the checkpoint timer
 * then saves. Keep the paths in sync with CONTAINER_OPENCODE_DATA and
 * CONTAINER_OPENCODE_CHECKPOINT (packages/shared/src/paths.ts) and with
 * yaac-opencode-checkpoint.
 */
async function restoreOpencode(home, run) {
  const data = path.join(home, '.local/share/opencode')
  const checkpoint = path.join(home, '.yaac/opencode-checkpoint')
  if (!await exists(data)) return false
  const hasCheckpoint = await exists(checkpoint)
  if (hasCheckpoint) {
    const db = (await fs.readdir(data)).find((n) => n.endsWith('.db'))
    if (db !== undefined) {
      const saved = await fs.stat(path.join(checkpoint, db)).then((s) => s.mtimeMs, () => -1)
      const newer = await Promise.all([db, `${db}-wal`].map((n) =>
        fs.stat(path.join(data, n)).then((s) => s.mtimeMs > saved, () => false)))
      if (newer.some(Boolean)) await run('yaac-opencode-checkpoint', []).catch(() => {})
    }
  }
  for (const entry of await fs.readdir(data)) await fs.rm(path.join(data, entry), { recursive: true, force: true })
  if (hasCheckpoint) {
    for (const entry of await fs.readdir(checkpoint)) {
      if (/^\.tmp-.*\.db$/.test(entry)) continue
      await fs.cp(path.join(checkpoint, entry), path.join(data, entry), { recursive: true, preserveTimestamps: true })
    }
  }
  return hasCheckpoint
}

/** Wait for `file` to exist, or fail after `ms`. */
async function awaitMarker(file, ms) {
  const deadline = Date.now() + ms
  while (!await exists(file)) {
    if (Date.now() > deadline) throw new Error(`the workspace's files were not ready after ${Math.round(ms / 1000)}s`)
    await sleep(MARKER_POLL_MS)
  }
}

/** Run a command to its end; rejects with its stderr on a nonzero exit. */
function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`))))
  })
}

/**
 * One argument as tmux reads it from argv. tmux takes an argument ending in
 * `;` as a command separator, keeping what comes before it, and one ending
 * in `\;` as that text ending in a plain `;`. So a value whose last
 * character is `;` gets a backslash before it, and every other value passes
 * through unchanged.
 */
export function tmuxArg(value) {
  return value.endsWith(';') ? `${value.slice(0, -1)}\\;` : value
}

/**
 * The one tmux invocation of a claim: the workspace's environment set on
 * the server before its session exists, so every window inherits it, then
 * the session on its keeper window at the workspace's cwd, and its status
 * line. The server renames the keeper from `_yaac-starting` to `_yaac` when
 * its setup is done (`KEEPER_STARTING` in the server's driver contract).
 *
 * `-x`/`-y` give every window a size larger than any terminal, so tmux
 * shrinks it to fit on attach; a TUI that renders at tmux's default 80x24
 * before the first attach can otherwise stay stuck there.
 */
export function tmuxClaimArgs({ env, cwd, statusRight }) {
  const args = ['-S', TMUX_SOCKET]
  for (const [name, value] of Object.entries(env)) args.push('set-environment', '-g', name, tmuxArg(value), ';')
  args.push(
    'new-session', '-d', '-s', 'yaac', '-n', '_yaac-starting', '-x', '500', '-y', '200', '-c', tmuxArg(cwd), 'sleep infinity', ';',
    'set-option', '-t', 'yaac', 'status-right-length', '80', ';',
    'set-option', '-t', 'yaac', 'status-right', tmuxArg(statusRight),
  )
  return args
}

/**
 * Make this pod one workspace's. `req`:
 * - `startedMarker`, `waitMs`: wait for the tree container to report the
 *   workspace's files ready before anything reads them;
 * - `git`: `{name, email, safeDirectories}` for `~/.gitconfig`;
 * - `npmRegistry`: the install's npm cache, when the workspace uses it;
 * - `env`, `cwd`, `statusRight`: the tmux session (`tmuxClaimArgs`).
 *
 * The variables also join streamd's own environment, so every command the
 * server runs in the pod afterwards (an exec stream, a pty) sees them as a
 * window does.
 *
 * `deps` replaces the home dir, the command runner and streamd's
 * environment in tests.
 */
export async function claimWorkspace(req, deps = {}) {
  const home = deps.home ?? process.env.HOME ?? '/home/yaac'
  const run = deps.run ?? runCommand
  Object.assign(deps.processEnv ?? process.env, req.env ?? {})
  if (typeof req.startedMarker === 'string') await awaitMarker(req.startedMarker, req.waitMs ?? 0)
  const git = req.git
  await Promise.all([
    writeWhole(path.join(home, '.gitconfig'), gitConfigText({
      name: git.name, email: git.email, safeDirectories: git.safeDirectories ?? [],
    })),
    typeof req.npmRegistry === 'string' ? writeNpmRegistry(home, req.npmRegistry) : undefined,
  ])
  const opencode = await restoreOpencode(home, run)
  await run('tmux', tmuxClaimArgs({ env: req.env ?? {}, cwd: req.cwd, statusRight: req.statusRight ?? '' }))
  if (opencode && deps.run === undefined) {
    // Detached under the pod's init, so it outlives this stream; the pod's
    // preStop hook runs the same script one last time with `stop`.
    spawn('setsid', ['sh', '-c', `while sleep ${OPENCODE_CHECKPOINT_INTERVAL_SECONDS}; do yaac-opencode-checkpoint; done`], {
      stdio: 'ignore', detached: true,
    }).unref()
  }
}

/** Read `n` bytes of request from the stream, starting with `leftover`. */
function readBody(socket, n, leftover) {
  return new Promise((resolve, reject) => {
    const chunks = [leftover]
    let have = leftover.length
    if (have >= n) { resolve(Buffer.concat(chunks).subarray(0, n)); return }
    const onData = (chunk) => {
      chunks.push(chunk)
      have += chunk.length
      if (have < n) return
      socket.removeListener('data', onData)
      resolve(Buffer.concat(chunks).subarray(0, n))
    }
    socket.on('data', onData)
    socket.once('close', () => reject(new Error('closed before the request was whole')))
  })
}

/** Cap on a claim's request, which carries the workspace's environment. */
const CLAIM_MAX_BYTES = 4 * 1024 * 1024

/** The stream handler: `{kind: 'claim', bytes: n}`, then n bytes of JSON. */
export function handleClaim(socket, params, leftover) {
  const n = params.bytes
  if (!(Number.isSafeInteger(n) && n > 0 && n <= CLAIM_MAX_BYTES)) return { ok: false, error: 'claim: bytes must be a size' }
  const answer = (obj) => socket.end(JSON.stringify(obj) + '\n')
  void readBody(socket, n, leftover)
    .then((body) => claimWorkspace(JSON.parse(body.toString('utf8'))))
    .then(() => answer({ ok: true }), (err) => answer({ ok: false, error: String(err?.message ?? err) }))
  return { ok: true }
}
