import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ensureToolApiKeyConfig } from '#runtime/agents/tool-api-keys'
import { openRoot } from '#lib/confined-fs'
import { opencodeProviderInfo, piProviderInfo } from '@yaac/shared/tool-providers'

describe('ensureToolApiKeyConfig', () => {
  let dir: string
  const homes = async () => {
    for (const d of ['opencode', 'pi']) await fs.mkdir(path.join(dir, d), { recursive: true })
    return {
      opencodeConfig: await openRoot(path.join(dir, 'opencode'), 'no-links'),
      pi: await openRoot(path.join(dir, 'pi'), 'no-links'),
    }
  }
  const read = async (rel: string): Promise<unknown> => JSON.parse(await fs.readFile(path.join(dir, rel), 'utf8'))

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-tool-keys-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('points each tool at its own variable, keeping the user\'s config and earlier providers', async () => {
    await fs.mkdir(path.join(dir, 'pi', 'agent'), { recursive: true })
    await fs.writeFile(path.join(dir, 'pi', 'agent', 'models.json'), JSON.stringify({
      providers: { ollama: { baseUrl: 'http://localhost:11434/v1' }, anthropic: { apiKey: 'sk-user' } },
    }))

    expect(await ensureToolApiKeyConfig(await homes(), {
      opencode: opencodeProviderInfo('openrouter'), pi: piProviderInfo('openrouter'),
    })).toEqual({ opencodeConfigFile: 'yaac-keys/openrouter.json' })
    // A provider switch adds an entry beside the old one; a key the user
    // gave a provider themselves is left alone.
    await ensureToolApiKeyConfig(await homes(), { opencode: opencodeProviderInfo('groq'), pi: piProviderInfo('anthropic') })

    expect(await read('opencode/yaac-keys/openrouter.json'))
      .toEqual({ provider: { openrouter: { env: ['YAAC_OPENCODE_KEY_OPENROUTER', 'OPENROUTER_API_KEY'] } } })
    expect(await read('opencode/yaac-keys/groq.json'))
      .toEqual({ provider: { groq: { env: ['YAAC_OPENCODE_KEY_GROQ', 'GROQ_API_KEY'] } } })
    expect(await read('pi/agent/models.json')).toEqual({ providers: {
      ollama: { baseUrl: 'http://localhost:11434/v1' },
      anthropic: { apiKey: 'sk-user' },
      openrouter: { apiKey: '!printenv YAAC_PI_KEY_OPENROUTER || printenv OPENROUTER_API_KEY' },
    } })

    // pi runs the key command through a shell: yaac's variable first, then
    // the provider's own, so a workspace without yaac's still authenticates.
    const piKey = ((await read('pi/agent/models.json')) as { providers: { openrouter: { apiKey: string } } })
      .providers.openrouter.apiKey.slice(1)
    const run = (env: Record<string, string>): string =>
      execFileSync('sh', ['-c', piKey], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }).trim()
    expect(run({ YAAC_PI_KEY_OPENROUTER: 'sk-yaac', OPENROUTER_API_KEY: 'sk-env' })).toBe('sk-yaac')
    expect(run({ OPENROUTER_API_KEY: 'sk-env' })).toBe('sk-env')
  })

  it('leaves a models.json pi cannot parse for pi to report, and writes nothing for a signed-out tool', async () => {
    await fs.mkdir(path.join(dir, 'pi', 'agent'), { recursive: true })
    await fs.writeFile(path.join(dir, 'pi', 'agent', 'models.json'), '{ broken')

    expect(await ensureToolApiKeyConfig(await homes(), { pi: piProviderInfo('openrouter') })).toEqual({})

    expect(await fs.readFile(path.join(dir, 'pi', 'agent', 'models.json'), 'utf8')).toBe('{ broken')
    expect(await fs.readdir(path.join(dir, 'opencode'))).toEqual([])
  })
})
