import { api } from './apiClient'
import type { Chord, ShortcutId } from './shortcuts'
import type { AgentTool, AuthListResult } from '@/shared/types'

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
