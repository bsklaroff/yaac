import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import {
  createInvite,
  getValidInvite,
  listInvites,
  revokeInvite,
  DEFAULT_INVITE_TTL_MS,
} from '@/daemon/invites'
import {
  mintGuestSession,
  resolveGuestScope,
  _clearGuestSessionsForTests,
  isPublicPath,
} from '@/daemon/web-auth'

describe('session invites', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _clearGuestSessionsForTests()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('mints scoped invites with a default 7-day expiry', async () => {
    const invite = await createInvite('sid-1', 'view', { now: 1000 })
    expect(invite.sessionId).toBe('sid-1')
    expect(invite.mode).toBe('view')
    expect(invite.token).toHaveLength(64)
    expect(invite.expiresAt).toBe(1000 + DEFAULT_INVITE_TTL_MS)
  })

  it('lists per session and prunes expired entries', async () => {
    await createInvite('sid-1', 'view', { now: 0, ttlMs: 100 })
    const live = await createInvite('sid-1', 'drive', { now: 0, ttlMs: 1_000_000 })
    await createInvite('sid-2', 'view', { now: 0, ttlMs: 1_000_000 })
    const got = await listInvites('sid-1', 500)
    expect(got).toEqual([live])
  })

  it('getValidInvite honors expiry and revocation', async () => {
    const invite = await createInvite('sid-1', 'drive', { now: 0, ttlMs: 100 })
    expect(await getValidInvite(invite.token, 50)).toEqual(invite)
    expect(await getValidInvite(invite.token, 150)).toBeNull()
    const fresh = await createInvite('sid-1', 'view')
    await revokeInvite(fresh.token)
    expect(await getValidInvite(fresh.token)).toBeNull()
  })

  it('guest sessions resolve to live scope and die with the invite', async () => {
    const invite = await createInvite('sid-1', 'drive')
    const gid = mintGuestSession(invite.token)
    expect(await resolveGuestScope(gid)).toEqual({ sessionId: 'sid-1', mode: 'drive' })
    await revokeInvite(invite.token)
    expect(await resolveGuestScope(gid)).toBeNull()
    // and unknown guest ids are null
    expect(await resolveGuestScope('nope')).toBeNull()
  })

  it('/join is reachable without credentials', () => {
    expect(isPublicPath('/join')).toBe(true)
    expect(isPublicPath('/session/list')).toBe(false)
  })
})
