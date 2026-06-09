import type { JSX } from 'react'
import clsx from 'clsx'
import { NewProjectButton } from '@/frontend/components/NewProjectButton'
import { SettingsButton } from '@/frontend/components/SettingsButton'
import type { ProjectSummary } from '@/shared/types'

/**
 * Deterministic per-project identity color from the slug. OKLCH (not HSL)
 * so every hue reads at the same perceived lightness/chroma — no hue is
 * harshly bright or muddy — with chroma/lightness tuned to sit calmly in
 * the muted dark palette. The hue is quantized to 24 evenly-spaced steps
 * to keep adjacent projects visually distinct.
 */
function projectColor(slug: string): string {
  let h = 0
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0
  const hue = (h % 24) * 15
  return `oklch(0.74 0.115 ${hue})`
}

function projectInitial(slug: string): string {
  const c = slug.replace(/[^a-z0-9]/gi, '')[0]
  return (c ?? '?').toUpperCase()
}

/**
 * Discord/Slack-style left rail of projects — the top-level navigation
 * axis. The active project scopes the sidebar; a project with sessions
 * awaiting input shows an attention badge so "which project needs me" is
 * visible before drilling in.
 */
export function ProjectRail({
  projects,
  activeProjectSlug,
  attentionBySlug,
  onSelect,
}: {
  projects: ProjectSummary[]
  activeProjectSlug: string | null
  attentionBySlug: Record<string, number>
  onSelect: (slug: string) => void
}): JSX.Element {
  return (
    <div className="flex w-10 shrink-0 flex-col items-center gap-2 py-3">
      {projects.map((p) => {
        const active = p.slug === activeProjectSlug
        const color = projectColor(p.slug)
        const waiting = attentionBySlug[p.slug] ?? 0
        return (
          <button
            key={p.slug}
            onClick={() => onSelect(p.slug)}
            className="group relative flex items-center justify-center"
            title={p.slug}
          >
            <span
              className={clsx(
                'absolute left-0 -ml-1.5 w-0.5 rounded-r-full bg-text transition-all',
                active ? 'h-5' : 'h-0 group-hover:h-3',
              )}
            />
            <span
              className={clsx(
                'flex h-7 w-7 items-center justify-center text-[13px] font-semibold transition-all',
                active ? 'rounded-lg' : 'rounded-2xl group-hover:rounded-lg',
              )}
              // Quiet identity treatment: a dark tint of the project hue for
              // the fill, a light pastel of it for the initial — active just
              // steps both up rather than going to a loud solid fill.
              style={{
                background: active
                  ? `color-mix(in oklab, ${color} 26%, var(--color-surface-2))`
                  : `color-mix(in oklab, ${color} 12%, var(--color-surface-2))`,
                color: active
                  ? `color-mix(in oklab, ${color} 40%, var(--color-text))`
                  : `color-mix(in oklab, ${color} 45%, var(--color-text-dim))`,
              }}
            >
              {projectInitial(p.slug)}
            </span>
            {waiting > 0 && (
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-base" />
            )}
          </button>
        )
      })}

      <div className="my-1 h-px w-6 bg-border" />
      <NewProjectButton />

      <div className="flex-1" />
      <SettingsButton />
    </div>
  )
}
