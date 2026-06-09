import { api } from './apiClient'
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
