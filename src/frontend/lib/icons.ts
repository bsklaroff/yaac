/**
 * Centralized icon set. Everything imports icons from here under semantic
 * names, so the underlying library is referenced in exactly one place.
 * Backed by lucide-react (free, open-source). Icons take a `size` prop and
 * inherit `currentColor`, so text-* utilities color them.
 *
 * (A Central Icons variant — round-filled, with real brand glyphs — is kept
 * on the `claude/central-icons-ref` branch for reference; it depends on a
 * gated paid package, so it can't be the default.)
 */
import {
  Terminal,
  Folders,
  Plus,
  Settings,
  Ellipsis,
  RotateCw,
  Trash2,
  Ban,
  LoaderCircle,
  ChevronRight,
  X,
  Sparkles,
  Bot,
  Code,
  type LucideIcon,
} from 'lucide-react'
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
}

/**
 * Per-tool glyph. lucide has no brand marks, so each tool gets a distinct
 * generic icon (Central Icons had the real Claude/OpenAI/OpenCode logos).
 */
export const TOOL_ICON: Record<AgentTool, LucideIcon> = {
  claude: Sparkles,
  codex: Bot,
  opencode: Code,
}
