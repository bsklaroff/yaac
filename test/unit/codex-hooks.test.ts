import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import * as TOML from 'smol-toml'
import { ensureCodexHooksJson, ensureCodexConfigToml } from '@/lib/session/codex-hooks'

const YAAC_HOOK_COMMAND = '/home/yaac/.codex/.yaac-hook.sh'

interface HookEntry { type: string; command: string; timeout?: number }
interface HookMatcher { matcher: string; hooks: HookEntry[] }
interface HooksFile { hooks: Record<string, HookMatcher[]> }

describe('ensureCodexHooksJson', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-hooks-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('creates hooks.json from scratch when none exists', async () => {
    await ensureCodexHooksJson(tmpDir)
    const raw = await fs.readFile(path.join(tmpDir, 'hooks.json'), 'utf8')
    const parsed = JSON.parse(raw) as HooksFile
    expect(parsed.hooks.SessionStart).toHaveLength(1)
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe(YAAC_HOOK_COMMAND)
  })

  it('preserves existing hooks and adds yaac hook', async () => {
    const existing: HooksFile = {
      hooks: {
        SessionStart: [{
          matcher: '*',
          hooks: [{ type: 'command', command: '/some/other/hook.sh', timeout: 30 }],
        }],
        PostToolUse: [{
          matcher: '*',
          hooks: [{ type: 'command', command: '/another/hook.sh' }],
        }],
      },
    }
    await fs.writeFile(path.join(tmpDir, 'hooks.json'), JSON.stringify(existing))

    await ensureCodexHooksJson(tmpDir)
    const raw = await fs.readFile(path.join(tmpDir, 'hooks.json'), 'utf8')
    const parsed = JSON.parse(raw) as HooksFile

    // Original SessionStart hook preserved
    expect(parsed.hooks.SessionStart).toHaveLength(2)
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe('/some/other/hook.sh')
    // Yaac hook added
    expect(parsed.hooks.SessionStart[1].hooks[0].command).toBe(YAAC_HOOK_COMMAND)
    // Other hook types preserved
    expect(parsed.hooks.PostToolUse).toHaveLength(1)
  })

  it('does not duplicate yaac hook when already present', async () => {
    await ensureCodexHooksJson(tmpDir)
    await ensureCodexHooksJson(tmpDir)

    const raw = await fs.readFile(path.join(tmpDir, 'hooks.json'), 'utf8')
    const parsed = JSON.parse(raw) as HooksFile
    const yaacHooks = parsed.hooks.SessionStart.filter((m) =>
      m.hooks.some((h) => h.command === YAAC_HOOK_COMMAND),
    )
    expect(yaacHooks).toHaveLength(1)
  })

  it('handles invalid existing hooks.json gracefully', async () => {
    await fs.writeFile(path.join(tmpDir, 'hooks.json'), 'not valid json')
    await ensureCodexHooksJson(tmpDir)

    const raw = await fs.readFile(path.join(tmpDir, 'hooks.json'), 'utf8')
    const parsed = JSON.parse(raw) as HooksFile
    expect(parsed.hooks.SessionStart).toHaveLength(1)
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe(YAAC_HOOK_COMMAND)
  })
})

describe('ensureCodexConfigToml', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-config-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('creates config.toml from scratch when none exists', async () => {
    await ensureCodexConfigToml(tmpDir)
    const raw = await fs.readFile(path.join(tmpDir, 'config.toml'), 'utf8')
    const parsed = TOML.parse(raw) as Record<string, Record<string, unknown>>
    expect(parsed.features.codex_hooks).toBe(true)
    expect(parsed.features.apps).toBe(false)
  })

  it('preserves existing config and adds feature flags', async () => {
    await fs.writeFile(path.join(tmpDir, 'config.toml'), [
      'model = "o3"',
      '',
      '[history]',
      'persistence = "none"',
    ].join('\n'))

    await ensureCodexConfigToml(tmpDir)
    const raw = await fs.readFile(path.join(tmpDir, 'config.toml'), 'utf8')
    const parsed = TOML.parse(raw) as Record<string, unknown>

    expect(parsed.model).toBe('o3')
    expect((parsed.history as Record<string, unknown>).persistence).toBe('none')
    expect((parsed.features as Record<string, unknown>).codex_hooks).toBe(true)
    expect((parsed.features as Record<string, unknown>).apps).toBe(false)
  })

  it('preserves existing features and adds feature flags', async () => {
    await fs.writeFile(path.join(tmpDir, 'config.toml'), [
      '[features]',
      'some_other_feature = true',
    ].join('\n'))

    await ensureCodexConfigToml(tmpDir)
    const raw = await fs.readFile(path.join(tmpDir, 'config.toml'), 'utf8')
    const parsed = TOML.parse(raw) as Record<string, Record<string, unknown>>

    expect(parsed.features.some_other_feature).toBe(true)
    expect(parsed.features.codex_hooks).toBe(true)
    expect(parsed.features.apps).toBe(false)
  })

  it('does not rewrite when both flags already set correctly', async () => {
    await fs.writeFile(path.join(tmpDir, 'config.toml'), [
      '[features]',
      'codex_hooks = true',
      'apps = false',
    ].join('\n'))

    const beforeStat = await fs.stat(path.join(tmpDir, 'config.toml'))
    // Small delay to ensure mtime would differ if rewritten
    await new Promise((r) => setTimeout(r, 50))
    await ensureCodexConfigToml(tmpDir)
    const afterStat = await fs.stat(path.join(tmpDir, 'config.toml'))

    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs)
  })

  it('rewrites when codex_hooks is set but apps is not', async () => {
    await fs.writeFile(path.join(tmpDir, 'config.toml'), [
      '[features]',
      'codex_hooks = true',
    ].join('\n'))

    await ensureCodexConfigToml(tmpDir)
    const raw = await fs.readFile(path.join(tmpDir, 'config.toml'), 'utf8')
    const parsed = TOML.parse(raw) as Record<string, Record<string, unknown>>

    expect(parsed.features.codex_hooks).toBe(true)
    expect(parsed.features.apps).toBe(false)
  })

  it('handles invalid existing config.toml gracefully', async () => {
    await fs.writeFile(path.join(tmpDir, 'config.toml'), 'not [valid toml {{')
    await ensureCodexConfigToml(tmpDir)

    const raw = await fs.readFile(path.join(tmpDir, 'config.toml'), 'utf8')
    const parsed = TOML.parse(raw) as Record<string, Record<string, unknown>>
    expect(parsed.features.codex_hooks).toBe(true)
    expect(parsed.features.apps).toBe(false)
  })
})
