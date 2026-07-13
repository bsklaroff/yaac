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
import type { AgentTool } from '@yaac/shared/types'

export {
  Terminal as TerminalIcon,
  Folders as ProjectsIcon,
  Plus as AddIcon,
  Settings as SettingsIcon,
  Ellipsis as MoreIcon,
  Gauge as UsageIcon,
  Pin as PinIcon,
  RotateCw as RestartIcon,
  Trash2 as DeleteIcon,
  Ban as BlockedIcon,
  Check as CheckIcon,
  TriangleAlert as WarningIcon,
  LoaderCircle as LoadingIcon,
  ChevronRight as ChevronIcon,
  X as CloseIcon,
  KeyRound as KeyIcon,
  Keyboard as KeyboardIcon,
  SlidersHorizontal as GeneralIcon,
  FileCog as ProjectConfigIcon,
  Container as DockerIcon,
  Pencil as RenameIcon,
  PanelLeft as SidebarIcon,
  LayoutGrid as TilesIcon,
  GalleryHorizontal as TabsIcon,
  Columns2 as SplitRightIcon,
  Rows2 as SplitDownIcon,
  ExternalLink as OpenLinkIcon,
  Maximize2 as ExpandIcon,
  Minimize2 as CollapseIcon,
  GitBranch as BranchIcon,
} from 'lucide-react'

/** Display name per agent tool (proper brand casing, incl. OpenCode). */
export const TOOL_LABEL: Record<AgentTool, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
}
