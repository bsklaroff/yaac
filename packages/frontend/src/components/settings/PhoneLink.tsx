import type { JSX } from 'react'
import { encode } from 'uqr'
import { Field } from '#components/settings/Field'

/**
 * The link the iPhone app opens to add this server (ios/README.md). It is
 * in the app's own scheme, so the system Camera app offers to open it in
 * the app rather than in Safari. Only an https origin gets one: a phone
 * reaches a server through `tailscale serve`, which is https, and a
 * loopback origin names the machine the browser runs on.
 */
export function phoneLink(origin: string): string | null {
  if (!origin.startsWith('https://')) return null
  return `yaac://connect?origin=${encodeURIComponent(origin)}`
}

/** Settings → General's QR code of `phoneLink`, absent where there is none. */
export function PhoneLinkField(): JSX.Element | null {
  const link = phoneLink(window.location.origin)
  if (!link) return null
  return (
    <Field
      label="Open on your phone"
      hint="Scan with the iPhone camera to add this server to the yaac app. The phone must be on your tailnet."
    >
      <QrCode text={link} />
    </Field>
  )
}

/** Black on white whatever the theme, since scanners expect dark modules. */
function QrCode({ text }: { text: string }): JSX.Element {
  const { data, size } = encode(text, { border: 2 })
  const path = data.flatMap((row, y) => row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : ''))).join('')
  return (
    <svg
      role="img"
      aria-label={`QR code for ${text}`}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="h-40 w-40 rounded-md"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}
