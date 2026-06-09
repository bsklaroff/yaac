/**
 * Centralized icon set. Everything imports icons from here under semantic
 * names, so the underlying library (Central Icons — round-filled, radius-3,
 * stroke-2) is referenced in exactly one place. Icons take a `size` prop
 * and inherit `currentColor`, so text-* utilities color them.
 */
import {
  IconClaudeai,
  IconOpenaiCodex,
  IconOpencode,
} from '@central-icons-react/round-filled-radius-3-stroke-2'
import type { CentralIconBaseProps } from '@central-icons-react/round-filled-radius-3-stroke-2'
import type { FC } from 'react'
import type { AgentTool } from '@/shared/types'

export {
  IconConsole as TerminalIcon,
  IconFolders as ProjectsIcon,
  IconPlusMedium as AddIcon,
  IconSettingsGear2 as SettingsIcon,
  IconDotGrid1x3Horizontal as MoreIcon,
  IconArrowsRepeat as RestartIcon,
  IconTrashCan as DeleteIcon,
  IconCircleBanSign as BlockedIcon,
} from '@central-icons-react/round-filled-radius-3-stroke-2'

/** Brand glyph per agent tool. */
export const TOOL_ICON: Record<AgentTool, FC<CentralIconBaseProps>> = {
  claude: IconClaudeai,
  codex: IconOpenaiCodex,
  opencode: IconOpencode,
}
