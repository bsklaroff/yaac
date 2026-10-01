import { api } from './api'
import type { Chord, ShortcutId } from './shortcuts'
import type { AgentTool, AuthListResult, ToolInstallView, ToolLoginView } from '@yaac/shared/types'

export async function getAuthList(): Promise<AuthListResult> {
  return api.auth.list.$get()
}

/** Store a pasted HTTPS token under a name; returns the new credential id. */
export async function addHttpsCredential(name: string, token: string): Promise<string> {
  const { id } = await api.auth.git.credentials.$post({ json: { name, token } })
  return id
}

/** Generate an SSH key under a name. Returns the public key for the user to
 *  register with their git host. */
export async function generateSshKey(name: string): Promise<{ id: string; publicKey: string }> {
  return api.auth.git['ssh-keys'].$post({ json: { name } })
}

export async function renameGitCredential(id: string, name: string): Promise<void> {
  await api.auth.git.credentials[':id'].$patch({ param: { id }, json: { name } })
}

/** Replace a credential's secret, keeping its name and projects: with the
 *  pasted `token`, or (SSH, no token) a newly generated key whose public key
 *  is returned. The credential's id changes. */
export async function replaceGitCredential(
  id: string,
  token?: string,
): Promise<{ id: string; publicKey?: string }> {
  return api.auth.git.credentials[':id'].replace.$post({ param: { id }, json: token === undefined ? {} : { token } })
}

/** Delete a git credential; projects using it are left with none. */
export async function deleteGitCredential(id: string): Promise<void> {
  await api.auth.git.credentials[':id'].$delete({ param: { id } })
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

/** Sign out: drop the tool's stored credential. */
export async function clearToolAuth(tool: AgentTool): Promise<void> {
  await api.auth.clear.$post({ json: { service: tool } })
}

/** Start a browser sign-in through the tool's CLI on the server
 *  (claude/codex only; the route validates the param). */
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

/** Install the tool's CLI on the server, offered when it is missing
 *  (claude/codex only). */
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

/** Save one command's rebind. */
export async function setShortcutOverride(id: ShortcutId, chord: Chord): Promise<void> {
  await api.shortcuts.set.$post({ json: { id, chord } })
}

/** Drop every override, restoring the factory defaults. */
export async function resetShortcuts(): Promise<void> {
  await api.shortcuts.reset.$post()
}

/** Read the global user Dockerfile; '' when unset. */
export async function getUserDockerfile(): Promise<string> {
  const { content } = await api.config['user-dockerfile'].$get()
  return content
}

/** Write the global user Dockerfile (empty clears it). The server requires
 *  a non-empty file to build `FROM ${BASE_IMAGE}`. */
export async function saveUserDockerfile(content: string): Promise<void> {
  await api.config['user-dockerfile'].$put({ json: { content } })
}

/** The git identity this server's workspaces commit under (null when unset). */
export async function getGitIdentity(): Promise<{ name: string; email: string } | null> {
  const { identity } = await api.config['git-identity'].$get()
  return identity
}

/** Set the git identity. Both fields are required; the server validates the
 *  email. */
export async function setGitIdentity(
  identity: { name: string; email: string },
): Promise<{ name: string; email: string }> {
  const saved = await api.config['git-identity'].$put({ json: identity })
  return saved.identity
}

export interface TimeZoneSetting {
  /** The IANA zone workspaces launch with; null until a client reports one. */
  timeZone: string | null
  /** The user chose it here, so device reports leave it alone. */
  pinned: boolean
}

/** This browser's IANA time zone. */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** The zone this server's workspaces launch with. */
export async function getTimeZone(): Promise<TimeZoneSetting> {
  return api.config['time-zone'].$get()
}

/**
 * Set the zone. `pinned` omitted reports this device's zone, which the server
 * ignores while the user has one pinned; `pinned: false` unpins.
 */
export async function setTimeZone(timeZone: string, pinned?: boolean): Promise<TimeZoneSetting> {
  return api.config['time-zone'].$put({ json: { timeZone, pinned } })
}
