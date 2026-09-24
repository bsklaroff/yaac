/** The buttons of Settings → Credentials and the git credential picker it
 *  shares. An action that starts or completes something is a small chip; a
 *  row's own actions (sign out, replace, delete, change, view, copy) are
 *  text, so a list of rows does not read as a wall of buttons. */
export const BUTTON = 'w-fit shrink-0 rounded-md bg-surface-3 px-2.5 py-0.5 text-[11px] font-medium text-text '
  + 'transition hover:bg-border-strong disabled:opacity-50'
export const TEXT_BUTTON = 'shrink-0 rounded px-1.5 py-0.5 text-[11px] text-text-faint transition hover:text-text '
  + 'disabled:opacity-50'
