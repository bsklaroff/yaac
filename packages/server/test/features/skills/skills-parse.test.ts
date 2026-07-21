import { describe, it, expect } from 'vitest'
import {
  parseSkillMd,
  fmString,
  fmBool,
  fmList,
  flattenFrontmatter,
} from '#features/skills/parse'

describe('parseSkillMd', () => {
  it('splits frontmatter from body', () => {
    const { frontmatter, body } = parseSkillMd(
      '---\nname: deploy\ndescription: Ship it\n---\n# Deploy\n\nRun the steps.\n',
    )
    expect(frontmatter).toEqual({ name: 'deploy', description: 'Ship it' })
    expect(body).toBe('# Deploy\n\nRun the steps.\n')
  })

  it('keeps colons and quotes inside a scalar value', () => {
    const { frontmatter } = parseSkillMd(
      '---\ndescription: "Use when: the user asks, e.g. /foo"\n---\nbody',
    )
    expect(frontmatter.description).toBe('Use when: the user asks, e.g. /foo')
  })

  it('parses inline and block lists', () => {
    const inline = parseSkillMd('---\nallowed-tools: [Read, Grep, Bash]\n---\n').frontmatter
    expect(inline['allowed-tools']).toEqual(['Read', 'Grep', 'Bash'])
    const block = parseSkillMd('---\narguments:\n  - issue\n  - branch\n---\n').frontmatter
    expect(block.arguments).toEqual(['issue', 'branch'])
  })

  it('reads an empty `description:` as no usable description', () => {
    const { frontmatter } = parseSkillMd('---\nname: x\ndescription:\n---\nb')
    expect(frontmatter.description).toBeNull()
    expect(fmString(frontmatter, 'description')).toBeUndefined()
  })

  it('parses a nested mapping (metadata) into an object', () => {
    const { frontmatter } = parseSkillMd('---\nname: x\nmetadata:\n  version: "1"\n  author: me\n---\n')
    expect(frontmatter.metadata).toEqual({ version: '1', author: 'me' })
  })

  it('returns the whole input as body when there is no frontmatter', () => {
    const raw = '# Just markdown\nno fence here'
    expect(parseSkillMd(raw)).toEqual({ frontmatter: {}, body: raw })
  })

  it('never throws on malformed frontmatter — degrades to empty metadata + body', () => {
    const { frontmatter, body } = parseSkillMd('---\nname: [unterminated\ndescription: x\n---\nbody')
    expect(frontmatter).toEqual({})
    expect(body).toBe('body')
  })

  it('handles CRLF newlines and a leading BOM', () => {
    const { frontmatter, body } = parseSkillMd('﻿---\r\nname: win\r\n---\r\nbody\r\n')
    expect(frontmatter.name).toBe('win')
    expect(body).toBe('body\r\n')
  })
})

describe('fmString / fmBool / fmList', () => {
  const fm = parseSkillMd(
    '---\nname: x\nuser-invocable: false\ndisable-model-invocation: true\nallowed-tools: Read Bash\n---\n',
  ).frontmatter

  it('reads scalars, booleans, and space/comma lists', () => {
    expect(fmString(fm, 'name')).toBe('x')
    expect(fmString(fm, 'missing')).toBeUndefined()
    expect(fmBool(fm, 'user-invocable')).toBe(false)
    expect(fmBool(fm, 'disable-model-invocation')).toBe(true)
    expect(fmBool(fm, 'name')).toBeUndefined() // non-boolean scalar
    expect(fmList(fm, 'allowed-tools')).toEqual(['Read', 'Bash'])
    expect(fmList(fm, 'missing')).toBeUndefined()
  })
})

describe('flattenFrontmatter', () => {
  it('joins list values for display', () => {
    const fm = parseSkillMd('---\nname: x\nallowed-tools: [Read, Bash]\n---\n').frontmatter
    expect(flattenFrontmatter(fm)).toEqual({ name: 'x', 'allowed-tools': 'Read, Bash' })
  })

  it('json-encodes nested mappings like metadata', () => {
    const fm = parseSkillMd('---\nname: x\nmetadata:\n  version: "1"\n  author: me\n---\n').frontmatter
    expect(flattenFrontmatter(fm)).toMatchObject({ name: 'x', metadata: '{"version":"1","author":"me"}' })
  })
})
