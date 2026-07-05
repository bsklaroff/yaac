import { describe, it, expect, afterEach, vi } from 'vitest'
import type * as childProcessModule from 'node:child_process'

const execFileSyncMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => string>())

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcessModule>()
  return { ...actual, execFileSync: execFileSyncMock }
})

import {
  claudeKeychainService,
  deleteScratchClaudeKeychainItem,
  readClaudeKeychainPayload,
} from '@/shared/tool-auth-interactive'

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

  describe('deleteScratchClaudeKeychainItem', () => {
    it('deletes a scoped scratch item', () => {
      setPlatform('darwin')
      const service = claudeKeychainService('/tmp/scratch')
      deleteScratchClaudeKeychainItem(service)
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'security',
        ['delete-generic-password', '-s', service],
        expect.anything(),
      )
    })

    it('refuses the un-suffixed host service — never logs the host out', () => {
      setPlatform('darwin')
      deleteScratchClaudeKeychainItem('Claude Code-credentials')
      expect(execFileSyncMock).not.toHaveBeenCalled()
    })

    it('is a no-op on non-darwin', () => {
      setPlatform('linux')
      deleteScratchClaudeKeychainItem(claudeKeychainService('/tmp/scratch'))
      expect(execFileSyncMock).not.toHaveBeenCalled()
    })

    it('swallows a failed delete (item never created)', () => {
      setPlatform('darwin')
      execFileSyncMock.mockImplementation(() => { throw new Error('not found') })
      expect(() => deleteScratchClaudeKeychainItem(claudeKeychainService('/tmp/scratch'))).not.toThrow()
    })
  })
})
