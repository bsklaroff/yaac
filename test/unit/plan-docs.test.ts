import { describe, it, expect } from 'vitest'
import {
  isPlanPhase,
  splitFrontmatter,
  parseSessionsList,
  firstHeading,
  titleFromFileName,
  parsePlanDoc,
  updateFrontmatter,
} from '@/shared/plan-docs'

describe('isPlanPhase', () => {
  it('accepts the three phases and rejects everything else', () => {
    expect(isPlanPhase('plan')).toBe(true)
    expect(isPlanPhase('build')).toBe(true)
    expect(isPlanPhase('review')).toBe(true)
    expect(isPlanPhase('design')).toBe(false)
    expect(isPlanPhase(undefined)).toBe(false)
    expect(isPlanPhase(42)).toBe(false)
  })
})

describe('splitFrontmatter', () => {
  it('splits the fence block from the body', () => {
    const block = splitFrontmatter('---\nphase: plan\nsessions: [a]\n---\n# Title\nbody\n')
    expect(block?.lines).toEqual(['phase: plan', 'sessions: [a]'])
    expect(block?.body).toBe('# Title\nbody\n')
  })

  it('handles CRLF and a UTF-8 BOM', () => {
    const block = splitFrontmatter('﻿---\r\nphase: build\r\n---\r\nbody')
    expect(block?.lines).toEqual(['phase: build'])
    expect(block?.body).toBe('body')
  })

  it('returns null without a leading fence or with an unclosed one', () => {
    expect(splitFrontmatter('# Just markdown')).toBeNull()
    expect(splitFrontmatter('---\nphase: plan\nno closing fence')).toBeNull()
  })

  it('treats a fence-only document as empty frontmatter', () => {
    const block = splitFrontmatter('---\n---\nbody')
    expect(block?.lines).toEqual([])
    expect(block?.body).toBe('body')
  })
})

describe('parseSessionsList', () => {
  it('parses inline lists with quotes and spaces', () => {
    expect(parseSessionsList(['sessions: [a1, "b2", \'c3\']'])).toEqual(['a1', 'b2', 'c3'])
  })

  it('returns [] when missing or empty', () => {
    expect(parseSessionsList(['phase: plan'])).toEqual([])
    expect(parseSessionsList(['sessions: []'])).toEqual([])
  })
})

describe('firstHeading', () => {
  it('finds the first h1 anywhere in the body', () => {
    expect(firstHeading('intro\n# The Plan\nmore')).toBe('The Plan')
    expect(firstHeading('no headings here')).toBeUndefined()
  })
})

describe('titleFromFileName', () => {
  it('strips .md and prettifies separators', () => {
    expect(titleFromFileName('offline-sync.md')).toBe('offline sync')
    expect(titleFromFileName('a_b-c.md')).toBe('a b c')
  })
})

describe('parsePlanDoc', () => {
  it('reads phase, sessions, and title from frontmatter', () => {
    const doc = parsePlanDoc('---\nphase: build\nsessions: [s1, s2]\ntitle: My Plan\n---\nbody', 'x.md')
    expect(doc.phase).toBe('build')
    expect(doc.sessions).toEqual(['s1', 's2'])
    expect(doc.title).toBe('My Plan')
    expect(doc.body).toBe('body')
  })

  it('falls back: phase→plan, title→first heading→filename', () => {
    expect(parsePlanDoc('# Heading\ntext', 'x.md')).toMatchObject({
      phase: 'plan',
      sessions: [],
      title: 'Heading',
    })
    expect(parsePlanDoc('plain text', 'offline-sync.md').title).toBe('offline sync')
  })

  it('ignores an invalid phase value', () => {
    expect(parsePlanDoc('---\nphase: design\n---\nx', 'x.md').phase).toBe('plan')
  })
})

describe('updateFrontmatter', () => {
  it('flips the phase in place, preserving other lines', () => {
    const out = updateFrontmatter('---\nphase: plan\nowner: ben\n---\nbody', { phase: 'build' })
    expect(out).toBe('---\nphase: build\nowner: ben\n---\nbody')
  })

  it('appends a session id without duplicating existing ones', () => {
    const md = '---\nphase: plan\nsessions: [a]\n---\nbody'
    expect(updateFrontmatter(md, { appendSession: 'b' }))
      .toBe('---\nphase: plan\nsessions: [a, b]\n---\nbody')
    expect(updateFrontmatter(md, { appendSession: 'a' })).toBe(md)
  })

  it('creates the frontmatter block when absent', () => {
    const out = updateFrontmatter('# Doc\nbody', { phase: 'build', appendSession: 's1' })
    expect(out).toBe('---\nphase: build\nsessions: [s1]\n---\n# Doc\nbody')
  })
})
