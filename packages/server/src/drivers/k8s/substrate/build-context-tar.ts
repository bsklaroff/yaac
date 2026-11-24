/**
 * A build context as a tar stream, for builds that run somewhere else: the
 * builder pods (over `kubectl exec -i`) and install's host buildkitd (over
 * `podman exec -i`). The files are exactly the set `contextHash()` covers:
 * `.containerignore` is honored and symlinks are skipped, so what is built
 * is what the tag names.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { BUILDER_CONTEXT_MAX_BYTES, collectContextFiles, parseContainerIgnore } from '#lib/build-context'
import { pipeToServerLog } from '#lib/log'

/**
 * The context's files, relative and sorted. Throws past
 * BUILDER_CONTEXT_MAX_BYTES, naming the fix.
 */
export async function buildContextFiles(contextDir: string): Promise<string[]> {
  let ignore = new Set<string>()
  try {
    ignore = parseContainerIgnore(await fs.readFile(path.join(contextDir, '.containerignore'), 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const files = (await collectContextFiles(contextDir, '', ignore)).sort()
  let totalBytes = 0
  for (const rel of files) totalBytes += (await fs.stat(path.join(contextDir, rel))).size
  if (totalBytes > BUILDER_CONTEXT_MAX_BYTES) {
    throw new Error(
      `build context ${contextDir} is ${Math.round(totalBytes / 1024 ** 2)}MB `
      + `(limit ${BUILDER_CONTEXT_MAX_BYTES / 1024 ** 2}MB). Add a `
      + '.containerignore excluding large dirs the Dockerfile does not COPY.',
    )
  }
  return files
}

/**
 * Tar `files` of `contextDir` and hand the stream to `extract`, which pipes
 * it into the remote side. Settles when both have finished.
 */
export async function streamBuildContext(
  contextDir: string,
  files: string[],
  logPrefix: string,
  extract: (tar: NodeJS.ReadableStream) => Promise<void>,
): Promise<void> {
  // The file list goes in a temp file: it can exceed argv limits, and
  // stdout carries the archive.
  const listDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-build-ctx-'))
  const listFile = path.join(listDir, 'files.txt')
  await fs.writeFile(listFile, files.map((f) => `${f}\n`).join(''))
  try {
    const tar = spawn('tar', ['-cf', '-', '-T', listFile], {
      cwd: contextDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const tarStderr: string[] = []
    pipeToServerLog(tar.stderr, logPrefix, (l) => tarStderr.push(l))
    tar.stdout.on('error', () => {}) // EPIPE when the remote side dies first
    const tarExit = new Promise<void>((resolve, reject) => {
      tar.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`tar exited with code ${code}: ${tarStderr.join('\n')}`))
      })
      tar.on('error', reject)
    })
    await Promise.all([extract(tar.stdout), tarExit])
  } finally {
    await fs.rm(listDir, { recursive: true, force: true })
  }
}
