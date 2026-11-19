import { useId, type JSX } from 'react'
import { cn } from './cn'

/* The yaac mark's four strokes, from the outer left to the outer right. */
const STROKES = [
  '-67.5,133 -67.5,13.9 -68.6,5.9 -71.8,-1.5 -76.9,-7.8 -81.2,-11.2 -88.5,-14.6 -93.8,-15.8 -119.5,-16',
  '-22.5,175 -22.5,-1 -22.9,-6.5 -23.8,-11.9 -25.2,-17.2 -27.2,-22.3 -29.6,-27.3 -32.5,-31.9 -35.8,-36.3 '
    + '-39.6,-40.3 -43.7,-43.9 -75.2,-66.1 -93.2,-78.7 -97.6,-82 -101.7,-85.6 -105.5,-89.6 -108.9,-93.9 -112,-98.5 '
    + '-114.6,-103.3 -116.8,-108.4 -118.6,-113.6 -119.9,-118.9 -120.8,-124.3 -121.2,-135.3 -121.2,-165.6',
  '22.5,175 22.5,-1 22.9,-6.5 23.8,-11.9 25.2,-17.2 27.2,-22.3 29.6,-27.3 32.5,-31.9 35.8,-36.3 39.6,-40.3 '
    + '43.7,-43.9 75.2,-66.1 93.2,-78.7 97.6,-82 101.7,-85.6 105.5,-89.6 108.9,-93.9 112,-98.5 114.6,-103.3 '
    + '116.8,-108.4 118.6,-113.6 119.9,-118.9 120.8,-124.3 121.2,-135.3 121.2,-165.6',
  '67.5,133 67.5,13.9 68.6,5.9 71.8,-1.5 76.9,-7.8 81.2,-11.2 88.5,-14.6 93.8,-15.8 119.5,-16',
]

/* The logo's own colours (logo.svg), one per stroke, for the multicolour mark. */
const MARK_COLOURS = ['#ff8a82', '#f29852', '#6bc87f', '#ad9eff']

/**
 * The yaac mark in currentColor. `animation` lights the mark over a faint
 * copy of it: `draw` and `step` draw the strokes in turn, left to right
 * (the loader and the working status), and `rise` moves soft bands of
 * light steadily up the whole mark over a less faint copy (background
 * work). Like the rail's lanes, these keep moving under the OS's
 * reduced-motion setting: the motion is how a status says something is
 * running, not decoration. Without `animation` the mark is still, and
 * `colour` paints each stroke its logo colour.
 */
export function YLogoMark({ height, animation, colour = false, className }: {
  height: number
  animation?: 'draw' | 'step' | 'rise'
  colour?: boolean
  className?: string
}): JSX.Element {
  const stroke = (i: number): string => (colour ? MARK_COLOURS[i] : 'currentColor')
  const clip = useId()
  const mask = useId()
  const band = useId()
  return (
    <svg
      viewBox="-138.2 -150.3 276.4 325.3"
      width={Math.round(height * 0.85)}
      height={height}
      aria-hidden="true"
      className={cn('block shrink-0 overflow-visible', className)}
    >
      {/* The inner strokes run past the top edge; the clip cuts them flat. */}
      <defs>
        <clipPath id={clip}><rect x="-198.2" y="-150.3" width="396.4" height="385.3" /></clipPath>
        {animation === 'rise' && (
          <>
            {/* Two bands, each the mark's height, lit in the middle and
                dark for a short stretch at both ends, so sliding up by one
                band loops without a seam. */}
            <linearGradient id={band} x1="0" y1="0" x2="0" y2="1">
              {[0, 0.06, 0.25, 0.44, 0.56, 0.75, 0.94, 1].map((offset) => (
                <stop key={offset} offset={offset} stopColor="white" stopOpacity={offset === 0.25 || offset === 0.75 ? 1 : 0} />
              ))}
            </linearGradient>
            <mask id={mask}>
              <rect x="-198.2" y="-150.3" width="396.4" height="650.6" fill={`url(#${band})`} className="animate-logo-rise"
                style={{ transformBox: 'fill-box' }} />
            </mask>
          </>
        )}
      </defs>
      <g clipPath={`url(#${clip})`} fill="none" strokeWidth={34} strokeLinejoin="miter">
        {STROKES.map((points, i) => (
          <polyline key={`b${i}`} points={points} stroke={stroke(i)} opacity={animation === 'rise' ? 0.3 : animation ? 0.18 : 1} />
        ))}
        {animation === 'rise' && (
          <g mask={`url(#${mask})`}>
            {STROKES.map((points, i) => <polyline key={i} points={points} stroke={stroke(i)} />)}
          </g>
        )}
        {(animation === 'draw' || animation === 'step') && STROKES.map((points, i) => (
          <polyline
            key={i}
            points={points}
            stroke={stroke(i)}
            pathLength={1}
            className={animation === 'draw' ? 'animate-logo-draw' : 'animate-logo-step'}
            style={{ strokeDasharray: '1 1.1', strokeDashoffset: 1.05, animationDelay: `${i * 0.18}s` }}
          />
        ))}
      </g>
    </svg>
  )
}
