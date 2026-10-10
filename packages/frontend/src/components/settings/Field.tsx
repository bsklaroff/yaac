import type { JSX, ReactNode } from 'react'

/** A labeled settings field: small bold label, dim hint, then the control. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: JSX.Element }): JSX.Element {
  return (
    <div className="mt-6">
      <div className="text-xs font-medium text-text">{label}</div>
      {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">{hint}</p>}
      <div className="mt-2">{children}</div>
    </div>
  )
}

/** A small uppercase heading over a list of settings rows. */
export function SectionLabel({ children }: { children: ReactNode }): JSX.Element {
  return <div className="text-[10px] font-semibold uppercase tracking-wider text-text-faint">{children}</div>
}
