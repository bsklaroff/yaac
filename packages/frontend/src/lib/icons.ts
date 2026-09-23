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
  FolderPlus as GroupAddIcon,
  FolderMinus as GroupRemoveIcon,
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
  Globe as PreviewIcon,
  ArrowLeft as NavBackIcon,
  ArrowRight as NavForwardIcon,
  RefreshCw as ReloadIcon,
  House as HomeIcon,
  Copy as CopyIcon,
  Inspect as DevToolsIcon,
  Smartphone as MobileIcon,
  Tablet as TabletIcon,
  Monitor as DesktopIcon,
  FileDiff as ChangesIcon,
  Search as SearchIcon,
  Sparkles as SkillsIcon,
  Server as ServerIcon,
  Plug as PortIcon,
  FolderTree as FilesIcon,
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  File as FileIcon,
  FilePen as OpenFileIcon,
  FilePlus as NewFileIcon,
  FolderPlus as NewFolderIcon,
  Eye as ShowIcon,
  EyeOff as HideIcon,
  Link2 as SymlinkIcon,
  Save as SaveIcon,
  CaseSensitive as MatchCaseIcon,
  WholeWord as WholeWordIcon,
  Regex as RegexIcon,
  Replace as ReplaceIcon,
  ReplaceAll as ReplaceAllIcon,
  ArrowUp as PrevMatchIcon,
  ArrowDown as NextMatchIcon,
  ALargeSmall as TextSizeIcon,
  Minus as MinusIcon,
  FileCode as FileCodeIcon,
  FileBraces as FileJsonIcon,
  FileText as FileTextIcon,
  FileImage as FileImageIcon,
  FileCog as FileConfigIcon,
  FileTerminal as FileShellIcon,
  ChevronsDownUp as CollapseAllIcon,
} from 'lucide-react'

/** Display name per agent tool (proper brand casing, incl. OpenCode). */
export const TOOL_LABEL: Record<AgentTool, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
}
