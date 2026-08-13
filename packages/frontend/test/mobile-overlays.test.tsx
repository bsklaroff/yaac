// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import type { ImageBuildEntry, ProjectSkills, SkillDetail, StoppedWorktreeEntry } from '@yaac/shared/types'

const provision = vi.hoisted(() => vi.fn())

vi.mock('#lib/stoppedApi', () => ({
  getStoppedWorktrees: vi.fn(),
  markDeathSeen: vi.fn(),
  markAllDeathsSeen: vi.fn(),
}))
vi.mock('#lib/createWorktree', () => ({ restartWorktree: vi.fn() }))
vi.mock('#lib/useProvisionWorktree', () => ({ useProvisionWorktree: () => provision }))
vi.mock('#lib/skillsApi', () => ({ getProjectSkills: vi.fn(), getSkillBody: vi.fn() }))
vi.mock('#lib/projectApi', () => ({
  getProjectBranches: vi.fn(),
  projectBranchesKey: (slug: string) => ['project-branches', slug],
}))
vi.mock('#lib/imageBuildsApi', () => ({
  getImageBuildLog: vi.fn(),
  dismissImageBuild: vi.fn().mockResolvedValue(undefined),
  retryImageBuild: vi.fn().mockResolvedValue(undefined),
}))

import { ImageBuildsOverlay } from '#components/ImageBuildsOverlay'
import { SkillsButton } from '#components/SkillsButton'
import { StoppedWorktreesButton } from '#components/StoppedWorktreesButton'
import { MasterDetail } from '#components/ui/MasterDetail'
import { getImageBuildLog } from '#lib/imageBuildsApi'
import { getProjectBranches } from '#lib/projectApi'
import { getProjectSkills, getSkillBody } from '#lib/skillsApi'
import { getStoppedWorktrees, markDeathSeen } from '#lib/stoppedApi'
import { useUiStore } from '#store'

// jsdom has no ResizeObserver; Base UI needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const realMatchMedia = window.matchMedia

/**
 * Report the viewport as phone-sized (or not) to `useIsMobile`, which is what
 * every overlay below asks before deciding whether it has room for two panes.
 * jsdom's own matchMedia always answers "no match", i.e. desktop.
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

const client = (): QueryClient => new QueryClient({ defaultOptions: { queries: { retry: false } } })

beforeEach(() => {
  vi.clearAllMocks()
  setMobileViewport(true)
})

afterEach(() => {
  cleanup()
  window.matchMedia = realMatchMedia
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
    // Desktop shows both, so neither pane may carry an unconditional `hidden` —
    // the hiding is `max-md:` only, and which pane it lands on flips with
    // detailOpen.
    const closed = panes(false)
    const [masterClosed, detailClosed] = Array.from(closed.children) as HTMLElement[]
    expect(masterClosed.className).not.toContain('max-md:hidden')
    expect(detailClosed.className).toContain('max-md:hidden')

    cleanup()
    const open = panes(true)
    const [masterOpen, detailOpen] = Array.from(open.children) as HTMLElement[]
    expect(masterOpen.className).toContain('max-md:hidden')
    expect(detailOpen.className).not.toContain('max-md:hidden')
    // Both stay in the tree either way — going back must not refetch.
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
    // Desktop has both panes side by side, so the chevron would navigate
    // nowhere there.
    expect(back.className).toContain('md:hidden')
    fireEvent.click(back)
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe('StoppedWorktreesButton on a phone', () => {
  const stopped = (over: Partial<StoppedWorktreeEntry> = {}): StoppedWorktreeEntry => ({
    worktreeId: 's1',
    projectSlug: 'proj',
    tool: 'claude',
    createdAt: '2026-07-13 00:00:00',
    stoppedAt: '2026-07-13 01:00:00',
    seen: false,
    agentSessions: [],
    ...over,
  })

  const openOverlay = async (): Promise<void> => {
    useUiStore.setState({ stoppedOverlayOpen: false, optimisticStopped: [] })
    render(
      <QueryClientProvider client={client()}>
        <StoppedWorktreesButton projectSlug="proj" activeSignature="s0" />
      </QueryClientProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: /^Stopped worktrees/ }))
  }

  beforeEach(() => {
    vi.mocked(getStoppedWorktrees).mockResolvedValue([
      stopped({ worktreeId: 's1', title: 'OOMed run', prompt: 'fix the parser', deathReason: 'oom' }),
      stopped({ worktreeId: 's2', title: 'Add tests', tool: 'codex' }),
    ])
    vi.mocked(markDeathSeen).mockResolvedValue(undefined)
  })

  it('opens on the list, with no row read until one is tapped', async () => {
    await openOverlay()
    await screen.findByText('Add tests')
    // The detail pane is off-screen, so the top row is not auto-selected —
    // and viewing a detail is what acknowledges a death, which must not
    // happen to a row nobody opened.
    expect(screen.queryByText('fix the parser')).toBeNull()
    expect(screen.queryByRole('button', { name: /Restart/ })).toBeNull()
    await flushEffects()
    expect(markDeathSeen).not.toHaveBeenCalled()
  })

  it('drills into a row and comes back to the list', async () => {
    await openOverlay()
    fireEvent.click((await screen.findAllByText('OOMed run'))[0])
    // Detail-only content: the prompt, the metadata grid, and Restart.
    await waitFor(() => expect(screen.getByText('fix the parser')).toBeTruthy())
    expect(screen.getByText('Cause')).toBeTruthy()
    await waitFor(() => expect(markDeathSeen).toHaveBeenCalledWith('proj', 's1'))

    fireEvent.click(screen.getByRole('button', { name: 'Back to stopped worktrees' }))
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
    render(
      <QueryClientProvider client={client()}>
        <SkillsButton projectSlug="proj" />
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
  }

  beforeEach(() => {
    vi.mocked(getProjectSkills).mockResolvedValue(SKILLS)
    vi.mocked(getSkillBody).mockResolvedValue(BODY)
    vi.mocked(getProjectBranches).mockResolvedValue({
      branches: ['main'], defaultBranch: 'main', referenceBranch: null,
    })
  })

  it('opens on the list and fetches no SKILL.md until one is tapped', async () => {
    openOverlay()
    await screen.findByText('/deploy')
    expect(screen.getByText('/lint')).toBeTruthy()
    await flushEffects()
    // The body fetch belongs to the detail pane, which nobody has opened.
    expect(getSkillBody).not.toHaveBeenCalled()
  })

  it('drills into a skill and comes back to the list', async () => {
    openOverlay()
    fireEvent.click(await screen.findByText('/deploy'))
    await waitFor(() => expect(screen.getByText('Run the deploy script.')).toBeTruthy())
    expect(getSkillBody).toHaveBeenCalledWith('proj', 'p:deploy', 'claude', 'main')

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
    action: 'build',
    projectSlugs: ['proj'],
    reason: 'prewarm',
    status: 'running',
    startedAt: '2026-07-06 00:00:00',
    ...over,
  })

  beforeEach(() => {
    vi.mocked(getImageBuildLog).mockResolvedValue({ log: 'STEP 1/2: FROM ubuntu' })
  })

  it('opens on the list and polls no log until a build is tapped', async () => {
    render(<ImageBuildsOverlay open onOpenChange={() => {}} builds={[build()]} />)
    await flushEffects()
    expect(screen.getByText('base layer')).toBeTruthy()
    // Desktop auto-follows the running build; a phone would be tailing a log
    // nobody can see.
    expect(getImageBuildLog).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('base layer'))
    await waitFor(() => expect(screen.getByText(/STEP 1\/2/)).toBeTruthy())
    const detailPane = screen.getByText(/STEP 1\/2/).parentElement as HTMLElement

    // Back re-hides the log pane. Its text stays in the DOM — the tail is kept
    // mounted so returning to it doesn't re-fetch from the top.
    fireEvent.click(screen.getByRole('button', { name: 'Back to builds' }))
    await waitFor(() => expect(detailPane.className).toContain('max-md:hidden'))
    expect(screen.getByText('base layer')).toBeTruthy()
  })

  it('reopens on the list rather than on the last log read', async () => {
    // Unlike the other two overlays this one stays mounted while closed, so a
    // pick outlives a close and would otherwise still be showing on reopen.
    const { rerender } = render(
      <ImageBuildsOverlay open onOpenChange={() => {}} builds={[build()]} />,
    )
    await flushEffects()
    fireEvent.click(screen.getByText('base layer'))
    const detailPane = (await screen.findByText(/STEP 1\/2/)).parentElement as HTMLElement
    await waitFor(() => expect(detailPane.className).not.toContain('max-md:hidden'))

    rerender(<ImageBuildsOverlay open={false} onOpenChange={() => {}} builds={[build()]} />)
    rerender(<ImageBuildsOverlay open onOpenChange={() => {}} builds={[build()]} />)
    await waitFor(() => expect(detailPane.className).toContain('max-md:hidden'))
  })
})
