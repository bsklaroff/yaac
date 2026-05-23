import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ensureOpencodeConfigJson } from '@/lib/session/opencode-config'

interface OpencodeConfig {
  permission?: Record<string, unknown>
  [key: string]: unknown
}

describe('ensureOpencodeConfigJson', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-config-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('creates opencode.json from scratch when none exists', async () => {
    await ensureOpencodeConfigJson(tmpDir)
    const raw = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf8')
    const parsed = JSON.parse(raw) as OpencodeConfig
    expect(parsed.permission?.websearch).toBe('allow')
  })

  it('preserves existing top-level keys and adds the permission', async () => {
    const existing: OpencodeConfig = {
      $schema: 'https://opencode.ai/config.json',
      model: 'anthropic/claude-sonnet-4-5',
    }
    await fs.writeFile(
      path.join(tmpDir, 'opencode.json'),
      JSON.stringify(existing),
    )

    await ensureOpencodeConfigJson(tmpDir)
    const raw = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf8')
    const parsed = JSON.parse(raw) as OpencodeConfig

    expect(parsed.$schema).toBe('https://opencode.ai/config.json')
    expect(parsed.model).toBe('anthropic/claude-sonnet-4-5')
    expect(parsed.permission?.websearch).toBe('allow')
  })

  it('preserves existing sibling permissions', async () => {
    const existing: OpencodeConfig = {
      permission: { edit: 'ask' },
    }
    await fs.writeFile(
      path.join(tmpDir, 'opencode.json'),
      JSON.stringify(existing),
    )

    await ensureOpencodeConfigJson(tmpDir)
    const raw = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf8')
    const parsed = JSON.parse(raw) as OpencodeConfig

    expect(parsed.permission?.edit).toBe('ask')
    expect(parsed.permission?.websearch).toBe('allow')
  })

  it('does not rewrite when websearch is already allowed', async () => {
    await ensureOpencodeConfigJson(tmpDir)
    const beforeStat = await fs.stat(path.join(tmpDir, 'opencode.json'))
    await new Promise((r) => setTimeout(r, 50))
    await ensureOpencodeConfigJson(tmpDir)
    const afterStat = await fs.stat(path.join(tmpDir, 'opencode.json'))
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs)
  })

  it('overwrites a non-allow websearch permission', async () => {
    const existing: OpencodeConfig = {
      permission: { websearch: 'ask' },
    }
    await fs.writeFile(
      path.join(tmpDir, 'opencode.json'),
      JSON.stringify(existing),
    )

    await ensureOpencodeConfigJson(tmpDir)
    const raw = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf8')
    const parsed = JSON.parse(raw) as OpencodeConfig

    expect(parsed.permission?.websearch).toBe('allow')
  })

  it('handles invalid existing opencode.json gracefully', async () => {
    await fs.writeFile(path.join(tmpDir, 'opencode.json'), 'not valid json')
    await ensureOpencodeConfigJson(tmpDir)

    const raw = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf8')
    const parsed = JSON.parse(raw) as OpencodeConfig
    expect(parsed.permission?.websearch).toBe('allow')
  })

  it('handles a non-object existing opencode.json gracefully', async () => {
    await fs.writeFile(path.join(tmpDir, 'opencode.json'), '[]')
    await ensureOpencodeConfigJson(tmpDir)

    const raw = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf8')
    const parsed = JSON.parse(raw) as OpencodeConfig
    expect(parsed.permission?.websearch).toBe('allow')
  })
})
