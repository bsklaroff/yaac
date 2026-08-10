import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { refreshClaudeBundledSkills } from '#domain/skills'
// The in-memory cache the refresh writes: read to assert, reset between cases.
// Not under test — parsing is exercised through the refresh itself.
import { getClaudeBundledSkills, setClaudeBundledSkills } from '#domain/skills/claude-bundled'

// A trimmed commands-reference table exercising every row shape the parser has
// to survive: two plain built-in commands (no marker), a [Skill] row with
// escaped-pipe args + a markdown link + a trailing version note, a [Workflow]
// row (deep-research), a [Skill] row whose min-version comment precedes the
// marker, a marked row that repeats an earlier command, a marked row whose
// description is nothing but the marker, a marked row whose command cell is not
// a `/name` invocation, and a stray pipe line that is not a table row at all.
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
  '| `/code-review` | **[Skill](/en/skills#bundled-skills).** A duplicate row for the same command |',
  '| `/blank` | **[Skill](/en/skills#bundled-skills).** |',
  '| ~~`/retired`~~ | **[Skill](/en/skills#bundled-skills).** Removed in 3.0 |',
  '| continued cell text',
  '| `/review [PR]` | Run a fast single-pass review of a GitHub PR |',
].join('\n')

const okResponse = (body: string): Response => new Response(body, { status: 200 })

beforeEach(() => {
  setClaudeBundledSkills([])
})

afterEach(() => {
  vi.restoreAllMocks()
  setClaudeBundledSkills([])
})

describe('refreshClaudeBundledSkills', () => {
  it('caches every bundled row from the fetched commands reference, cleaned', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(SAMPLE))

    await refreshClaudeBundledSkills()

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://code.claude.com/docs/en/commands.md')
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)

    const skills = getClaudeBundledSkills()
    // Plain built-ins, the repeat of /code-review, the marker-only row, and the
    // struck-through command are all excluded; the rest keep source order.
    expect(skills.map((s) => s.name)).toEqual(['code-review', 'deep-research', 'simplify'])

    const cr = skills.find((s) => s.name === 'code-review')
    expect(cr?.description).toContain('Review the current diff for correctness bugs')
    expect(cr?.description).toContain('Pass `--fix` to apply') // escaped pipes stayed in the cell
    expect(cr?.description).not.toContain('[Skill]') // marker dropped
    expect(cr?.description).not.toContain('](/en/') // markdown links unwrapped
    expect(cr?.description).not.toContain('{/*') // version comment stripped
    expect(skills.find((s) => s.name === 'deep-research')?.description)
      .toBe('Fan out web searches and synthesize a cited report')
    expect(skills.find((s) => s.name === 'simplify')?.description)
      .toBe('Review the changed code and apply fixes')
  })

  it('leaves the cache untouched on a non-ok, unreachable, or bundle-free fetch', async () => {
    const previous = [{ name: 'verify', description: 'Confirm a change works.' }]
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    setClaudeBundledSkills(previous)
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }))
    await refreshClaudeBundledSkills()
    expect(getClaudeBundledSkills()).toEqual(previous)

    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'))
    await refreshClaudeBundledSkills()
    expect(getClaudeBundledSkills()).toEqual(previous)

    // A page that fetches fine but has no bundled rows (a docs restructure)
    // must not blank out a good cache.
    fetchMock.mockResolvedValue(okResponse('| `/help` | Show help. |\nnot a table'))
    await refreshClaudeBundledSkills()
    expect(getClaudeBundledSkills()).toEqual(previous)
  })
})
