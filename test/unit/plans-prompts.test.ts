import { describe, it, expect } from 'vitest'
import { buildGrillPrompt, buildResumeGrillPrompt, buildBuildPrompt } from '@/lib/plans/prompts'

describe('buildGrillPrompt', () => {
  const prompt = buildGrillPrompt('offline sync', 'offline-sync.md', 'sid-123')

  it('embeds the topic, doc path, and session id', () => {
    expect(prompt).toContain('offline sync')
    expect(prompt).toContain('/plans/offline-sync.md')
    expect(prompt).toContain('sessions: [sid-123]')
  })

  it('seeds the frontmatter contract and the grill rules', () => {
    expect(prompt).toContain('phase: plan')
    expect(prompt).toContain('ONE question at a time')
    expect(prompt).toContain('recommended answer')
  })

  it('tells the agent to commit and push the wiki clone', () => {
    expect(prompt).toContain('git -C /plans')
    expect(prompt).toContain('push')
  })
})

describe('buildResumeGrillPrompt', () => {
  const prompt = buildResumeGrillPrompt('offline-sync.md', 'sid-456')

  it('targets the existing doc and links the new session', () => {
    expect(prompt).toContain('/plans/offline-sync.md')
    expect(prompt).toContain('sid-456')
    expect(prompt).toContain('frontmatter sessions list')
  })

  it('keeps the grill rules and the commit/push contract', () => {
    expect(prompt).toContain('ONE question at a time')
    expect(prompt).toContain('recommended answer')
    expect(prompt).toContain('git -C /plans')
  })
})

describe('buildBuildPrompt', () => {
  const prompt = buildBuildPrompt('offline-sync.md')

  it('points the agent at the promoted doc', () => {
    expect(prompt).toContain('/plans/offline-sync.md')
    expect(prompt).toContain('source of truth')
  })

  it('tells the agent to push plan corrections back to the wiki', () => {
    expect(prompt).toContain('git -C /plans')
  })
})
