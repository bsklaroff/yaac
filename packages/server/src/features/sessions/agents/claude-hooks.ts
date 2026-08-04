import fs from 'node:fs/promises'

/**
 * Registration of yaac's agent-session discovery hook with Claude Code.
 *
 * The hook script itself is baked into the image at `/etc/yaac/agent-links.sh`
 * (dockerfiles/Dockerfile.tools) and shared with codex, which runs it as a
 * managed hook. Claude has no managed-hook tier, so it is registered from the
 * user-writable `~/.claude/settings.json` — the same file `seedClaudeSettings`
 * already owns. The script is *not* copied into the mounted claude dir: a
 * session must not be able to rewrite what yaac uses to track it.
 *
 * `SessionStart` fires on `startup`, `resume`, `clear`, and `compact`, which is
 * exactly the set of events that changes which conversation a pane is in — and
 * therefore the set yaac needs to see. `/compact` keeps the same conversation
 * id, so its firing just refreshes the same links.
 */

/** In-pod path of the shared hook script (baked into the tools image). */
export const AGENT_LINKS_HOOK = '/etc/yaac/agent-links.sh'

/** Claude's host-mounted home, as the pod sees it. */
export const CONTAINER_CLAUDE_HOME = '/home/yaac/.claude'

/** The command claude runs. The home travels as an argument because one
 *  script body serves every tool (see the Dockerfile comment). */
export const CLAUDE_HOOK_COMMAND = `${AGENT_LINKS_HOOK} ${CONTAINER_CLAUDE_HOME}`

interface HookEntry {
  type?: string
  command?: string
  timeout?: number
}

interface HookMatcher {
  matcher?: string
  hooks?: HookEntry[]
}

interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[] | undefined>
  [key: string]: unknown
}

/**
 * Merge yaac's `SessionStart` hook into a project's `~/.claude/settings.json`.
 *
 * Idempotent and additive: unrelated settings keys (the bypass-prompt flag and
 * cleanup period `seedClaudeSettings` writes, whatever theme claude-code wrote
 * itself) and any user-registered hooks survive, and a settings file that
 * already carries our entry is left byte-identical. A malformed settings file
 * is replaced rather than propagated — claude would ignore it anyway, and the
 * two keys yaac cares about are re-seeded on every session create.
 *
 * Best-effort by contract: losing the hook costs conversation discovery for
 * that session (it falls back to the one conversation pinned by
 * `--session-id`), which must never be worth failing a session create over.
 */
export async function ensureClaudeHooks(settingsPath: string): Promise<void> {
  let settings: ClaudeSettings = {}
  try {
    settings = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as ClaudeSettings
  } catch {
    // missing or invalid — start fresh
  }

  const hooks = { ...settings.hooks }
  const sessionStart = [...(hooks.SessionStart ?? [])]
  const already = sessionStart.some((m) =>
    m.hooks?.some((h) => h.command === CLAUDE_HOOK_COMMAND) ?? false,
  )
  if (already) return

  sessionStart.push({
    matcher: '*',
    hooks: [{ type: 'command', command: CLAUDE_HOOK_COMMAND, timeout: 10 }],
  })
  hooks.SessionStart = sessionStart
  settings.hooks = hooks
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n')
}
