// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import type { JSX } from 'react'
import type { ImageBuildEntry, ProjectSkills, SkillDetail } from '@yaac/shared/types'

import { ImageBuildsOverlay } from '#components/ImageBuildsOverlay'
import { SkillsButton } from '#components/SkillsButton'
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

const SKILL_BODY = 'GET /api/project/proj/skills/body'
const BUILD_LOG = 'GET /api/image/builds/build-1/log'

let server: FetchMock
beforeEach(() => {
  vi.clearAllMocks()
  setMobileViewport(true)
  server = mockFetch({ [BUILD_LOG]: { log: 'STEP 1/2: FROM ubuntu' } })
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
    renderWithClient(<SkillsButton projectId="proj" />)
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
    projectIds: ['proj'],
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
