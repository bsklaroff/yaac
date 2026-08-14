import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  CLAUDE_HOOK_COMMAND,
  classifyClaudeTitle,
  ensureClaudeHooks,
  getFirstUserMessage,
} from '#runtime/agents/claude'
import { seedClaudeSettings } from '#domain/worktrees/seed'

// Title fixtures below reproduce states observed against a live Claude
// Code session inside a session pod: a running turn animates a spinner
// prefix; every user-blocked state (idle prompt, permission dialog, plan
// approval, AskUserQuestion) flips the prefix to ✳. Which glyphs the
// spinner animates is release-dependent — 2.1.226 animated the Braille
// ⠂⠐, 2.1.228 changed it to the circle phases ◐◑ — so both sets are
// fixtures here and a release on either must read as running.
describe('classifyClaudeTitle', () => {
  it('returns running for a Braille-spinner title (turn in flight)', () => {
    expect(classifyClaudeTitle('⠐ Create temporary marker file')).toBe('running')
    expect(classifyClaudeTitle('⠋ Fix the login bug')).toBe('running')
  })

  it('returns running across the whole Braille block', () => {
    // The animation cycles through arbitrary Braille patterns — accept
    // the full U+2800–U+28FF range, including the endpoints.
    expect(classifyClaudeTitle('⠀ edge of block')).toBe('running')
    expect(classifyClaudeTitle('⣿ edge of block')).toBe('running')
  })

  it('returns running for a circle-phase spinner title (turn in flight)', () => {
    // Observed live on 2.1.229: the title cycles ◐/◑ for the whole turn
    // and never shows a Braille frame. Classifying these as waiting is
    // what pinned a busy agent to "waiting" for its entire run.
    expect(classifyClaudeTitle('◐ Review PR #115: retire legacy-compat paths')).toBe('running')
    expect(classifyClaudeTitle('◑ Review PR #115: retire legacy-compat paths')).toBe('running')
  })

  it('returns running across the whole circle-phase range', () => {
    // The shipped array is two frames (◐◑) but the four phases are one
    // contiguous run (U+25D0–U+25D3) and a release has already changed
    // frame count within a set — accept all four, endpoints included.
    expect(classifyClaudeTitle('◒ edge of range')).toBe('running')
    expect(classifyClaudeTitle('◓ edge of range')).toBe('running')
  })

  it('returns running for a bare spinner with trailing newline (display-message output)', () => {
    expect(classifyClaudeTitle('⠹ Summarize findings\n')).toBe('running')
    expect(classifyClaudeTitle('◐ Summarize findings\n')).toBe('running')
  })

  it('returns waiting for the idle ✳ title', () => {
    expect(classifyClaudeTitle('✳ Create temporary marker file')).toBe('waiting')
  })

  it('returns waiting for the fresh-boot title before any turn ran', () => {
    expect(classifyClaudeTitle('✳ Claude Code')).toBe('waiting')
  })

  it('returns waiting while a permission dialog is up', () => {
    // Observed live: the instant the Bash permission dialog appears the
    // title flips from "⠂ Create temporary marker file" to ✳. Same for
    // trust/onboarding dialogs. This is the case the JSONL transcript
    // cannot detect (the blocking tool_use isn't persisted until
    // answered), so it must classify as waiting here.
    expect(classifyClaudeTitle('✳ Create temporary marker file')).toBe('waiting')
  })

  it('returns waiting for the tmux default title (claude has not set one)', () => {
    // Until a program emits an OSC title, #{pane_title} is the pod
    // hostname — a session still booting reads as waiting.
    expect(classifyClaudeTitle('yaac-yaac-ee9cb586-74d3-4a1f-9d1f-482839b26d70-5tfxq')).toBe('waiting')
  })

  it('returns waiting for an empty title', () => {
    expect(classifyClaudeTitle('')).toBe('waiting')
  })

  it('does not match the geometric glyphs bordering the circle phases', () => {
    // U+25D0–U+25D3 is bounded deliberately: Claude Code uses ● (U+25CF)
    // and ○ (U+25CB) just below it as transcript bullets, and ◆/◇
    // (U+25C6/U+25C7) elsewhere. Widening the range to the block would
    // make a title starting with any of them read as a live turn.
    expect(classifyClaudeTitle('● Ran a command')).toBe('waiting')
    expect(classifyClaudeTitle('○ Pending step')).toBe('waiting')
    expect(classifyClaudeTitle('◆ Marker')).toBe('waiting')
    expect(classifyClaudeTitle('◔ Just past the phases')).toBe('waiting')
  })

  it('only matches the spinner at the first character', () => {
    // A task summary that itself contains a spinner glyph must not
    // false-positive when the leading ✳ marks the session as idle.
    expect(classifyClaudeTitle('✳ Fix ⠋ spinner rendering')).toBe('waiting')
    expect(classifyClaudeTitle('✳ Fix ◐ spinner rendering')).toBe('waiting')
    expect(classifyClaudeTitle(' ⠋ leading space')).toBe('waiting')
    expect(classifyClaudeTitle(' ◐ leading space')).toBe('waiting')
  })
})

describe('getFirstUserMessage', () => {
  let tmpDir: string
  let jsonlPath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'first-user-msg-test-'))
    jsonlPath = path.join(tmpDir, 'session.jsonl')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function writeEntry(entry: Record<string, unknown>): Promise<void> {
    return fs.appendFile(jsonlPath, JSON.stringify(entry) + '\n')
  }

  it('returns string content from first user message', async () => {
    await writeEntry({ type: 'permission-mode', permissionMode: 'default' })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'fix the login bug' } })
    await writeEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } })
    expect(await getFirstUserMessage(jsonlPath)).toBe('fix the login bug')
  })

  it('returns text from content block array', async () => {
    await writeEntry({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'refactor the API' }] },
    })
    expect(await getFirstUserMessage(jsonlPath)).toBe('refactor the API')
  })

  it('returns undefined when no user messages exist', async () => {
    await writeEntry({ type: 'permission-mode', permissionMode: 'default' })
    await writeEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } })
    expect(await getFirstUserMessage(jsonlPath)).toBeUndefined()
  })

  it('returns undefined for empty file', async () => {
    await fs.writeFile(jsonlPath, '')
    expect(await getFirstUserMessage(jsonlPath)).toBeUndefined()
  })

  it('returns undefined for missing file', async () => {
    expect(await getFirstUserMessage(path.join(tmpDir, 'nope.jsonl'))).toBeUndefined()
  })

  it('skips metadata and returns first user message', async () => {
    await writeEntry({ type: 'system' })
    await writeEntry({ type: 'permission-mode', permissionMode: 'default' })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'hello world' } })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'second message' } })
    expect(await getFirstUserMessage(jsonlPath)).toBe('hello world')
  })

  it('finds the first user message beyond the first 8KB of the file', async () => {
    await writeEntry({ type: 'system', content: 'x'.repeat(12000) })
    await writeEntry({ type: 'permission-mode', permissionMode: 'default' })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'hello world' } })

    expect(await getFirstUserMessage(jsonlPath)).toBe('hello world')
  })

  it('skips a session started with a slash command and returns the first real message', async () => {
    // Reproduces the on-disk sequence a `/model` invocation writes before
    // the first real turn: an isMeta caveat, the command invocation, and
    // its stdout — all synthetic type:'user' entries.
    await writeEntry({
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: '<local-command-caveat>Caveat: ...</local-command-caveat>' },
    })
    await writeEntry({
      type: 'user',
      message: {
        role: 'user',
        content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>',
      },
    })
    await writeEntry({
      type: 'user',
      message: { role: 'user', content: '<local-command-stdout>Set model to Fable 5</local-command-stdout>' },
    })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'fix the login bug' } })

    expect(await getFirstUserMessage(jsonlPath)).toBe('fix the login bug')
  })

  it('skips an isMeta user entry even without a command wrapper', async () => {
    await writeEntry({ type: 'user', isMeta: true, message: { role: 'user', content: 'synthetic preamble' } })
    await writeEntry({ type: 'user', message: { role: 'user', content: 'real message' } })
    expect(await getFirstUserMessage(jsonlPath)).toBe('real message')
  })

  it('returns undefined when only command messages exist', async () => {
    await writeEntry({
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>' },
    })
    await writeEntry({
      type: 'user',
      message: { role: 'user', content: '<command-name>/clear</command-name>' },
    })
    expect(await getFirstUserMessage(jsonlPath)).toBeUndefined()
  })
})

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
    // Bare name and `$HOME`, because this file is shared by a whole project
    // and read by worktrees of either substrate: the staged script sits at
    // /usr/local/bin in a pod and under the workspace's own home on a host,
    // and no absolute form of either names it correctly in both.
    expect(CLAUDE_HOOK_COMMAND).toBe('yaac-agent-links "$HOME/.claude" claude')
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

  it('replaces the dead in-image form of our own hook, keeping the user their own', async () => {
    // A project seeded by an older install carries the hook by its in-image
    // path. That command resolves nowhere now — no image has the script, and a
    // host never did — so claude errors on every session start until it goes.
    // See docs/legacy-compat-shims.md.
    await fs.writeFile(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: '*', hooks: [
            { type: 'command', command: 'mine.sh' },
            { type: 'command', command: '/etc/yaac/agent-links.sh /home/yaac/.claude claude' },
          ] },
          { matcher: '*', hooks: [
            { type: 'command', command: '/etc/yaac/agent-links.sh /home/yaac/.codex codex' },
          ] },
        ],
      },
    }))

    await ensureClaudeHooks(settingsPath)

    const commands = (await read()).hooks?.SessionStart
      ?.flatMap((m) => m.hooks?.map((h) => h.command) ?? [])
    // Any argument variant goes, and the matcher left holding nothing goes
    // with it — while the user's own hook stays where they put it.
    expect(commands).toEqual(['mine.sh', CLAUDE_HOOK_COMMAND])
  })

  it('strips the legacy entry even when the current one is already registered', async () => {
    // The order the two arrive in is not ours to choose: a project can carry
    // both once a newer install has run against it, and the early-return that
    // keeps this idempotent must not skip the cleanup.
    await ensureClaudeHooks(settingsPath)
    const settings = await read()
    settings.hooks?.SessionStart?.unshift({
      matcher: '*',
      hooks: [{ type: 'command', command: '/etc/yaac/agent-links.sh /home/yaac/.claude claude' }],
    })
    await fs.writeFile(settingsPath, JSON.stringify(settings))

    await ensureClaudeHooks(settingsPath)

    expect((await read()).hooks?.SessionStart)
      .toEqual([{ matcher: '*', hooks: [
        { type: 'command', command: CLAUDE_HOOK_COMMAND, timeout: 10 },
      ] }])
    // And having done it once, it settles: the next create rewrites nothing.
    const migrated = await fs.readFile(settingsPath, 'utf8')
    await ensureClaudeHooks(settingsPath)
    expect(await fs.readFile(settingsPath, 'utf8')).toBe(migrated)
  })

  it('starts fresh from a malformed settings file rather than propagating it', async () => {
    // claude ignores unparseable settings anyway, and create.ts re-seeds the
    // two keys it cares about on every session.
    await fs.writeFile(settingsPath, '{ not json')
    await ensureClaudeHooks(settingsPath)
    expect((await read()).hooks?.SessionStart).toHaveLength(1)
  })
})
