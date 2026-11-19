import type { JSX, ReactNode } from 'react'

/* The catalog page's layout: a titled section, and a named item in it. */

export function Section({ title, note, children }: { title: string; note: string; children: ReactNode }): JSX.Element {
  return (
    <section className="border-b border-line px-12 py-8">
      <h2 className="flex items-baseline gap-3 text-lg font-semibold">
        {title}<span className="text-sm font-normal text-subtle">{note}</span>
      </h2>
      <div className="mt-6 flex flex-wrap items-start gap-x-10 gap-y-8">{children}</div>
    </section>
  )
}

export function Item({ name, children, wide = false }: { name: string; children: ReactNode; wide?: boolean }): JSX.Element {
  return (
    <div className={wide ? 'w-full' : undefined}>
      <div className="mb-3 text-sm text-subtle">{name}</div>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  )
}
