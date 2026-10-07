// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('#lib/useSnapshot', () => ({ useSnapshot: vi.fn() }))

import { useSnapshot } from '#lib/useSnapshot'
import { mockFetch, renderWithClient, testQueryClient, type FetchMock } from './harness'
import {
  limitLabel,
  metricKey,
  pillTag,
  planLabel,
  resetsLabel,
  usageTone,
  UsageBadge,
} from '#components/UsageBadge'
import { useUiStore } from '#lib/store'
import type { PlanUsageLimit, PlanUsageResult } from '@yaac/shared/types'

// jsdom has no ResizeObserver; Base UI needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

let server: FetchMock

beforeEach(() => {
  vi.clearAllMocks()
  useUiStore.setState({ pinnedUsageMetric: null })
  server = mockFetch({
    'POST /api/auth/claude/usage/refresh': undefined,
    'GET /api/whoami': { kind: 'local', userId: ME, users: [] },
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function limit(overrides: Partial<PlanUsageLimit> = {}): PlanUsageLimit {
  return {
    kind: 'session',
    percent: 19,
    severity: 'normal',
    resetsAt: '2026-07-10T03:49:59.538046+00:00',
    modelName: null,
    ...overrides,
  }
}

function codexLimit(overrides: Partial<PlanUsageLimit> = {}): PlanUsageLimit {
  return {
    kind: 'codex_primary',
    percent: 42,
    severity: 'normal',
    resetsAt: null,
    modelName: null,
    windowMinutes: 300,
    ...overrides,
  }
}

const CLAUDE_USAGE: PlanUsageResult = {
  available: true,
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
  limits: [
    limit(),
    limit({ kind: 'weekly_all', percent: 6 }),
    limit({ kind: 'weekly_scoped', percent: 11, modelName: 'Fable' }),
  ],
}

const CODEX_USAGE: PlanUsageResult = {
  available: true,
  subscriptionType: 'plus',
  rateLimitTier: null,
  limits: [
    codexLimit(),
    codexLimit({ kind: 'codex_secondary', percent: 18, windowMinutes: 10080 }),
  ],
}

function stubSnapshot(
  planUsage: PlanUsageResult | null,
  codexPlanUsage: PlanUsageResult | null = null,
): void {
  vi.mocked(useSnapshot).mockReturnValue({
    driver: 'k8s',
    workspaces: [], workspaceGroups: [], stale: [], projects: [], provisioning: [], queuedWorkspaces: [], heldWorkspaces: [], draftWorkspaces: [], gitAuthFailures: {},
    imageBuilds: [],
    // Another user's readout, which the badge must not show.
    planUsage: { [ME]: planUsage, [OTHER]: { available: false, reason: 'api-key' } },
    codexPlanUsage: { [ME]: codexPlanUsage },
    forwardBindHost: '127.0.0.1',
  })
}

const ME = '6f1c1c55-7a53-4bd5-9a0f-0b3a3d1b1a01'
const OTHER = '6f1c1c55-7a53-4bd5-9a0f-0b3a3d1b1a02'

/** Render the badge as `ME`, whose `whoami` App has already loaded. */
function renderBadge(): void {
  const client = testQueryClient()
  client.setQueryData(['whoami'], { kind: 'local', userId: ME, users: [] })
  renderWithClient(<UsageBadge />, client)
}

function pill(): HTMLElement {
  return screen.getByRole('button', { name: 'Show plan usage' })
}

describe('limitLabel', () => {
  it('names the known Claude limit kinds', () => {
    expect(limitLabel(limit(), 'claude')).toBe('Current session (5h)')
    expect(limitLabel(limit({ kind: 'weekly_all' }), 'claude')).toBe('Weekly — all models')
    expect(limitLabel(limit({ kind: 'weekly_scoped', modelName: 'Fable' }), 'claude')).toBe('Weekly — Fable')
  })

  it('falls back to a humanized kind for unknown Claude limits', () => {
    expect(limitLabel(limit({ kind: 'weekly_scoped', modelName: null }), 'claude')).toBe('weekly scoped')
    expect(limitLabel(limit({ kind: 'monthly_all' }), 'claude')).toBe('monthly all')
  })

  it('labels Codex windows from their duration', () => {
    expect(limitLabel(codexLimit({ windowMinutes: 300 }), 'codex')).toBe('5h limit')
    expect(limitLabel(codexLimit({ windowMinutes: 60 }), 'codex')).toBe('1h limit')
    expect(limitLabel(codexLimit({ windowMinutes: 10080 }), 'codex')).toBe('Weekly limit')
    expect(limitLabel(codexLimit({ windowMinutes: null }), 'codex')).toBe('Usage')
  })
})

describe('metricKey', () => {
  it('keys by tool and kind, adding the model for scoped limits', () => {
    expect(metricKey('claude', limit())).toBe('claude:session')
    expect(metricKey('claude', limit({ kind: 'weekly_all' }))).toBe('claude:weekly_all')
    expect(metricKey('claude', limit({ kind: 'weekly_scoped', modelName: 'Fable' }))).toBe('claude:weekly_scoped:Fable')
    expect(metricKey('codex', codexLimit())).toBe('codex:codex_primary')
  })
})

describe('pillTag', () => {
  it('tags Claude windows by span and scoped limits by model', () => {
    expect(pillTag(limit(), 'claude')).toBe('5h')
    expect(pillTag(limit({ kind: 'weekly_all' }), 'claude')).toBe('wk')
    expect(pillTag(limit({ kind: 'weekly_scoped', modelName: 'Fable' }), 'claude')).toBe('Fable')
  })

  it('tags Codex windows from their duration', () => {
    expect(pillTag(codexLimit({ windowMinutes: 300 }), 'codex')).toBe('5h')
    expect(pillTag(codexLimit({ windowMinutes: 10080 }), 'codex')).toBe('wk')
  })
})

describe('planLabel', () => {
  it('appends the usage multiplier from the rate-limit tier', () => {
    expect(planLabel('max', 'default_claude_max_20x')).toBe('Max (20x)')
    expect(planLabel('max', 'default_claude_max_10x')).toBe('Max (10x)')
  })

  it('falls back to the bare plan without a multiplier tier', () => {
    expect(planLabel('max', null)).toBe('Max')
    expect(planLabel('plus', null)).toBe('Plus')
    expect(planLabel('pro', 'default_claude_pro')).toBe('Pro')
    expect(planLabel(null, 'default_claude_max_20x')).toBeNull()
  })
})

describe('resetsLabel', () => {
  const now = Date.parse('2026-07-09T12:00:00Z')

  it('counts down inside 24 hours', () => {
    expect(resetsLabel('2026-07-09T12:30:00Z', now)).toBe('resets in 30m')
    expect(resetsLabel('2026-07-09T15:45:00Z', now)).toBe('resets in 3h 45m')
    expect(resetsLabel('2026-07-10T11:59:00Z', now)).toBe('resets in 23h 59m')
  })

  it('names the local day and time beyond 24 hours', () => {
    const resetsAt = '2026-07-12T15:30:00Z'
    const label = resetsLabel(resetsAt, now)
    expect(label).toMatch(/^resets (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2}$/)
    // The named day must be the reset instant's local day (tz-agnostic).
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(resetsAt).getDay()]
    expect(label.startsWith(`resets ${day} `)).toBe(true)
  })

  it('is empty for missing, invalid, or past times', () => {
    expect(resetsLabel(null, now)).toBe('')
    expect(resetsLabel('not-a-date', now)).toBe('')
    expect(resetsLabel('2026-07-09T11:00:00Z', now)).toBe('')
  })
})

describe('usageTone', () => {
  it('keys off percent thresholds', () => {
    expect(usageTone(limit({ percent: 10 }))).toBe('ok')
    expect(usageTone(limit({ percent: 70 }))).toBe('warn')
    expect(usageTone(limit({ percent: 95 }))).toBe('high')
  })

  it('escalates on a non-normal upstream severity', () => {
    expect(usageTone(limit({ percent: 10, severity: 'allowed_warning' }))).toBe('warn')
  })
})

describe('UsageBadge', () => {
  it('renders nothing before the snapshot or any usage arrives', () => {
    vi.mocked(useSnapshot).mockReturnValue(undefined)
    renderBadge()
    expect(screen.queryByRole('button')).toBeNull()

    stubSnapshot(null, null)
    renderBadge()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders nothing when every tool is unavailable or has no limits', () => {
    stubSnapshot({ available: false, reason: 'api-key' }, null)
    renderBadge()
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()

    stubSnapshot(
      { available: true, subscriptionType: 'max', rateLimitTier: null, limits: [] },
      null,
    )
    renderBadge()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the caller\'s own usage, also while viewing a teammate', () => {
    // The other user's slot holds an api-key readout, which would hide the
    // badge if it were shown.
    stubSnapshot(CLAUDE_USAGE)
    useUiStore.setState({ viewedUserId: OTHER })
    try {
      renderBadge()
      expect(pill().textContent).toBe('19%')
    } finally {
      useUiStore.setState({ viewedUserId: null })
    }
  })

  it('shows the tightest limit across all tools on the trigger pill', () => {
    // Claude's tightest is 19% and Codex's is 42%, so the pill shows 42%.
    stubSnapshot(CLAUDE_USAGE, CODEX_USAGE)
    renderBadge()
    expect(pill().textContent).toBe('42%')
  })

  it('renders a Codex-only readout when Claude is unavailable', () => {
    stubSnapshot({ available: false, reason: 'api-key' }, CODEX_USAGE)
    renderBadge()
    expect(pill().textContent).toBe('42%')
    fireEvent.click(pill())
    expect(screen.getByText('Codex')).toBeTruthy()
    expect(screen.queryByText('Claude')).toBeNull()
  })

  it('opens a popover with a section per tool, its plan, and one row per limit', () => {
    stubSnapshot(CLAUDE_USAGE, CODEX_USAGE)
    renderBadge()
    fireEvent.click(pill())

    expect(screen.getByText('Plan usage')).toBeTruthy()
    expect(screen.getByText('Claude')).toBeTruthy()
    expect(screen.getByText('Max (20x)')).toBeTruthy()
    expect(screen.getByText('Codex')).toBeTruthy()
    expect(screen.getByText('Plus')).toBeTruthy()
    expect(screen.getByText('Current session (5h)')).toBeTruthy()
    expect(screen.getByText('Weekly — all models')).toBeTruthy()
    expect(screen.getByText('Weekly — Fable')).toBeTruthy()
    expect(screen.getByText('5h limit')).toBeTruthy()
    expect(screen.getByText('Weekly limit')).toBeTruthy()
    expect(screen.getByText('11%')).toBeTruthy()
    expect(screen.getByText('18%')).toBeTruthy()
  })

  it('nudges a background usage refresh when opened', () => {
    stubSnapshot(CLAUDE_USAGE, CODEX_USAGE)
    renderBadge()
    expect(server.called('POST /api/auth/claude/usage/refresh')).toHaveLength(0)
    fireEvent.click(pill())
    expect(server.called('POST /api/auth/claude/usage/refresh')).toHaveLength(1)
  })

  it('pins metrics across tools, switches pins, and unpins', () => {
    stubSnapshot(CLAUDE_USAGE, CODEX_USAGE)
    renderBadge()
    fireEvent.click(pill())

    // Pin the Claude weekly Fable limit: the pill carries its tag + percent.
    fireEvent.click(screen.getByRole('button', { name: 'Pin Claude Weekly — Fable' }))
    expect(pill().textContent).toBe('Fable11%')
    expect(useUiStore.getState().pinnedUsageMetric).toBe('claude:weekly_scoped:Fable')

    fireEvent.click(screen.getByRole('button', { name: 'Pin Codex 5h limit' }))
    expect(pill().textContent).toBe('5h42%')
    expect(useUiStore.getState().pinnedUsageMetric).toBe('codex:codex_primary')

    // Clicking the pinned row unpins, restoring the tightest-limit default.
    fireEvent.click(screen.getByRole('button', { name: 'Unpin Codex 5h limit' }))
    expect(pill().textContent).toBe('42%')
    expect(useUiStore.getState().pinnedUsageMetric).toBeNull()
  })

  it('falls back to the tightest limit when the pinned metric is absent', () => {
    useUiStore.setState({ pinnedUsageMetric: 'claude:weekly_scoped:Opus' })
    stubSnapshot(CLAUDE_USAGE, CODEX_USAGE)
    renderBadge()
    expect(pill().textContent).toBe('42%')
    // The pin is kept because the limit may come back.
    expect(useUiStore.getState().pinnedUsageMetric).toBe('claude:weekly_scoped:Opus')
  })
})
