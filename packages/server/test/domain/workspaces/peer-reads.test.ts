import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { recordTestProject } from '@yaac/test-utils/project-fixture'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { git } from '@yaac/test-utils/git'
import { buildPeerReader } from '@yaac/test-utils/peer-reader'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { closeDb } from '#db/client'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { recordConversations } from '#db/conversation-store'
import { setPeerReaderEntry } from '#domain/git/peer-bundle'
import { workspaceBundle, workspaceHistory, workspaceHistoryContent } from '#domain/workspaces'
import { agentHistoryDir, workspaceDir } from '@yaac/shared/project-paths'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  installFakeWorkspaceDriver()
  await recordTestProject(PROJ)
  // A stopped workspace: a row, a checkout and a conversation, no unit.
  await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'peer-ws', repos: [{ repoId: PROJ, path: '' }] })
  await recordConversations(PROJ, 'peer-ws', [{ tool: 'claude', conversationId: 'claude-conv', firstPrompt: 'write it' }])
  const conversations = path.join(agentHistoryDir(PROJ, 'peer-ws', 'claude'), '-workspace')
  await fs.mkdir(path.join(conversations, 'claude-conv', 'subagents'), { recursive: true })
  await fs.writeFile(path.join(conversations, 'claude-conv.jsonl'), '{"main":1}')
  await fs.writeFile(path.join(conversations, 'claude-conv', 'subagents', 'agent-a.jsonl'), '{"sub":1}\n')
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

const text = async (body: ReadableStream<Uint8Array>): Promise<string> => await new Response(body).text()

// What a caller sees of these through yaac-mama is in
// test/api/mama/commands.test.ts.
describe('workspaceHistory', () => {
  it("lists a workspace's conversations with their files, or the one a prefix names", async () => {
    const history = await workspaceHistory('peer')
    expect(history).toMatchObject({
      workspaceId: 'peer-ws',
      maxFileBytes: 256 * 1024 * 1024,
      conversations: [{
        conversationId: 'claude-conv', tool: 'claude', active: true, firstPrompt: 'write it',
        files: [{ name: 'claude-conv.jsonl', size: 10 }, { name: 'claude-conv/subagents/agent-a.jsonl', size: 10 }],
      }],
    })
    expect((await workspaceHistory('peer-ws', 'claude')).conversations).toHaveLength(1)
    await expect(workspaceHistory('peer-ws', 'nope')).rejects.toThrow("no conversation 'nope' in peer-ws")
  })
})

describe('workspaceHistoryContent', () => {
  it("hands out a conversation's transcripts, main first, or one file as is", async () => {
    const transcripts = await workspaceHistoryContent('peer', 'claude-conv')
    expect(transcripts).toMatchObject({ workspaceId: 'peer-ws', contentType: 'application/x-ndjson' })
    expect(await text(transcripts.body)).toBe('{"main":1}\n{"sub":1}\n')
    expect(await text((await workspaceHistoryContent('peer-ws', 'claude-conv', 'claude-conv.jsonl')).body)).toBe('{"main":1}')
    await expect(workspaceHistoryContent('peer-ws', 'claude-conv', '../secret')).rejects.toThrow("claude-conv has no file '../secret'")
  })
})

describe('workspaceBundle', () => {
  beforeAll(async () => { setPeerReaderEntry(await buildPeerReader()) })

  it("bundles a workspace's branches in its checkout of a repo, and refuses one it has none of", async () => {
    const checkout = workspaceDir(PROJ, 'peer-ws')
    await fs.mkdir(checkout, { recursive: true })
    await git(checkout, ['init', '-q', '-b', 'agent/peer'])
    await git(checkout, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '--allow-empty', '-qm', 'work'])
    const tip = (await git(checkout, ['rev-parse', 'HEAD'])).trim()
    const { workspaceId, bundle } = await workspaceBundle('peer', PROJ)
    expect(workspaceId).toBe('peer-ws')
    expect(bundle.toString('latin1')).toContain(`${tip} refs/heads/agent/peer\n`)
    await expect(workspaceBundle('peer-ws', 'another-repo')).rejects.toThrow('peer-ws has no checkout of this repo')
  })
})
