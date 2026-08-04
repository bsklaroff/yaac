import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CLAUDE_HOOK_COMMAND, ensureClaudeHooks } from '#features/sessions/agents/claude-hooks'
import { seedClaudeSettings } from '#features/sessions/seed'

describe('ensureClaudeHooks', () => {
  let dir: string
  let settingsPath: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-claude-hooks-'))
    settingsPath = path.join(dir, 'settings.json')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  interface HookEntry { type?: string; command?: string; timeout?: number }
  interface HookMatcher { matcher?: string; hooks?: HookEntry[] }
  interface Settings {
    hooks?: Record<string, HookMatcher[] | undefined>
    [key: string]: unknown
  }

  async function read(): Promise<Settings> {
    return JSON.parse(await fs.readFile(settingsPath, 'utf8')) as Settings
  }

  it('registers the SessionStart hook alongside the settings create.ts seeds', async () => {
    // The real ordering: seedClaudeSettings owns the file first, then the hook
    // is merged in. Both keys have to survive.
    await seedClaudeSettings(settingsPath)
    await ensureClaudeHooks(settingsPath)

    const settings = await read()
    expect(settings.skipDangerousModePermissionPrompt).toBe(true)
    expect(settings.cleanupPeriodDays).toBe(36500)
    expect(settings.hooks?.SessionStart).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: CLAUDE_HOOK_COMMAND, timeout: 10 }] },
    ])
    // The command points at the image-baked script with claude's home as its
    // argument — nothing is copied into the (session-writable) claude dir.
    expect(CLAUDE_HOOK_COMMAND).toBe('/etc/yaac/agent-links.sh /home/yaac/.claude')
  })

  it('is idempotent across the session creates that re-run it', async () => {
    await ensureClaudeHooks(settingsPath)
    const first = await fs.readFile(settingsPath, 'utf8')
    await ensureClaudeHooks(settingsPath)
    await ensureClaudeHooks(settingsPath)
    expect(await fs.readFile(settingsPath, 'utf8')).toBe(first)
    expect((await read()).hooks?.SessionStart).toHaveLength(1)
  })

  it("preserves the user's own hooks, including their own SessionStart entries", async () => {
    await fs.writeFile(settingsPath, JSON.stringify({
      theme: 'dark',
      hooks: {
        SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'mine.sh' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh' }] }],
      },
    }))

    await ensureClaudeHooks(settingsPath)

    const settings = await read()
    expect(settings.theme).toBe('dark')
    expect(settings.hooks?.PreToolUse).toHaveLength(1)
    expect(settings.hooks?.SessionStart?.map((m) => m.hooks?.[0]?.command))
      .toEqual(['mine.sh', CLAUDE_HOOK_COMMAND])
  })

  it('starts fresh from a malformed settings file rather than propagating it', async () => {
    // claude ignores unparseable settings anyway, and create.ts re-seeds the
    // two keys it cares about on every session.
    await fs.writeFile(settingsPath, '{ not json')
    await ensureClaudeHooks(settingsPath)
    expect((await read()).hooks?.SessionStart).toHaveLength(1)
  })
})
