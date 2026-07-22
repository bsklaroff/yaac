import type { JSX } from 'react'
import clsx from 'clsx'
import { Popover } from '@base-ui/react/popover'
import { PinIcon, UsageIcon, TOOL_LABEL } from '#lib/icons'
import { useSnapshot } from '#lib/useSnapshot'
import { requestUsageRefresh } from '#lib/usageApi'
import { useUiStore } from '#store'
import type { AgentTool, PlanUsageLimit, PlanUsageResult } from '@yaac/shared/types'

/** One tool's queryable usage, flattened for rendering. */
interface UsageSection {
  tool: AgentTool
  subscriptionType: string | null
  rateLimitTier: string | null
  limits: PlanUsageLimit[]
}

/** Only Claude and Codex expose a subscription usage endpoint; the popover
 *  renders their sections in this fixed order. */
const USAGE_TOOLS: AgentTool[] = ['claude', 'codex']

/** Turn a Codex window length into a human label ('5h limit', 'Weekly
 *  limit', …) — Codex reports the window duration rather than a named kind. */
function codexWindowLabel(windowMinutes: number | null | undefined): string {
  if (windowMinutes == null) return 'Usage'
  if (windowMinutes < 60) return `${windowMinutes}m limit`
  if (windowMinutes < 1440) return `${Math.round(windowMinutes / 60)}h limit`
  if (windowMinutes === 10080) return 'Weekly limit'
  if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d limit`
  return `${Math.round(windowMinutes / 60)}h limit`
}

/** Human label for a plan-limit row, per the tool it belongs to. */
export function limitLabel(limit: PlanUsageLimit, tool: AgentTool): string {
  if (tool === 'codex') return codexWindowLabel(limit.windowMinutes)
  if (limit.kind === 'session') return 'Current session (5h)'
  if (limit.kind === 'weekly_all') return 'Weekly — all models'
  if (limit.kind === 'weekly_scoped' && limit.modelName) return `Weekly — ${limit.modelName}`
  return limit.kind.replace(/_/g, ' ')
}

/** Stable identity for a limit row — what a pin persists across refreshes
 *  (percent and reset time churn; tool + kind + scoped model don't). Keyed
 *  by tool so a pin is unambiguous across the combined readout. */
export function metricKey(tool: AgentTool, limit: PlanUsageLimit): string {
  const base = limit.modelName ? `${limit.kind}:${limit.modelName}` : limit.kind
  return `${tool}:${base}`
}

/** Compact tag telling the pill's pinned metric apart: a window by its span,
 *  a scoped Claude limit by its model, plain weekly as 'wk'. */
export function pillTag(limit: PlanUsageLimit, tool: AgentTool): string {
  if (tool === 'codex') {
    return limit.windowMinutes != null && limit.windowMinutes < 1440
      ? `${Math.round(limit.windowMinutes / 60)}h`
      : 'wk'
  }
  if (limit.kind === 'session') return '5h'
  return limit.modelName ?? 'wk'
}

/**
 * Popover section-header plan name: the section's subscriptionType, plus the
 * usage multiplier when the rate-limit tier carries one — 'max' +
 * 'default_claude_max_20x' → 'Max (20x)'. Codex passes its plan_type (e.g.
 * 'plus') with a null tier, giving the bare 'Plus'.
 */
export function planLabel(
  subscriptionType: string | null,
  rateLimitTier: string | null,
): string | null {
  if (!subscriptionType) return null
  const base = subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1)
  const multiplier = rateLimitTier?.match(/_(\d+x)$/)?.[1]
  return multiplier ? `${base} (${multiplier})` : base
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * When a limit's window resets: a countdown inside 24h, else the local
 * day + time it resets ('resets Tue 22:00'); '' for past/missing times.
 */
export function resetsLabel(resetsAt: string | null, nowMs = Date.now()): string {
  if (!resetsAt) return ''
  const t = Date.parse(resetsAt)
  if (Number.isNaN(t) || t <= nowMs) return ''
  const m = Math.ceil((t - nowMs) / 60_000)
  if (m < 60) return `resets in ${m}m`
  if (m < 24 * 60) return `resets in ${Math.floor(m / 60)}h ${m % 60}m`
  const d = new Date(t)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `resets ${DAY_NAMES[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Traffic-light tone for a limit: the upstream severity wins when it says
 * anything other than 'normal'; otherwise plain percent thresholds.
 */
export function usageTone(limit: PlanUsageLimit): 'ok' | 'warn' | 'high' {
  if (limit.percent >= 90) return 'high'
  if (limit.percent >= 70 || limit.severity !== 'normal') return 'warn'
  return 'ok'
}

const TONE_BAR: Record<ReturnType<typeof usageTone>, string> = {
  ok: 'bg-emerald-400',
  warn: 'bg-amber-400',
  high: 'bg-[#d65858]',
}

const TONE_TRIGGER: Record<ReturnType<typeof usageTone>, string> = {
  ok: 'bg-surface-2 text-text-dim hover:bg-surface-3 hover:text-text',
  warn: 'bg-amber-400/15 text-amber-400 hover:bg-amber-400/25',
  high: 'bg-[#d65858]/15 text-[#d65858] hover:bg-[#d65858]/25',
}

/** Collect the queryable-and-non-empty usage sections from the snapshot, in
 *  tool order. */
function usageSections(
  byTool: Partial<Record<AgentTool, PlanUsageResult | null>>,
): UsageSection[] {
  const sections: UsageSection[] = []
  for (const tool of USAGE_TOOLS) {
    const usage = byTool[tool]
    if (usage?.available && usage.limits.length > 0) {
      sections.push({
        tool,
        subscriptionType: usage.subscriptionType,
        rateLimitTier: usage.rateLimitTier,
        limits: usage.limits,
      })
    }
  }
  return sections
}

/**
 * Sidebar-header pill showing plan-limit utilization for the signed-in
 * subscriptions (Claude and/or Codex) — the tightest limit across all of
 * them by default, or the metric the user pinned (click a popover row to
 * pin it; the pill then carries a compact tag naming it). The popover breaks
 * the readout down per tool. Reads the server-pushed snapshot — the server
 * owns querying upstream (server/plan-usage.ts). Hidden entirely when no
 * tool's usage is queryable (api-key auth, not signed in, endpoint trouble).
 */
export function UsageBadge(): JSX.Element | null {
  const snapshot = useSnapshot()
  const pinnedKey = useUiStore((s) => s.pinnedUsageMetric)
  const setPinnedUsageMetric = useUiStore((s) => s.setPinnedUsageMetric)

  const sections = usageSections({
    claude: snapshot?.planUsage,
    codex: snapshot?.codexPlanUsage,
  })
  if (sections.length === 0) return null

  // Flatten every tool's limits so the pill can pick the tightest across the
  // whole readout (or honor the pin).
  const all = sections.flatMap((s) => s.limits.map((limit) => ({ tool: s.tool, limit })))
  // A pin for a limit upstream no longer reports falls back to the default
  // readout (kept, not cleared — the limit may come back).
  const pinned = all.find((e) => metricKey(e.tool, e.limit) === pinnedKey) ?? null
  const top = pinned ?? all.reduce((a, b) => (b.limit.percent > a.limit.percent ? b : a))

  return (
    <Popover.Root
      onOpenChange={(open) => {
        // Someone's looking — nudge a background refresh (the server ignores
        // it within a minute of the last one); updated numbers arrive on the
        // pushed snapshot.
        if (open) void requestUsageRefresh().catch(() => { /* best-effort */ })
      }}
    >
      <Popover.Trigger
        aria-label="Show plan usage"
        className={clsx(
          'flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-xs font-medium transition',
          TONE_TRIGGER[usageTone(top.limit)],
        )}
      >
        <UsageIcon size={11} />
        {pinned && <span className="font-normal opacity-80">{pillTag(pinned.limit, pinned.tool)}</span>}
        {Math.round(top.limit.percent)}%
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4}>
          <Popover.Popup className="w-64 rounded-lg border border-border bg-surface-2 p-1 text-text
            shadow-[0_12px_32px_rgba(0,0,0,0.5)] outline-none transition-opacity duration-100
            data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
            <div className="px-2 pb-0.5 pt-1">
              <span className="text-[11px] font-medium text-text-faint">Plan usage</span>
            </div>
            {sections.map((section) => {
              const plan = planLabel(section.subscriptionType, section.rateLimitTier)
              return (
                <div key={section.tool} className="pb-0.5">
                  <div className="flex items-baseline px-2 pt-1">
                    <span className="text-[11px] font-medium text-text-dim">{TOOL_LABEL[section.tool]}</span>
                    {plan && (
                      <span className="ml-auto text-[11px] text-text-faint/70">{plan}</span>
                    )}
                  </div>
                  <ul className="flex flex-col gap-0.5 px-1 pb-1">
                    {section.limits.map((limit) => {
                      const key = metricKey(section.tool, limit)
                      return (
                        <LimitRow
                          key={key}
                          limit={limit}
                          tool={section.tool}
                          pinned={pinned !== null && key === pinnedKey}
                          onToggle={() => setPinnedUsageMetric(pinnedKey === key ? null : key)}
                        />
                      )
                    })}
                  </ul>
                </div>
              )
            })}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function LimitRow({
  limit,
  tool,
  pinned,
  onToggle,
}: {
  limit: PlanUsageLimit
  tool: AgentTool
  pinned: boolean
  onToggle: () => void
}): JSX.Element {
  const reset = resetsLabel(limit.resetsAt)
  const label = limitLabel(limit, tool)
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={pinned}
        aria-label={`${pinned ? 'Unpin' : 'Pin'} ${TOOL_LABEL[tool]} ${label}`}
        title={pinned ? 'Unpin from the sidebar pill' : 'Pin to the sidebar pill'}
        className="group/pin flex w-full flex-col gap-1 rounded px-1.5 py-1 text-left outline-none
          transition hover:bg-surface-3"
      >
        <span className="flex items-center gap-1.5 text-xs">
          <span className="truncate text-text-dim">{label}</span>
          <PinIcon
            size={10}
            // Filled when pinned, so the marker reads at 10px; unpinned rows
            // only hint the affordance on hover.
            fill={pinned ? 'currentColor' : 'none'}
            className={clsx(
              'shrink-0',
              pinned
                ? 'text-text-dim'
                : 'text-text-faint opacity-0 transition-opacity group-hover/pin:opacity-100',
            )}
          />
          <span className="ml-auto shrink-0 font-medium">{Math.round(limit.percent)}%</span>
        </span>
        <span className="h-1 w-full overflow-hidden rounded-full bg-surface-3">
          <span
            className={clsx('block h-full rounded-full', TONE_BAR[usageTone(limit)])}
            style={{ width: `${Math.min(100, Math.max(0, limit.percent))}%` }}
          />
        </span>
        {reset && <span className="text-[11px] text-text-faint">{reset}</span>}
      </button>
    </li>
  )
}
