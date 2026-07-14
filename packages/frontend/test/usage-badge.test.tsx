// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('#lib/useSnapshot', () => ({ useSnapshot: vi.fn() }))
vi.mock('#lib/usageApi', () => ({
  requestUsageRefresh: vi.fn().mockResolvedValue(undefined),
}))

import { useSnapshot } from '#lib/useSnapshot'
import { requestUsageRefresh } from '#lib/usageApi'
import {
  limitLabel,
  metricKey,
  pillTag,
  planLabel,
  resetsLabel,
  usageTone,
  UsageBadge,
} from '#components/UsageBadge'
import { useUiStore } from '#store'
import type { ServerSnapshot, PlanUsageLimit, PlanUsageResult } from '@yaac/shared/types'

// jsdom has no ResizeObserver; Base UI needs one to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  useUiStore.setState({ pinnedUsageMetric: null })
})
afterEach(cleanup)

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

const USAGE: PlanUsageResult = {
  available: true,
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
  limits: [
    limit(),
    limit({ kind: 'weekly_all', percent: 6 }),
    limit({ kind: 'weekly_scoped', percent: 11, modelName: 'Fable' }),
  ],
}

function stubSnapshot(planUsage: PlanUsageResult | null): void {
  vi.mocked(useSnapshot).mockReturnValue({
    sessions: [], stale: [], projects: [], provisioning: [], gitAuthFailures: {}, imageBuilds: [],
    planUsage,
  } as ServerSnapshot)
}

function pill(): HTMLElement {
  return screen.getByRole('button', { name: 'Show plan usage' })
}

describe('limitLabel', () => {
  it('names the known limit kinds', () => {
    expect(limitLabel(limit())).toBe('Current session (5h)')
    expect(limitLabel(limit({ kind: 'weekly_all' }))).toBe('Weekly — all models')
    expect(limitLabel(limit({ kind: 'weekly_scoped', modelName: 'Fable' }))).toBe('Weekly — Fable')
  })

  it('falls back to a humanized kind for unknown limits', () => {
    expect(limitLabel(limit({ kind: 'weekly_scoped', modelName: null }))).toBe('weekly scoped')
    expect(limitLabel(limit({ kind: 'monthly_all' }))).toBe('monthly all')
  })
})

describe('metricKey', () => {
  it('keys by kind, adding the model for scoped limits', () => {
    expect(metricKey(limit())).toBe('session')
    expect(metricKey(limit({ kind: 'weekly_all' }))).toBe('weekly_all')
    expect(metricKey(limit({ kind: 'weekly_scoped', modelName: 'Fable' }))).toBe('weekly_scoped:Fable')
  })
})

describe('pillTag', () => {
  it('tags the session window by span and scoped limits by model', () => {
    expect(pillTag(limit())).toBe('5h')
    expect(pillTag(limit({ kind: 'weekly_all' }))).toBe('wk')
    expect(pillTag(limit({ kind: 'weekly_scoped', modelName: 'Fable' }))).toBe('Fable')
  })
})

describe('planLabel', () => {
  it('appends the usage multiplier from the rate-limit tier', () => {
    expect(planLabel('max', 'default_claude_max_20x')).toBe('Max (20x)')
    expect(planLabel('max', 'default_claude_max_10x')).toBe('Max (10x)')
  })

  it('falls back to the bare plan without a multiplier tier', () => {
    expect(planLabel('max', null)).toBe('Max')
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
  it('renders nothing before the snapshot or usage arrives', () => {
    vi.mocked(useSnapshot).mockReturnValue(undefined)
    render(<UsageBadge />)
    expect(screen.queryByRole('button')).toBeNull()

    stubSnapshot(null)
    render(<UsageBadge />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders nothing when usage is unavailable', () => {
    stubSnapshot({ available: false, reason: 'api-key' })
    render(<UsageBadge />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders nothing when usage is available but has no limits', () => {
    stubSnapshot({ available: true, subscriptionType: 'max', rateLimitTier: null, limits: [] })
    render(<UsageBadge />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the tightest limit on the trigger pill', () => {
    stubSnapshot(USAGE)
    render(<UsageBadge />)
    expect(pill().textContent).toBe('19%')
  })

  it('opens a popover with one row per limit and the plan tier', () => {
    stubSnapshot(USAGE)
    render(<UsageBadge />)
    fireEvent.click(pill())

    expect(screen.getByText('Plan usage')).toBeTruthy()
    expect(screen.getByText('Max (20x) plan')).toBeTruthy()
    expect(screen.getByText('Current session (5h)')).toBeTruthy()
    expect(screen.getByText('Weekly — all models')).toBeTruthy()
    expect(screen.getByText('Weekly — Fable')).toBeTruthy()
    expect(screen.getByText('6%')).toBeTruthy()
    expect(screen.getByText('11%')).toBeTruthy()
  })

  it('nudges a background usage refresh when opened', () => {
    stubSnapshot(USAGE)
    render(<UsageBadge />)
    expect(requestUsageRefresh).not.toHaveBeenCalled()
    fireEvent.click(pill())
    expect(requestUsageRefresh).toHaveBeenCalledTimes(1)
  })

  it('pins a metric to the pill, switches pins, and unpins', () => {
    stubSnapshot(USAGE)
    render(<UsageBadge />)
    fireEvent.click(pill())

    // Pin the weekly Fable limit: the pill carries its tag + percent, and
    // the row flags itself pressed.
    fireEvent.click(screen.getByRole('button', { name: 'Pin Weekly — Fable' }))
    expect(pill().textContent).toBe('Fable11%')
    expect(screen.getByRole('button', { name: 'Unpin Weekly — Fable' })
      .getAttribute('aria-pressed')).toBe('true')

    // Switch the pin to the session window.
    fireEvent.click(screen.getByRole('button', { name: 'Pin Current session (5h)' }))
    expect(pill().textContent).toBe('5h19%')
    expect(screen.getByRole('button', { name: 'Pin Weekly — Fable' })
      .getAttribute('aria-pressed')).toBe('false')

    // Clicking the pinned row unpins — back to the tightest-limit default.
    fireEvent.click(screen.getByRole('button', { name: 'Unpin Current session (5h)' }))
    expect(pill().textContent).toBe('19%')
    expect(useUiStore.getState().pinnedUsageMetric).toBeNull()
  })

  it('falls back to the tightest limit when the pinned metric is absent', () => {
    useUiStore.setState({ pinnedUsageMetric: 'weekly_scoped:Opus' })
    stubSnapshot(USAGE)
    render(<UsageBadge />)
    expect(pill().textContent).toBe('19%')
    // The pin is kept, not cleared — the limit may come back.
    expect(useUiStore.getState().pinnedUsageMetric).toBe('weekly_scoped:Opus')
  })
})
