/**
 * Build contexts as tar streams: the file set and the stream a remote
 * extractor receives. Real `tar` runs; the extractor is a local `tar -t`.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { describe, it, expect, afterEach } from 'vitest'
import { buildContextFiles, streamBuildContext } from '#drivers/k8s/substrate'
import { BUILDER_CONTEXT_MAX_BYTES } from '#lib/build-context'

const dirs: string[] = []
async function context(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ctx-tar-'))
  dirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await fs.writeFile(path.join(dir, rel), content)
  }
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

describe('buildContextFiles', () => {
  it('honors .containerignore and refuses an oversized context', async () => {
    const dir = await context({ 'a.txt': 'a', 'skip/b.txt': 'b', '.containerignore': 'skip\n' })
    await fs.symlink('a.txt', path.join(dir, 'link'))
    expect(await buildContextFiles(dir)).toEqual(['.containerignore', 'a.txt'])
    const fh = await fs.open(path.join(dir, 'big.bin'), 'w')
    await fh.truncate(BUILDER_CONTEXT_MAX_BYTES + 1)
    await fh.close()
    await expect(buildContextFiles(dir)).rejects.toThrow(/\.containerignore/)
  })
})

describe('streamBuildContext', () => {
  it('hands the extractor a tar of exactly the listed files', async () => {
    const dir = await context({ 'a.txt': 'a', 'sub/b.txt': 'b', 'c.txt': 'c' })
    let listing = ''
    await streamBuildContext(dir, ['a.txt', 'sub/b.txt'], '[t] ', (tar) => new Promise((resolve, reject) => {
      const list = spawn('tar', ['-tf', '-'], { stdio: ['pipe', 'pipe', 'inherit'] })
      list.stdout.on('data', (chunk: Buffer) => { listing += chunk.toString() })
      list.on('close', (code) => { if (code === 0) resolve(); else reject(new Error(`tar -t ${code}`)) })
      tar.pipe(list.stdin)
    }))
    expect(listing.split('\n').filter(Boolean)).toEqual(['a.txt', 'sub/b.txt'])
  })
})
