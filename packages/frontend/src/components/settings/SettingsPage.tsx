import type { JSX, ReactNode } from 'react'

/**
 * The head of a settings page: its title and what the page is for. The
 * settings dialog lays its pages out in a `YPageBody`, so a page renders
 * this and then its sections and setting groups as siblings.
 */
export function SettingsPageTitle({ title, children }: { title: ReactNode; children?: ReactNode }): JSX.Element {
  return (
    <header>
      <h2 className="text-lg font-semibold text-text">{title}</h2>
      {children && <div className="mt-1 text-md text-muted">{children}</div>}
    </header>
  )
}
