import { useEffect, type RefObject } from 'react'
import type { ITheme, Terminal } from '@xterm/xterm'
import { useUiStore } from '#lib/store'
import { resolveEffectiveTheme } from '#lib/theme'

/**
 * xterm palettes per app theme. Background and foreground match
 * --color-sunken / --color-text in index.css so the terminal blends with its
 * wrapper. The dark palette keeps xterm's default ANSI colors; the light one
 * supplies its own, since the defaults wash out on a light background.
 */
const DARK: ITheme = {
  background: '#1B1B1E',
  foreground: '#F2F2F1',
  selectionBackground: '#3a3d4d',
}

const LIGHT: ITheme = {
  background: '#F6F6F5',
  foreground: '#171717',
  cursor: '#171717',
  cursorAccent: '#F6F6F5',
  selectionBackground: '#b9c6d6',
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
  brightYellow: '#946300',
  brightBlue: '#0550ae',
  brightMagenta: '#6639ba',
  brightCyan: '#1f7a91',
  brightWhite: '#24292f',
}

/** The xterm theme for the effective app theme. */
export function terminalTheme(): ITheme {
  return resolveEffectiveTheme() === 'light' ? LIGHT : DARK
}

/**
 * Keep a terminal's palette on the app theme: themePref for the user's
 * choice, matchMedia for the OS switching while on 'system'. Call it after
 * the effect that creates the terminal, so the first apply finds it.
 */
export function useTerminalTheme(termRef: RefObject<Terminal | null>): void {
  const themePref = useUiStore((s) => s.themePref)
  useEffect(() => {
    const apply = (): void => {
      if (termRef.current) termRef.current.options.theme = terminalTheme()
    }
    apply()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [termRef, themePref])
}
