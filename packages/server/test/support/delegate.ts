import type { Delegate } from '@yaac/shared/types'

/**
 * A workspace's delegate of `userId`, as `callingWorkspace` builds one:
 * scoped to `projectId` when given, with a `bypass` ceiling unless named.
 */
export function workspaceDelegate(
  userId: string,
  workspaceId: string,
  over: Partial<Pick<Delegate, 'projectId' | 'ceiling' | 'login'>> & { sessionId?: string } = {},
): Delegate {
  const { sessionId, ...rest } = over
  return {
    kind: 'delegate',
    userId,
    login: null,
    via: { kind: 'workspace', id: workspaceId, label: `workspace ${workspaceId.slice(0, 8)}`, ...(sessionId !== undefined ? { sessionId } : {}) },
    ceiling: 'bypass',
    ...rest,
  }
}
