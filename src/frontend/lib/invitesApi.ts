import { api } from './apiClient'

export interface SessionInvite {
  token: string
  sessionId: string
  mode: 'view' | 'drive'
  createdAt: number
  expiresAt: number
}

export async function createInvite(sessionId: string, mode: 'view' | 'drive'): Promise<SessionInvite> {
  return api.post<SessionInvite>(`/session/${encodeURIComponent(sessionId)}/invites`, { mode })
}

export async function listInvites(sessionId: string): Promise<SessionInvite[]> {
  return api.get<SessionInvite[]>(`/session/${encodeURIComponent(sessionId)}/invites`)
}

export async function revokeInvite(sessionId: string, token: string): Promise<void> {
  await api.post(`/session/${encodeURIComponent(sessionId)}/invites/revoke`, { token })
}

/** The share URL a teammate opens. Prefers the daemon's tailnet origin
 *  (teammate-reachable) over the owner's local origin. */
export function inviteUrl(token: string, shareOrigin?: string | null): string {
  return `${shareOrigin ?? window.location.origin}/join?code=${token}`
}

export interface AuthMe {
  owner: boolean
  guest: { sessionId: string; mode: 'view' | 'drive' } | null
  /** http://<tailnet-addr>:<port> when tailnet sharing is active. */
  shareOrigin: string | null
}

export async function getAuthMe(): Promise<AuthMe> {
  return api.get<AuthMe>('/auth/me')
}
