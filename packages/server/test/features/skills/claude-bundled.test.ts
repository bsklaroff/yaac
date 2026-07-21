import { describe, it, expect } from 'vitest'
import { parseBundledSkills } from '#features/skills/claude-bundled'

// A trimmed commands-reference table: two built-in commands (no marker), a
// [Skill] row with escaped-pipe args + a markdown link + a trailing version
// note, a [Workflow] row (deep-research), and a [Skill] row whose min-version
// comment precedes the marker.
const SAMPLE = [
  '| Command | Purpose |',
  '| --- | --- |',
  '| `/help` | Show help for commands. |',
  '| `/code-review [low\\|high] [--fix]` | **[Skill](/en/skills#bundled-skills).** Review the current diff for'
    + ' [correctness](/en/code-review) bugs. Pass `--fix` to apply. {/* min-version: 2.1.154 */}Older notes here. |',
  '| `/deep-research <question>` | **[Workflow](/en/workflows#bundled-workflows).** Fan out web searches and'
    + ' synthesize a cited report |',
  '| `/simplify [target]` | {/* min-version: 2.1.154 */}**[Skill](/en/skills#bundled-skills).** Review the'
    + ' changed code and apply fixes |',
  '| `/review [PR]` | Run a fast single-pass review of a GitHub PR |',
].join('\n')

describe('parseBundledSkills', () => {
  it('extracts [Skill] and [Workflow] rows, excluding plain built-in commands', () => {
    const skills = parseBundledSkills(SAMPLE)
    expect(skills.map((s) => s.name)).toEqual(['code-review', 'deep-research', 'simplify'])
  })

  it('cleans the description: drops the marker, version comment, and link syntax', () => {
    const cr = parseBundledSkills(SAMPLE).find((s) => s.name === 'code-review')
    expect(cr?.description).toContain('Review the current diff for correctness bugs')
    expect(cr?.description).toContain('Pass `--fix` to apply')
    expect(cr?.description).not.toContain('[Skill]')
    expect(cr?.description).not.toContain('](/en/') // markdown links unwrapped
    expect(cr?.description).not.toContain('{/*') // version comment stripped
  })

  it('handles a Workflow row and a marker preceded by a version comment', () => {
    const skills = parseBundledSkills(SAMPLE)
    expect(skills.find((s) => s.name === 'deep-research')?.description)
      .toBe('Fan out web searches and synthesize a cited report')
    expect(skills.find((s) => s.name === 'simplify')?.description)
      .toBe('Review the changed code and apply fixes')
  })

  it('is empty-safe on markup with no bundled rows', () => {
    expect(parseBundledSkills('| `/help` | Show help. |\nnot a table')).toEqual([])
    expect(parseBundledSkills('')).toEqual([])
  })
})
