/**
 * Centralized icon set. Everything imports icons from here under semantic
 * names, so the underlying library (Central Icons — round-filled, radius-3,
 * stroke-2) is referenced in exactly one place. Icons take a `size` prop
 * and inherit `currentColor`, so text-* utilities color them.
 */
export {
  IconConsole as TerminalIcon,
  IconFolders as ProjectsIcon,
  IconPlusMedium as AddIcon,
  IconSettingsGear2 as SettingsIcon,
  IconCircleDotsCenter1 as MoreIcon,
  IconArrowsRepeat as RestartIcon,
  IconTrashCan as DeleteIcon,
} from '@central-icons-react/round-filled-radius-3-stroke-2'
