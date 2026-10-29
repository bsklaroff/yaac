import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

/**
 * `workspace-bin/yaac-package-cache`, run as shipped against a temp `HOME`
 * and `CARGO_HOME`. The init script runs it with the launch's URLs, and the
 * server execs it on a live pod to re-point or revoke a cache, so the same
 * script must add an entry, replace its own, and remove only its own,
 * leaving any registry the image or user configured alone.
 */

const SCRIPT = path.resolve(__dirname, '..', '..', '..', '..', '..', 'workspace-bin', 'yaac-package-cache')
const NPM = 'http://yaac-npm-cache.ns.svc.cluster.local:4873/'
const CRATES = 'http://yaac-crates-cache.ns.svc.cluster.local:4875/'

describe('yaac-package-cache', () => {
  let home: string
  const npmrc = (): string => path.join(home, '.npmrc')
  const cargoConfig = (): string => path.join(home, 'cargo', 'config.toml')
  const read = (f: string): Promise<string> => fs.readFile(f, 'utf8').catch(() => '')

  function run(...args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile('sh', [SCRIPT, ...args], {
        env: { PATH: process.env.PATH ?? '', HOME: home, CARGO_HOME: path.join(home, 'cargo') },
      }, (err) => { if (err) reject(new Error(err.message)); else resolve() })
    })
  }

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-package-cache-'))
  })

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true })
  })

  it('points cargo at the cache, re-points and revokes only its own block, and yields to an existing replacement', async () => {
    // No CARGO_HOME yet: created, with the replacement block alone.
    await run('cargo', CRATES)
    const block = [
      '# yaac-crates-cache begin',
      '[source.crates-io]',
      'replace-with = "yaac-crates-cache"',
      '[source.yaac-crates-cache]',
      `registry = "sparse+${CRATES}index/"`,
      '# yaac-crates-cache end',
      '',
    ].join('\n')
    expect(await read(cargoConfig())).toBe(block)

    // A re-run (a claim re-deciding) replaces the block rather than
    // stacking a duplicate table, which cargo would refuse to parse.
    await run('cargo', CRATES)
    expect(await read(cargoConfig())).toBe(block)

    // Revoking removes only the block, keeping what the image put there.
    await fs.writeFile(cargoConfig(), `[net]\ngit-fetch-with-cli = true\n${block}`)
    await run('cargo', '')
    expect(await read(cargoConfig())).toBe('[net]\ngit-fetch-with-cli = true\n')
    await run('cargo')
    expect(await read(cargoConfig())).toBe('[net]\ngit-fetch-with-cli = true\n')

    // A file that already replaces crates.io keeps its own replacement.
    const own = '[source.crates-io]\nreplace-with = "vendored"\n'
    await fs.writeFile(cargoConfig(), own)
    await run('cargo', CRATES)
    expect(await read(cargoConfig())).toBe(own)
  })

  it('makes the cache npm\'s default registry, re-points and revokes only its own line, and yields to an existing one', async () => {
    await run('npm', NPM)
    expect(await read(npmrc())).toBe(`registry=${NPM}\n`)
    await run('npm', NPM)
    expect(await read(npmrc())).toBe(`registry=${NPM}\n`)

    await fs.writeFile(npmrc(), `prefer-offline=true\nregistry=${NPM}\n`)
    await run('npm', '')
    expect(await read(npmrc())).toBe('prefer-offline=true\n')

    const own = 'registry=https://npm.example.com/\n'
    await fs.writeFile(npmrc(), own)
    await run('npm', NPM)
    expect(await read(npmrc())).toBe(own)
  })

  it('refuses an unknown client', async () => {
    await expect(run('pip', 'http://x/')).rejects.toThrow()
  })
})
