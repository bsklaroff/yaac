import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react'
import type { ProjectSkills, ProjectSummary, SkillDetail, SkillSummary } from '@yaac/shared/types'
import { SkillsSettings } from '#components/settings/Skills'
import { useUiStore } from '#lib/store'
import {
  mockFetch, renderWithClient, serverSnapshot, testQueryClient, TEST_USER_ID, type FetchMock,
} from './harness'

// eslint-disable-next-line @typescript-eslint/unbound-method -- only ever restored onto window
const realMatchMedia = window.matchMedia

/** Make `useIsMobile` report a phone-sized viewport. jsdom's own matchMedia
 *  always reports no match, i.e. desktop. */
function setMobileViewport(): void {
  window.matchMedia = ((q: string) => ({
    matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
}

const project = (name: string): ProjectSummary =>
  ({ id: `id-${name}`, name, remoteUrl: `https://github.com/o/${name}.git`, addedAt: '', owner: TEST_USER_ID, workspaceCount: 0, stoppedCount: 0, deaths: 0, deathsSeenBy: {}, createDefaults: {}, gitCredential: null, hosted: false, guardDefaultBranch: true, scratchDirs: { dirs: [], ignoredTracked: [] } })

const skill = (over: Partial<SkillSummary> & Pick<SkillSummary, 'id' | 'name' | 'source'>): SkillSummary =>
  ({ description: '', agents: [], overriddenFor: [], userInvocable: true, modelInvocable: true, ...over })

/** A skill or two per section, in the server's order. Claude prefers the
 *  personal /push and OpenCode the repo one; Codex loads both /shared. */
const ALPHA: ProjectSkills = {
  skills: [
    skill({ id: 'repo/.agents/skills:shared', name: 'shared', source: 'repo', sourceLabel: '.agents/skills', agents: ['codex', 'opencode', 'pi'] }),
    skill({ id: 'repo/.claude/skills:deploy', name: 'deploy', description: 'ship it', source: 'repo', sourceLabel: '.claude/skills', agents: ['claude', 'opencode'] }),
    skill({ id: 'repo/.claude/skills:push', name: 'push', source: 'repo', sourceLabel: '.claude/skills', agents: ['claude', 'opencode'], overriddenFor: ['claude'] }),
    skill({ id: 'claude/skills:push', name: 'push', source: 'personal', home: 'claude', agents: ['claude', 'opencode'], overriddenFor: ['opencode'] }),
    skill({ id: 'codex/skills:lint', name: 'lint', source: 'personal', home: 'codex', agents: ['codex'] }),
    skill({ id: 'codex/skills:shared', name: 'shared', source: 'personal', home: 'codex', agents: ['codex'] }),
    skill({ id: 'yaac:yaac-welcome', name: 'yaac-welcome', source: 'yaac', agents: ['claude', 'codex', 'opencode', 'pi'] }),
  ],
}

const BODY: SkillDetail = {
  id: 'repo/.claude/skills:deploy', name: 'deploy', source: 'repo', frontmatter: {}, body: 'Run the deploy script.',
}

const LIST = 'GET /api/project/id-alpha/skills'
const DETAIL = 'GET /api/project/id-alpha/skills/body'

let server: FetchMock
beforeEach(() => {
  useUiStore.setState({ activeProjectId: 'id-alpha', settingsProjectId: null })
  server = mockFetch({
    [LIST]: ALPHA,
    [DETAIL]: BODY,
    'GET /api/project/id-alpha/branches': { branches: ['main', 'feature'], defaultBranch: 'main' },
    'GET /api/project/id-beta/skills': { skills: [skill({ id: 'yaac:beta-only', name: 'beta-only', source: 'yaac', agents: ['pi'] })] },
    'GET /api/project/id-beta/branches': { branches: ['main'], defaultBranch: 'main' },
  })
})

afterEach(() => {
  cleanup()
  window.matchMedia = realMatchMedia
})

function renderSkills(): void {
  renderWithClient(<SkillsSettings />, testQueryClient(undefined, serverSnapshot({ projects: [project('alpha'), project('beta')] })))
}

/** The list's rows' names, top to bottom, with the section headers (name,
 *  repo dir and agent pills) between. */
function listed(): string[] {
  const list = screen.getByRole('list')
  return within(list).getAllByRole('listitem').flatMap((li) => {
    const header = li.querySelector('div')
    const words = [...header?.querySelectorAll('span') ?? []].filter((e) => e.children.length === 0).map((e) => e.textContent)
    return [...(header ? [`# ${words.join(' ')}`] : []), li.querySelector('button span')?.textContent ?? '']
  })
}

describe('SkillsSettings', () => {
  it('heads the list with the viewed project and lists every agent\'s skills by section', async () => {
    renderSkills()
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Project' }).value).toBe('id-alpha')
    await screen.findAllByText('/deploy')
    // A section per dir, headed by the agents that read it; personal skills
    // are filed under the agent whose home holds them.
    expect(listed()).toEqual([
      '# Repo .agents/skills Codex OpenCode Pi', '/shared',
      '# Repo .claude/skills Claude OpenCode', '/deploy', '/push',
      '# Claude Claude OpenCode', '/push',
      '# Codex Codex', '/lint', '/shared',
      '# yaac built-in All agents', '/yaac-welcome',
    ])
    // Repo skills come from origin's default branch, once the branch list
    // names it, until another is picked.
    await waitFor(() => expect(Object.fromEntries(server.called(LIST).at(-1)!.query)).toEqual({ branch: 'main' }))
    // Each copy of a clashing name says which agents load the other one.
    const rows = within(screen.getByRole('list')).getAllByRole('button')
    expect(within(rows[2]).getByText('Claude uses the /push under Claude instead.')).toBeTruthy()
    expect(within(rows[3]).getByText('OpenCode uses the /push under Repo .claude/skills instead.')).toBeTruthy()
    // Still loaded by some agent, so neither is dimmed.
    expect(within(rows[2]).getByText('/push').className).toContain('text-text-dim')
    // Codex loads both /shared copies rather than picking one.
    expect(within(rows[0]).getByText('Codex also loads the /shared under Codex, so $shared is ambiguous there.')).toBeTruthy()
  })

  it('narrows to the sections one agent reads, dimming what that agent overrides', async () => {
    renderSkills()
    await screen.findAllByText('/deploy')
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
    expect(listed()).toEqual([
      '# Repo .agents/skills Codex OpenCode Pi', '/shared', '# Codex Codex', '/lint', '/shared',
      '# yaac built-in All agents', '/yaac-welcome',
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Claude' }))
    expect(listed()).toEqual([
      '# Repo .claude/skills Claude OpenCode', '/deploy', '/push', '# Claude Claude OpenCode', '/push',
      '# yaac built-in All agents', '/yaac-welcome',
    ])
    const [repoPush, personalPush] = screen.getAllByText('/push')
    expect(repoPush.className).toContain('text-text-faint')
    expect(personalPush.className).toContain('text-text-dim')
  })

  it('shows the picked skill\'s SKILL.md from the same branch, and follows a project switch', async () => {
    renderSkills()
    // Desktop auto-selects the first row; a picked one shows in its place.
    await waitFor(() => expect(server.called(DETAIL).length).toBeGreaterThan(0))
    fireEvent.click(within(screen.getByRole('list')).getByText('/deploy'))
    await screen.findByText('Run the deploy script.')
    await waitFor(() => expect(Object.fromEntries(server.called(DETAIL).at(-1)!.query))
      .toEqual({ id: 'repo/.claude/skills:deploy', branch: 'main' }))

    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: 'id-beta' } })
    await waitFor(() => expect(listed()).toEqual(['# yaac built-in Pi', '/beta-only']))
    // The pick is the one Project Config shows too.
    expect(useUiStore.getState().settingsProjectId).toBe('id-beta')
  })

  it('on a phone, opens on the list and drills into a skill and back', async () => {
    setMobileViewport()
    renderSkills()
    await screen.findByText('/deploy')
    await act(async () => { await Promise.resolve() })
    // The body is fetched only when the detail pane opens.
    expect(server.called(DETAIL)).toEqual([])

    fireEvent.click(screen.getByText('/deploy'))
    await waitFor(() => expect(screen.getByText('Run the deploy script.')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Back to skills' }))
    await waitFor(() => expect(screen.queryByText('Run the deploy script.')).toBeNull())
    expect(screen.getByText('/lint')).toBeTruthy()
  })
})
