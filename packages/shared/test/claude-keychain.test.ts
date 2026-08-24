import { describe, it, expect, afterEach, vi } from 'vitest'
import type * as childProcessModule from 'node:child_process'

const execFileSyncMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => string>())

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcessModule>()
  return { ...actual, execFileSync: execFileSyncMock }
})

import {
  claudeKeychainService,
  deleteScopedClaudeKeychainItem,
  readClaudeKeychainPayload,
  readScopedClaudeKeychainPayload,
} from '#tool-auth-interactive'

const realPlatform = process.platform
function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

describe('claude keychain access', () => {
  afterEach(() => {
    setPlatform(realPlatform)
    execFileSyncMock.mockReset()
  })

  describe('readClaudeKeychainPayload', () => {
    it('reads the default host service and trims the payload', () => {
      setPlatform('darwin')
      execFileSyncMock.mockReturnValue('{"claudeAiOauth":{}}\n')
      expect(readClaudeKeychainPayload()).toBe('{"claudeAiOauth":{}}')
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        expect.anything(),
      )
    })

    it('reads a config-dir-scoped service when one is given', () => {
      setPlatform('darwin')
      execFileSyncMock.mockReturnValue('payload')
      const service = claudeKeychainService('/tmp/scratch')
      expect(readClaudeKeychainPayload(service)).toBe('payload')
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'security',
        ['find-generic-password', '-s', service, '-w'],
        expect.anything(),
      )
    })

    it('is null on non-darwin without shelling out', () => {
      setPlatform('linux')
      expect(readClaudeKeychainPayload()).toBeNull()
      expect(execFileSyncMock).not.toHaveBeenCalled()
    })

    it('is null when the item is missing (security exits nonzero)', () => {
      setPlatform('darwin')
      execFileSyncMock.mockImplementation(() => { throw new Error('not found') })
      expect(readClaudeKeychainPayload()).toBeNull()
    })
  })

  describe('readScopedClaudeKeychainPayload', () => {
    it('reads a config-dir-scoped item', () => {
      setPlatform('darwin')
      execFileSyncMock.mockReturnValue('{"claudeAiOauth":{}}\n')
      const service = claudeKeychainService('/data/projects/demo/claude')
      expect(readScopedClaudeKeychainPayload(service)).toBe('{"claudeAiOauth":{}}')
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'security',
        ['find-generic-password', '-s', service, '-w'],
        expect.anything(),
      )
    })

    it('refuses the un-suffixed host service — a project sweep never reads the user\'s own install', () => {
      setPlatform('darwin')
      expect(readScopedClaudeKeychainPayload('Claude Code-credentials')).toBeNull()
      expect(execFileSyncMock).not.toHaveBeenCalled()
    })

    it('reads null on non-darwin and when no item exists', () => {
      setPlatform('linux')
      expect(readScopedClaudeKeychainPayload(claudeKeychainService('/tmp/scratch'))).toBeNull()
      expect(execFileSyncMock).not.toHaveBeenCalled()

      setPlatform('darwin')
      execFileSyncMock.mockImplementation(() => { throw new Error('not found') })
      expect(readScopedClaudeKeychainPayload(claudeKeychainService('/tmp/scratch'))).toBeNull()
    })
  })

  describe('deleteScopedClaudeKeychainItem', () => {
    it('deletes a scoped scratch item', () => {
      setPlatform('darwin')
      const service = claudeKeychainService('/tmp/scratch')
      deleteScopedClaudeKeychainItem(service)
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'security',
        ['delete-generic-password', '-s', service],
        expect.anything(),
      )
    })

    it('refuses the un-suffixed host service — never logs the host out', () => {
      setPlatform('darwin')
      deleteScopedClaudeKeychainItem('Claude Code-credentials')
      expect(execFileSyncMock).not.toHaveBeenCalled()
    })

    it('is a no-op on non-darwin', () => {
      setPlatform('linux')
      deleteScopedClaudeKeychainItem(claudeKeychainService('/tmp/scratch'))
      expect(execFileSyncMock).not.toHaveBeenCalled()
    })

    it('swallows a failed delete (item never created)', () => {
      setPlatform('darwin')
      execFileSyncMock.mockImplementation(() => { throw new Error('not found') })
      expect(() => deleteScopedClaudeKeychainItem(claudeKeychainService('/tmp/scratch'))).not.toThrow()
    })
  })
})
