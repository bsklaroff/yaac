/**
 * Centralized icon set. Everything imports icons from here under semantic
 * names, so the underlying library is referenced in exactly one place.
 * Backed by lucide-react (free, open-source). Icons take a `size` prop and
 * inherit `currentColor`, so text-* utilities color them.
 *
 * (A Central Icons variant — round-filled, with real brand glyphs — is kept
 * on the `claude/central-icons-ref` branch for reference; it depends on a
 * gated paid package, so it can't be the default. Agent tools are now shown
 * by name rather than a glyph, since lucide has no brand marks.)
 */
import type { AgentTool } from '@/shared/types'

export {
  Terminal as TerminalIcon,
  Folders as ProjectsIcon,
  Plus as AddIcon,
  Settings as SettingsIcon,
  Ellipsis as MoreIcon,
  RotateCw as RestartIcon,
  Trash2 as DeleteIcon,
  Ban as BlockedIcon,
  LoaderCircle as LoadingIcon,
  ChevronRight as ChevronIcon,
  X as CloseIcon,
  KeyRound as KeyIcon,
  SlidersHorizontal as GeneralIcon,
} from 'lucide-react'

/** Display name per agent tool (proper brand casing, incl. OpenCode). */
export const TOOL_LABEL: Record<AgentTool, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
}
