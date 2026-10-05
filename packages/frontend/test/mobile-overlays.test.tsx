// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import type { JSX } from 'react'
import type { ImageBuildEntry, ProjectSkills, SkillDetail, StoppedWorkspaceEntry } from '@yaac/shared/types'

const provision = vi.hoisted(() => vi.fn())

vi.mock('#lib/createWorkspace', () => ({ restartWorkspace: vi.fn() }))
vi.mock('#lib/useProvisionWorkspace', () => ({ useProvisionWorkspace: () => provision }))

import { ImageBuildsOverlay } from '#components/ImageBuildsOverlay'
import { SkillsButton } from '#components/SkillsButton'
import { StoppedWorkspacesButton } from '#components/StoppedWorkspacesButton'
import { useStoppedWorkspaces } from '#lib/useStoppedWorkspaces'
import { MasterDetail } from '#components/ui/MasterDetail'
import { useUiStore } from '#lib/store'
import { mockFetch, renderWithClient, testQueryClient, type FetchMock } from './harness'

// jsdom has no ResizeObserver; Base UI needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

// eslint-disable-next-line @typescript-eslint/unbound-method -- only ever restored onto window
const realMatchMedia = window.matchMedia

/**
 * Make `useIsMobile` report a phone-sized viewport (or not). jsdom's own
 * matchMedia always reports no match, i.e. desktop.
 */
function setMobileViewport(mobile: boolean): void {
  window.matchMedia = ((q: string) => ({
    matches: mobile,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
}

const flushEffects = (): Promise<void> => act(async () => { await Promise.resolve() })

const MARK = 'POST /api/workspace/mark-death-seen'
const SKILL_BODY = 'GET /api/project/proj/skills/body'
const BUILD_LOG = 'GET /api/image/builds/build-1/log'

let server: FetchMock
beforeEach(() => {
  vi.clearAllMocks()
  setMobileViewport(true)
  server = mockFetch({ [MARK]: undefined, [BUILD_LOG]: { log: 'STEP 1/2: FROM ubuntu' } })
})

afterEach(() => {
  cleanup()
  window.matchMedia = realMatchMedia
  vi.unstubAllGlobals()
})

describe('MasterDetail', () => {
  const panes = (detailOpen: boolean): HTMLElement => {
    const { container } = render(
      <MasterDetail
        detailOpen={detailOpen}
        onBack={() => {}}
        master={<p>the list</p>}
        detail={<p>the detail</p>}
      />,
    )
    return container.firstElementChild as HTMLElement
  }

  it('keeps both panes mounted and hides one of them only below the breakpoint', () => {
    // Desktop shows both panes, so hiding is `max-md:` only, on whichever
    // pane detailOpen hides.
    const closed = panes(false)
    const [masterClosed, detailClosed] = Array.from(closed.children) as HTMLElement[]
    expect(masterClosed.className).not.toContain('max-md:hidden')
    expect(detailClosed.className).toContain('max-md:hidden')

    cleanup()
    const open = panes(true)
    const [masterOpen, detailOpen] = Array.from(open.children) as HTMLElement[]
    expect(masterOpen.className).toContain('max-md:hidden')
    expect(detailOpen.className).not.toContain('max-md:hidden')
    // Both stay mounted, so going back doesn't refetch.
    expect(screen.getByText('the list')).toBeTruthy()
    expect(screen.getByText('the detail')).toBeTruthy()
  })

  it('offers a back control that is desktop-hidden and clears the selection', () => {
    const onBack = vi.fn()
    render(
      <MasterDetail
        detailOpen
        onBack={onBack}
        backLabel="Back to skills"
        master={<p>the list</p>}
        detail={<p>the detail</p>}
      />,
    )
    const back = screen.getByRole('button', { name: 'Back to skills' })
    // No back chevron on desktop, where both panes show.
    expect(back.className).toContain('md:hidden')
    fireEvent.click(back)
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe('StoppedWorkspacesButton on a phone', () => {
  const stopped = (over: Partial<StoppedWorkspaceEntry> = {}): StoppedWorkspaceEntry => ({
    workspaceId: 's1',
    projectSlug: 'proj',
    tool: 'claude',
    createdAt: '2026-07-13 00:00:00',
    stoppedAt: '2026-07-13 01:00:00',
    seen: false,
    agentSessions: [],
    ...over,
  })

  function Harness(): JSX.Element {
    return <StoppedWorkspacesButton projectSlug="proj" stopped={useStoppedWorkspaces('proj', [], [])} />
  }

  const openOverlay = async (): Promise<void> => {
    useUiStore.setState({ stoppedOverlayOpen: false, optimisticStopped: [] })
    renderWithClient(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: /^Stopped workspaces/ }))
  }

  beforeEach(() => {
    server.route('GET /api/workspace/list-stopped', [
      stopped({ workspaceId: 's1', title: 'OOMed run', prompt: 'fix the parser', deathReason: 'oom' }),
      stopped({ workspaceId: 's2', title: 'Add tests', tool: 'codex' }),
    ])
  })

  it('opens on the list, with no row read until one is tapped', async () => {
    await openOverlay()
    await screen.findByText('Add tests')
    // The detail pane is off-screen, so the top row isn't auto-selected;
    // viewing a detail would mark its death as seen.
    expect(screen.queryByText('fix the parser')).toBeNull()
    expect(screen.queryByRole('button', { name: /Restart/ })).toBeNull()
    await flushEffects()
    expect(server.called(MARK)).toEqual([])
  })

  it('drills into a row and comes back to the list', async () => {
    await openOverlay()
    fireEvent.click((await screen.findAllByText('OOMed run'))[0])
    // Detail-only content: the prompt, the metadata grid, and Restart.
    await waitFor(() => expect(screen.getByText('fix the parser')).toBeTruthy())
    expect(screen.getByText('Cause')).toBeTruthy()
    await waitFor(() => expect(server.called(MARK).map((c) => c.body)).toEqual([{ projectSlug: 'proj', workspaceId: 's1' }]))

    fireEvent.click(screen.getByRole('button', { name: 'Back to stopped workspaces' }))
    await waitFor(() => expect(screen.queryByText('fix the parser')).toBeNull())
    expect(screen.getByText('Add tests')).toBeTruthy()
  })

  it('reopens on the list rather than on the last row read', async () => {
    await openOverlay()
    fireEvent.click((await screen.findAllByText('OOMed run'))[0])
    await waitFor(() => expect(screen.getByText('fix the parser')).toBeTruthy())

    act(() => { useUiStore.getState().closeStoppedOverlay() })
    act(() => { useUiStore.getState().openStoppedOverlay() })
    await waitFor(() => expect(screen.queryByText('fix the parser')).toBeNull())
  })
})

describe('SkillsButton on a phone', () => {
  const SKILLS: ProjectSkills = {
    skills: [
      { id: 'p:deploy', name: 'deploy', description: 'ship it', source: 'project', userInvocable: true, modelInvocable: true },
      { id: 'p:lint', name: 'lint', description: 'tidy it', source: 'project', userInvocable: true, modelInvocable: true },
    ],
  }
  const BODY: SkillDetail = {
    id: 'p:deploy',
    name: 'deploy',
    source: 'project',
    frontmatter: { name: 'deploy', description: 'ship it' },
    body: 'Run the deploy script.',
  }

  const openOverlay = (): void => {
    useUiStore.setState({ skillsOverlayOpen: false })
    renderWithClient(<SkillsButton projectSlug="proj" />)
    fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
  }

  beforeEach(() => {
    server.route('GET /api/project/proj/skills', SKILLS)
    server.route(SKILL_BODY, BODY)
    server.route('GET /api/project/proj/branches', { branches: ['main'], defaultBranch: 'main' })
  })

  it('opens on the list and fetches no SKILL.md until one is tapped', async () => {
    openOverlay()
    await screen.findByText('/deploy')
    expect(screen.getByText('/lint')).toBeTruthy()
    await flushEffects()
    // The body is fetched only when the detail pane opens.
    expect(server.called(SKILL_BODY)).toEqual([])
  })

  it('drills into a skill and comes back to the list', async () => {
    openOverlay()
    fireEvent.click(await screen.findByText('/deploy'))
    await waitFor(() => expect(screen.getByText('Run the deploy script.')).toBeTruthy())
    expect(server.called(SKILL_BODY).map((c) => Object.fromEntries(c.query)))
      .toEqual([{ id: 'p:deploy', tool: 'claude', branch: 'main' }])

    fireEvent.click(screen.getByRole('button', { name: 'Back to skills' }))
    await waitFor(() => expect(screen.queryByText('Run the deploy script.')).toBeNull())
    expect(screen.getByText('/lint')).toBeTruthy()
  })
})

describe('ImageBuildsOverlay on a phone', () => {
  const build = (over: Partial<ImageBuildEntry> = {}): ImageBuildEntry => ({
    id: 'build-1',
    tag: 'yaac-base:abc123def',
    layer: 'base',
    projectSlugs: ['proj'],
    reason: 'prewarm',
    status: 'running',
    startedAt: '2026-07-06 00:00:00',
    ...over,
  })

  it('opens on the list and polls no log until a build is tapped', async () => {
    renderWithClient(<ImageBuildsOverlay open onOpenChange={() => {}} builds={[build()]} />)
    await flushEffects()
    expect(screen.getByText('base layer')).toBeTruthy()
    // Unlike desktop, mobile doesn't auto-follow the running build's log.
    expect(server.called(BUILD_LOG)).toEqual([])

    fireEvent.click(screen.getByText('base layer'))
    await waitFor(() => expect(screen.getByText(/STEP 1\/2/)).toBeTruthy())
    const detailPane = screen.getByText(/STEP 1\/2/).parentElement as HTMLElement

    // Back hides the log pane but keeps it mounted, so returning doesn't
    // refetch.
    fireEvent.click(screen.getByRole('button', { name: 'Back to builds' }))
    await waitFor(() => expect(detailPane.className).toContain('max-md:hidden'))
    expect(screen.getByText('base layer')).toBeTruthy()
  })

  it('reopens on the list rather than on the last log read', async () => {
    // This overlay stays mounted while closed, so its pick must be reset.
    const client = testQueryClient()
    const overlay = (open: boolean): JSX.Element => (
      <QueryClientProvider client={client}>
        <ImageBuildsOverlay open={open} onOpenChange={() => {}} builds={[build()]} />
      </QueryClientProvider>
    )
    const { rerender } = render(overlay(true))
    await flushEffects()
    fireEvent.click(screen.getByText('base layer'))
    const detailPane = (await screen.findByText(/STEP 1\/2/)).parentElement as HTMLElement
    await waitFor(() => expect(detailPane.className).not.toContain('max-md:hidden'))

    rerender(overlay(false))
    rerender(overlay(true))
    await waitFor(() => expect(detailPane.className).toContain('max-md:hidden'))
  })
})
