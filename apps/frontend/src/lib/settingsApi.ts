import { rpc, unwrap, expectOk } from './rpc'
import type { Chord, ShortcutId } from './shortcuts'
import type { AgentTool, AuthListResult, OpencodeProvider, ToolInstallView, ToolLoginView } from '@yaac/shared/types'

export async function getDefaultTool(): Promise<AgentTool | null> {
  const { tool } = await unwrap(rpc.tool.get.$get())
  return tool
}

export async function setDefaultTool(tool: AgentTool): Promise<void> {
  await expectOk(rpc.tool.set.$post({ json: { tool } }))
}

export async function getAuthList(): Promise<AuthListResult> {
  return unwrap(rpc.auth.list.$get())
}

export async function addGitCredential(pattern: string, token: string): Promise<void> {
  await expectOk(rpc.auth.git.credentials.$post({ json: { kind: 'https', pattern, token } }))
}

/** Save a pasted API key as the tool's credential (provider: opencode only). */
export async function setToolApiKey(
  tool: AgentTool,
  apiKey: string,
  provider?: OpencodeProvider,
): Promise<void> {
  await expectOk(rpc.auth[':tool'].$put({
    param: { tool },
    json: { kind: 'api-key', apiKey, ...(provider ? { provider } : {}) },
  }))
}

/** Sign out — drop the tool's stored credential. */
export async function clearToolAuth(tool: AgentTool): Promise<void> {
  await expectOk(rpc.auth.clear.$post({ json: { service: tool } }))
}

/** Kick off a server-run vendor-CLI browser sign-in (claude/codex). The route
 *  only serves those two tools; runtime param validation guards the cast. */
export async function startToolLogin(tool: AgentTool): Promise<ToolLoginView> {
  return unwrap(rpc.auth[':tool'].login.start.$post({ param: { tool: tool as 'claude' | 'codex' } }))
}

/** Poll a sign-in flow's state. */
export async function getToolLogin(id: string): Promise<ToolLoginView> {
  return unwrap(rpc.auth.login[':id'].$get({ param: { id } }))
}

/** Forward a line to the login CLI's stdin (claude's paste-back code). */
export async function sendToolLoginInput(id: string, text: string): Promise<ToolLoginView> {
  return unwrap(rpc.auth.login[':id'].input.$post({ param: { id }, json: { text } }))
}

/** Abort a sign-in flow. */
export async function cancelToolLogin(id: string): Promise<void> {
  await expectOk(rpc.auth.login[':id'].cancel.$post({ param: { id } }))
}

/** Kick off a server-run install of the tool's CLI (offered on cliMissing).
 *  Claude/codex only, same as login. */
export async function startToolInstall(tool: AgentTool): Promise<ToolInstallView> {
  return unwrap(rpc.auth[':tool'].install.start.$post({ param: { tool: tool as 'claude' | 'codex' } }))
}

/** Poll an install flow's state. */
export async function getToolInstall(id: string): Promise<ToolInstallView> {
  return unwrap(rpc.auth.install[':id'].$get({ param: { id } }))
}

/** Abort an install flow. */
export async function cancelToolInstall(id: string): Promise<void> {
  await expectOk(rpc.auth.install[':id'].cancel.$post({ param: { id } }))
}

/** Saved keyboard-shortcut overrides, keyed by command id (empty when none). */
export async function getShortcutOverrides(): Promise<Record<string, Chord>> {
  const { overrides } = await unwrap(rpc.shortcuts.get.$get())
  return overrides
}

/** Persist a single command's rebind. */
export async function setShortcutOverride(id: ShortcutId, chord: Chord): Promise<void> {
  await expectOk(rpc.shortcuts.set.$post({ json: { id, chord } }))
}

/** Drop every override, restoring the factory defaults. */
export async function resetShortcuts(): Promise<void> {
  await expectOk(rpc.shortcuts.reset.$post())
}

/** Read the global user Dockerfile (~/.yaac/Dockerfile.user); '' when unset. */
export async function getUserDockerfile(): Promise<string> {
  const { content } = await unwrap(rpc.config['user-dockerfile'].$get())
  return content
}

/** Write (or clear, when empty) the global user Dockerfile. Validated
 *  server-side: a non-empty file must layer on `${BASE_IMAGE}`. */
export async function saveUserDockerfile(content: string): Promise<void> {
  await expectOk(rpc.config['user-dockerfile'].$put({ json: { content } }))
}
