import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { serverLocalPath } from '@yaac/shared/paths'
import { serverLog } from '#log'
import { NEVER_PRUNE_GC, NEVER_PRUNE_KEYS } from './repo'
import { runGit, spawnGit } from './run'

/**
 * A yaac-hosted remote (docs/hosted-projects.md): a bare repository the
 * server creates and serves over git's smart HTTP protocol through `git
 * http-backend`. Who may call is decided by the routes; this module only
 * speaks git.
 */

/** The largest push accepted, so one push cannot fill the server's disk. */
const MAX_PUSH_BYTES = 2 * 1024 ** 3

/** The three smart-HTTP endpoints. The dumb protocol's file reads are not
 *  served. */
const SMART_PATHS = new Set(['/info/refs', '/git-upload-pack', '/git-receive-pack'])

/**
 * The remote's `pre-receive` hook, yaac's own. It refuses a branch named
 * `HEAD`, which every clone would then find ambiguous. With
 * `YAAC_GUARD_DEFAULT_BRANCH=1` it also refuses a push that deletes the
 * branch HEAD names, or moves it to a commit that does not contain the old
 * tip. It runs after the pack is received, so the new commits are readable.
 */
const PRE_RECEIVE = `#!/bin/sh
head=$(git symbolic-ref -q HEAD)
status=0
while read -r old new ref; do
  if [ "$ref" = refs/heads/HEAD ]; then
    echo "yaac: a branch may not be named HEAD." >&2; status=1; continue
  fi
  [ "$YAAC_GUARD_DEFAULT_BRANCH" = 1 ] && [ "$ref" = "$head" ] || continue
  case $new in
    *[!0]*) ;;
    *) echo "yaac: $ref is the default branch and cannot be deleted." >&2; status=1; continue ;;
  esac
  case $old in
    *[!0]*)
      if ! git merge-base --is-ancestor "$old" "$new"; then
        echo "yaac: $ref is the default branch and cannot be force-pushed." >&2
        echo "yaac: the project's owner can turn this guard off in Settings." >&2
        status=1
      fi ;;
  esac
done
exit $status
`

/**
 * The remote's `post-receive` hook, which settles its default branch. While
 * HEAD names a branch that does not exist (a new remote's unborn `main`, or
 * a deleted default), it points HEAD at one that does: `main`, else
 * `master`, else the first by name. So a remote first filled by pushing
 * `master` defaults to it. git waits for it before the push completes, so a
 * clone right after the push sees it.
 */
const POST_RECEIVE = `#!/bin/sh
git show-ref --verify -q "$(git symbolic-ref HEAD)" && exit 0
for b in refs/heads/main refs/heads/master $(git for-each-ref --format='%(refname)' refs/heads); do
  if git show-ref --verify -q "$b"; then git symbolic-ref HEAD "$b"; exit 0; fi
done
`

let hooks: Promise<string> | null = null

/** The hooks dir holding only yaac's own hooks, written once per process. */
function hooksDir(): Promise<string> {
  hooks ??= (async () => {
    const dir = serverLocalPath('run', 'hosted-git-hooks')
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    for (const [name, script] of [['pre-receive', PRE_RECEIVE], ['post-receive', POST_RECEIVE]]) {
      await fs.writeFile(path.join(dir, name), script, { mode: 0o755 })
      await fs.chmod(path.join(dir, name), 0o755)
    }
    return dir
  })().catch((err: unknown) => {
    hooks = null
    throw err
  })
  return hooks
}

/** The branch the remote's HEAD names, or null while it names none that
 *  exists. */
async function defaultBranch(repoPath: string): Promise<string | null> {
  const target = { kind: 'private' as const, gitDir: repoPath }
  const head = (await runGit(target, ['symbolic-ref', 'HEAD'])).trim()
  const exists = await runGit(target, ['show-ref', '--verify', '-q', head]).then(() => true, () => false)
  return exists ? head.slice('refs/heads/'.length) : null
}

/**
 * Create an empty bare repository on `main`. Its reflog records every ref
 * update and nothing is ever pruned, so a forced push or a deleted branch
 * can be recovered by hand.
 */
export async function initHostedRepo(repoPath: string): Promise<void> {
  await runGit({ kind: 'none' }, ['init', '--quiet', '--bare', '--initial-branch=main', repoPath])
  const config = path.join(repoPath, 'config')
  for (const [key, value] of [['core.logAllRefUpdates', 'always'], ...NEVER_PRUNE_KEYS.map((k) => [k, 'never'])]) {
    await runGit({ kind: 'none' }, ['config', '--file', config, key, value])
  }
}

/**
 * Answer one smart-HTTP request (`pathInfo` is what follows the repository
 * in the URL, such as `/info/refs`) for the bare repository at `repoPath`.
 * Pushes are fsck'd, capped at `MAX_PUSH_BYTES`, and refused outright
 * unless `allowPush`, and yaac's hooks always run (`PRE_RECEIVE`,
 * `POST_RECEIVE`). After a push that git accepted, the repository is gc'd
 * without pruning and `onPushed` gets its default branch.
 */
export async function serveGitHttp(
  repoPath: string,
  request: Request,
  pathInfo: string,
  opts: { allowPush: boolean; guardDefaultBranch: boolean; onPushed?: (defaultBranch: string | null) => void },
): Promise<Response> {
  if (!SMART_PATHS.has(pathInfo)) return new Response('not found\n', { status: 404 })
  const url = new URL(request.url)
  const header = (name: string): Record<string, string> => {
    const value = request.headers.get(name)
    return value === null ? {} : { [cgiName(name)]: value }
  }
  const child = await spawnGit([
    '-c', `http.receivepack=${String(opts.allowPush)}`,
    '-c', 'http.uploadpack=true',
    '-c', 'http.getanyfile=false',
    '-c', 'receive.fsckObjects=true',
    '-c', `receive.maxInputSize=${String(MAX_PUSH_BYTES)}`,
    '-c', 'core.logAllRefUpdates=always',
    // After the runner's `core.hooksPath=/dev/null`, so it wins. The hooks
    // are yaac's own, so nothing an agent wrote runs.
    '-c', `core.hooksPath=${await hooksDir()}`,
    'http-backend',
  ], {
    YAAC_GUARD_DEFAULT_BRANCH: opts.guardDefaultBranch ? '1' : '0',
    GIT_PROJECT_ROOT: path.dirname(repoPath),
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: `/${path.basename(repoPath)}${pathInfo}`,
    REQUEST_METHOD: request.method,
    QUERY_STRING: url.search.replace(/^\?/, ''),
    ...header('content-type'),
    ...header('content-length'),
    ...header('content-encoding'),
    ...header('git-protocol'),
  })

  let stderr = ''
  child.stderr.on('data', (c: Buffer) => { stderr = (stderr + c.toString('utf8')).slice(-2000) })
  child.stdin.on('error', () => { /* git exited before reading it all; its answer says why */ })
  if (request.body) {
    // A client that goes away mid-upload errors the body. Unhandled, that
    // takes the server down; the request is abandoned instead. git stopping
    // early is not an error here, since it is still writing its answer.
    Readable.fromWeb(request.body as NodeReadableStream)
      .on('error', () => child.kill())
      .pipe(child.stdin)
  } else {
    child.stdin.end()
  }

  child.on('close', (code) => {
    if (code !== 0) {
      serverLog(`[git] http-backend ${pathInfo} on ${path.basename(repoPath)} exited ${String(code)}: ${stderr.trim()}`)
      return
    }
    if (pathInfo !== '/git-receive-pack') return
    runGit({ kind: 'private', gitDir: repoPath }, NEVER_PRUNE_GC).catch((err: unknown) => {
      serverLog(`[git] gc of ${path.basename(repoPath)}: ${(err as Error).message}`)
    })
    defaultBranch(repoPath).then((head) => opts.onPushed?.(head), (err: unknown) => {
      serverLog(`[git] default branch of ${path.basename(repoPath)}: ${(err as Error).message}`)
    })
  })
  return cgiResponse(child.stdout, () => child.kill())
}

/** The CGI variable git reads for a request header. */
function cgiName(header: string): string {
  const name = header.toUpperCase().replace(/-/g, '_')
  return name === 'CONTENT_TYPE' || name === 'CONTENT_LENGTH' ? name : `HTTP_${name}`
}

/** Turn a CGI program's output (headers, a blank line, the body) into a
 *  streamed Response. */
async function cgiResponse(stdout: Readable, abort: () => void): Promise<Response> {
  const chunks = stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>
  let head = Buffer.alloc(0)
  let split: { at: number; length: number } | null = null
  while (split === null) {
    const next = await chunks.next()
    if (next.done === true) break
    head = Buffer.concat([head, next.value])
    const crlf = head.indexOf('\r\n\r\n')
    const lf = head.indexOf('\n\n')
    if (crlf >= 0 && (lf < 0 || crlf < lf)) split = { at: crlf, length: 4 }
    else if (lf >= 0) split = { at: lf, length: 2 }
  }
  if (split === null) return new Response('git http-backend failed\n', { status: 500 })

  let status = 200
  const headers = new Headers()
  for (const line of head.subarray(0, split.at).toString('utf8').split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (name.toLowerCase() === 'status') status = parseInt(value, 10) || 500
    else headers.append(name, value)
  }
  const rest = head.subarray(split.at + split.length)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (rest.length > 0) controller.enqueue(new Uint8Array(rest))
    },
    async pull(controller) {
      const next = await chunks.next()
      if (next.done === true) controller.close()
      else controller.enqueue(new Uint8Array(next.value))
    },
    cancel: abort,
  })
  return new Response(body, { status, headers })
}
