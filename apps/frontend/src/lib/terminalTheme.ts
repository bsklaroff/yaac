import type { ITheme } from '@xterm/xterm'

/**
 * xterm palettes per app theme. Background/foreground mirror --color-bg /
 * --color-text in index.css for each theme, so the terminal is
 * seamless with its wrapper (also bg-bg) — a dark terminal on the dark shell,
 * a light one on the light shell. The dark palette keeps xterm's default ANSI
 * colors (they read well on dark); the light one supplies a light-tuned ANSI
 * set (the defaults' bright colors wash out on a light background).
 */
const DARK: ITheme = {
  background: '#0b0b0d',
  foreground: '#e7e7ea',
  selectionBackground: '#3a3d4d',
}

const LIGHT: ITheme = {
  background: '#eeedec',
  foreground: '#323130',
  cursor: '#323130',
  cursorAccent: '#eeedec',
  selectionBackground: '#cdd6e0',
  black: '#24292e',
  red: '#cf222e',
  green: '#116329',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#bf8700',
  brightBlue: '#0550ae',
  brightMagenta: '#6639ba',
  brightCyan: '#3192aa',
  brightWhite: '#24292f',
}

/** The xterm theme for the effective app theme. */
export function terminalTheme(effective: 'light' | 'dark'): ITheme {
  return effective === 'light' ? LIGHT : DARK
}
