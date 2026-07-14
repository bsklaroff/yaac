import { api } from './api'
import type { Chord, ShortcutId } from './shortcuts'
import type { AgentTool, AuthListResult, ToolInstallView, ToolLoginView } from '@yaac/shared/types'

export async function getDefaultTool(): Promise<AgentTool | null> {
  const { tool } = await api.tool.get.$get()
  return tool
}

export async function setDefaultTool(tool: AgentTool): Promise<void> {
  await api.tool.set.$post({ json: { tool } })
}

export async function getAuthList(): Promise<AuthListResult> {
  return api.auth.list.$get()
}

export async function addGitCredential(pattern: string, token: string): Promise<void> {
  await api.auth.git.credentials.$post({ json: { kind: 'https', pattern, token } })
}

/** Save a pasted API key as the tool's credential (provider: opencode/pi only). */
export async function setToolApiKey(
  tool: AgentTool,
  apiKey: string,
  provider?: string,
): Promise<void> {
  await api.auth[':tool'].$put({
    param: { tool },
    json: { kind: 'api-key', apiKey, ...(provider ? { provider } : {}) },
  })
}

/** Sign out — drop the tool's stored credential. */
export async function clearToolAuth(tool: AgentTool): Promise<void> {
  await api.auth.clear.$post({ json: { service: tool } })
}

/** Kick off a server-run vendor-CLI browser sign-in (claude/codex). The route
 *  only serves those two tools; runtime param validation guards the cast. */
export async function startToolLogin(tool: AgentTool): Promise<ToolLoginView> {
  return api.auth[':tool'].login.start.$post({ param: { tool: tool as 'claude' | 'codex' } })
}

/** Poll a sign-in flow's state. */
export async function getToolLogin(id: string): Promise<ToolLoginView> {
  return api.auth.login[':id'].$get({ param: { id } })
}

/** Forward a line to the login CLI's stdin (claude's paste-back code). */
export async function sendToolLoginInput(id: string, text: string): Promise<ToolLoginView> {
  return api.auth.login[':id'].input.$post({ param: { id }, json: { text } })
}

/** Abort a sign-in flow. */
export async function cancelToolLogin(id: string): Promise<void> {
  await api.auth.login[':id'].cancel.$post({ param: { id } })
}

/** Kick off a server-run install of the tool's CLI (offered on cliMissing).
 *  Claude/codex only, same as login. */
export async function startToolInstall(tool: AgentTool): Promise<ToolInstallView> {
  return api.auth[':tool'].install.start.$post({ param: { tool: tool as 'claude' | 'codex' } })
}

/** Poll an install flow's state. */
export async function getToolInstall(id: string): Promise<ToolInstallView> {
  return api.auth.install[':id'].$get({ param: { id } })
}

/** Abort an install flow. */
export async function cancelToolInstall(id: string): Promise<void> {
  await api.auth.install[':id'].cancel.$post({ param: { id } })
}

/** Saved keyboard-shortcut overrides, keyed by command id (empty when none). */
export async function getShortcutOverrides(): Promise<Record<string, Chord>> {
  const { overrides } = await api.shortcuts.get.$get()
  return overrides
}

/** Persist a single command's rebind. */
export async function setShortcutOverride(id: ShortcutId, chord: Chord): Promise<void> {
  await api.shortcuts.set.$post({ json: { id, chord } })
}

/** Drop every override, restoring the factory defaults. */
export async function resetShortcuts(): Promise<void> {
  await api.shortcuts.reset.$post()
}

/** Read the global user Dockerfile (~/.yaac/Dockerfile.user); '' when unset. */
export async function getUserDockerfile(): Promise<string> {
  const { content } = await api.config['user-dockerfile'].$get()
  return content
}

/** Write (or clear, when empty) the global user Dockerfile. Validated
 *  server-side: a non-empty file must layer on `${BASE_IMAGE}`. */
export async function saveUserDockerfile(content: string): Promise<void> {
  await api.config['user-dockerfile'].$put({ json: { content } })
}
