import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bakeCompileCache } from '../bake-compile-cache.mjs'

/**
 * Lays a stand-in adapter out as the image build does: the real entry
 * (`bundle-entry.mjs`) as `yaac-entry.mjs` beside a `yaac-bundle.mjs`, here
 * one that answers `initialize` and, when its input ends, prints the folder
 * Node reads its compile cache from. The build's run and a pod's are both
 * real node processes, which is what a compile cache has to be proved with.
 */
describe('bakeCompileCache', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  const ANSWERS = `
import fs from 'node:fs'
import module from 'node:module'
process.stdin.once('data', () => {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }) + '\\n')
})
process.stdin.on('end', () => {
  process.stdout.write(fs.realpathSync(module.getCompileCacheDir()))
})
`

  function adapter(bundle: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-bake-test-'))
    dirs.push(dir)
    const entry = path.join(dir, 'yaac-entry.mjs')
    fs.copyFileSync(fileURLToPath(new URL('../bundle-entry.mjs', import.meta.url)), entry)
    fs.chmodSync(entry, 0o755)
    fs.writeFileSync(path.join(dir, 'yaac-bundle.mjs'), bundle)
    return entry
  }

  it('leaves a cache that a pod running as another uid reads on its first start', async () => {
    const entry = adapter(ANSWERS)
    const cache = path.join(path.dirname(entry), 'yaac-compile-cache')

    expect(await bakeCompileCache(entry)).toBeGreaterThan(0)

    // The build's folder is named for the build's uid. Rename it to stand
    // for a build by another uid, as a pod of another install sees it.
    const [baked] = fs.readdirSync(cache)
    const uid = String(process.getuid?.())
    expect(baked.endsWith(`-${uid}`)).toBe(true)
    const foreign = `${baked.slice(0, -uid.length)}424242`
    fs.renameSync(path.join(cache, baked), path.join(cache, foreign))
    const files = fs.readdirSync(path.join(cache, foreign))

    const read = (): string => execFileSync(entry, { input: '{}\n' }).toString().split('\n').at(-1) ?? ''
    expect(read()).toBe(path.join(cache, foreign))
    expect(fs.readlinkSync(path.join(cache, baked))).toBe(foreign)
    // A second start finds the link in place, and neither wrote the bundle's
    // cache again.
    expect(read()).toBe(path.join(cache, foreign))
    expect(fs.readdirSync(path.join(cache, foreign))).toEqual(files)
  })

  it('fails the build when the adapter exits without answering', async () => {
    const entry = adapter('process.exit(3)\n')
    await expect(bakeCompileCache(entry)).rejects.toThrow(/exited \(3\) without answering initialize/)
  })
})
