import { api } from './apiClient'
import type { Chord, ShortcutId } from './shortcuts'
import type { AgentTool, AuthListResult, OpencodeProvider, ToolInstallView, ToolLoginView } from '@/shared/types'

export async function getDefaultTool(): Promise<AgentTool | null> {
  const res = await api.get<{ tool: AgentTool | null }>('/tool/get')
  return res.tool
}

export async function setDefaultTool(tool: AgentTool): Promise<void> {
  await api.post('/tool/set', { tool })
}

export async function getAuthList(): Promise<AuthListResult> {
  return api.get<AuthListResult>('/auth/list')
}

export async function addGitCredential(pattern: string, token: string): Promise<void> {
  await api.post('/auth/git/credentials', { kind: 'https', pattern, token })
}

/** Save a pasted API key as the tool's credential (provider: opencode only). */
export async function setToolApiKey(
  tool: AgentTool,
  apiKey: string,
  provider?: OpencodeProvider,
): Promise<void> {
  await api.put(`/auth/${tool}`, { kind: 'api-key', apiKey, ...(provider ? { provider } : {}) })
}

/** Sign out — drop the tool's stored credential. */
export async function clearToolAuth(tool: AgentTool): Promise<void> {
  await api.post('/auth/clear', { service: tool })
}

/** Kick off a daemon-run vendor-CLI browser sign-in (claude/codex). */
export async function startToolLogin(tool: AgentTool): Promise<ToolLoginView> {
  return api.post<ToolLoginView>(`/auth/${tool}/login/start`)
}

/** Poll a sign-in flow's state. */
export async function getToolLogin(id: string): Promise<ToolLoginView> {
  return api.get<ToolLoginView>(`/auth/login/${id}`)
}

/** Forward a line to the login CLI's stdin (claude's paste-back code). */
export async function sendToolLoginInput(id: string, text: string): Promise<ToolLoginView> {
  return api.post<ToolLoginView>(`/auth/login/${id}/input`, { text })
}

/** Abort a sign-in flow. */
export async function cancelToolLogin(id: string): Promise<void> {
  await api.post(`/auth/login/${id}/cancel`)
}

/** Kick off a daemon-run install of the tool's CLI (offered on cliMissing). */
export async function startToolInstall(tool: AgentTool): Promise<ToolInstallView> {
  return api.post<ToolInstallView>(`/auth/${tool}/install/start`)
}

/** Poll an install flow's state. */
export async function getToolInstall(id: string): Promise<ToolInstallView> {
  return api.get<ToolInstallView>(`/auth/install/${id}`)
}

/** Abort an install flow. */
export async function cancelToolInstall(id: string): Promise<void> {
  await api.post(`/auth/install/${id}/cancel`)
}

/** Saved keyboard-shortcut overrides, keyed by command id (empty when none). */
export async function getShortcutOverrides(): Promise<Record<string, Chord>> {
  const res = await api.get<{ overrides: Record<string, Chord> }>('/shortcuts/get')
  return res.overrides
}

/** Persist a single command's rebind. */
export async function setShortcutOverride(id: ShortcutId, chord: Chord): Promise<void> {
  await api.post('/shortcuts/set', { id, chord })
}

/** Drop every override, restoring the factory defaults. */
export async function resetShortcuts(): Promise<void> {
  await api.post('/shortcuts/reset')
}

/** Read the global user Dockerfile (~/.yaac/Dockerfile.user); '' when unset. */
export async function getUserDockerfile(): Promise<string> {
  const res = await api.get<{ content: string }>('/config/user-dockerfile')
  return res.content
}

/** Write (or clear, when empty) the global user Dockerfile. Validated
 *  server-side: a non-empty file must layer on `${BASE_IMAGE}`. */
export async function saveUserDockerfile(content: string): Promise<void> {
  await api.put('/config/user-dockerfile', { content })
}
