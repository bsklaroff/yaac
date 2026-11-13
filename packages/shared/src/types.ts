import { z } from 'zod'
import type { StepGraph, StepsOutcome, WorkspaceStep } from './steps'
import {
  CUSTOM_PROVIDER,
  isApiKeyTool,
  parseOmpProvider,
  parseOpencodeProvider,
  parsePiProvider,
  ENDPOINT_EFFORTS,
  type ApiKeyTool,
  type CustomEndpoint,
  type EndpointModel,
  type OmpProvider,
  type OpencodeProvider,
  type PiProvider,
} from '#tool-providers'
import type { ModelEfforts } from '#tool-providers.generated'
import type { ErrorCode } from '#errors'

export type { ModelEfforts }

export type AgentTool = 'claude' | 'codex' | 'opencode' | 'pi' | 'omp'

export const AGENT_TOOLS: readonly AgentTool[] = ['claude', 'codex', 'opencode', 'pi', 'omp']

/** Each tool's product name, for messages that name it in full. */
export const TOOL_LABELS: Record<AgentTool, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
  omp: 'Oh My Pi',
}

/**
 * The tools that choose their own conversation ids. claude and pi launch
 * under an id yaac picks (the workspace id, for a create), but codex,
 * opencode and omp take none, so the recorded id is a stand-in until the
 * pane reports the real one.
 */
export const SELF_NAMING_TOOLS: readonly AgentTool[] = ['codex', 'opencode', 'omp']

/**
 * Coerce a raw tool name into an `AgentTool`, defaulting to claude.
 *
 * Defaults rather than rejects, because a workspace stamped with a tool this
 * build doesn't know must still render and accept exec. What a workspace
 * declared is available as `RuntimeHandle.declaredTool`.
 */
export function normalizeTool(raw: string | undefined): AgentTool {
  return AGENT_TOOLS.includes(raw as AgentTool) ? raw as AgentTool : 'claude'
}

/**
 * Allowed shape for a `--model` override. The value is embedded bare in
 * single-quoted `respawn-window '<cmd>'` launch commands (see buildAgentCmd),
 * so it allows no quotes, whitespace or shell metacharacters. Model ids,
 * aliases and `provider/model` paths never need them.
 */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/

/**
 * The suffix claude puts on a model id to run it with a 1M-token context
 * (`claude-opus-5-5[1m]`). A restart keeps it on a claude model it relaunches,
 * so the launch double-quotes such a model (`claudeModelArg`), since a bare
 * `[1m]` is a shell glob.
 */
export const CLAUDE_1M_SUFFIX = '[1m]'

/**
 * `model` as a launch of `tool` can carry it, or undefined. It must match
 * `MODEL_RE` once a bracketed suffix is dropped (codex-acp reports its effort
 * as `[medium]`), except that a claude model keeps `CLAUDE_1M_SUFFIX`, since
 * dropping it would put a long conversation back on a 200K context. A model
 * an agent reported comes from a pane option anything in the workspace can
 * set, so it passes through here before any launch names it.
 */
export function launchableModel(tool: AgentTool, model: string): string | undefined {
  const long = tool === 'claude' && model.endsWith(CLAUDE_1M_SUFFIX)
  const base = long ? model.slice(0, -CLAUDE_1M_SUFFIX.length) : model.replace(/\[[^\]]*\]$/, '')
  return MODEL_RE.test(base) ? `${base}${long ? CLAUDE_1M_SUFFIX : ''}` : undefined
}

/**
 * An effort level, in the tool's own words (`high`, `xhigh`, opencode's
 * `default`). Embedded bare in launch commands like a model, so it is one
 * lowercase word (docs/effort-levels.md).
 */
export const EFFORT_RE = /^[a-z]+$/
export const effortSchema = z.string().regex(EFFORT_RE).max(32)

/** How each tool's effort words read in a menu. Anything else shows as is. */
const EFFORT_COPY: Record<string, string> = {
  default: 'Default',
  none: 'None',
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
  thinking: 'Thinking',
}

export function effortLabel(effort: string): string {
  return EFFORT_COPY[effort] ?? effort
}

/**
 * The effort to launch a model at: `wanted` where the model has it, else
 * the model's default. A model whose levels are unknown (not in the
 * catalog) takes `wanted` as is, since only the tool can judge it.
 */
export function effortFor(efforts: ModelEfforts | undefined, wanted: string | undefined): string | undefined {
  if (efforts === undefined) return wanted
  return wanted !== undefined && efforts.levels.includes(wanted) ? wanted : efforts.default
}

/**
 * An agent conversation id from outside the server, checked before it is
 * joined into a path (`acp/<ws>/<id>.jsonl`) or a launch command
 * (`--resume <id>`). It must start with a letter or digit so it can't be read
 * as a flag. Fits UUIDs (claude, codex, pi) and opencode's `ses_…` ids.
 */
export const conversationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)

/**
 * How yaac drives a conversation, and so how the webapp renders it
 * (docs/agent-modes.md). Independent of `AgentTool`.
 *
 * - `tui`  the agent's own terminal UI under tmux; the server observes it
 *          through tmux control mode and the browser attaches a PTY.
 * - `acp`  the agent speaks the Agent Client Protocol (JSON-RPC over stdio)
 *          to the server, which renders a chat pane.
 *
 * Both run the agent in a tmux window.
 */
export type AgentMode = 'tui' | 'acp'

export const AGENT_MODES: readonly AgentMode[] = ['tui', 'acp']

/** The mode a create uses when neither the request nor the project's
 *  remembered choice for the tool names one. */
export const DEFAULT_AGENT_MODE: AgentMode = 'acp'

/** claude's `AGENT_CLIS.claude.binarySha256`, typed to be looked up by any
 *  platform name. */
const CLAUDE_BINARY_SHA256: Partial<Record<string, string>> = {
  'darwin-arm64': 'abc9feeeca8091d51b623291e044cf0528c2f6b74e0c1d6ef671d52c73f7cd3c',
  'darwin-x64': 'f4e04d8726ee1343999679ad745eca2f6d263c2941f132b1fdca4283ee6d5f02',
  'linux-arm64': '6bea0633074627ba79328e00115ed0588c3acf906a8463612b25db696dbfd3f0',
  'linux-x64': '426c33815ca6645a772f722fbff10dbf2cbdb124a8aeab733c1365dbf8bbf61f',
  'linux-arm64-musl': 'd223ea603b4fe8521d35a47f1972fbb36f1028a40927f16160e6258e0b92d597',
  'linux-x64-musl': 'efc4a3d94daf10c550cde589a4add37f67519be54252ba88f27e9627f7ad62b4',
}

/**
 * Each tool's agent CLI, pinned. `dockerfiles/Dockerfile.tools` installs the
 * same versions (a test checks) and so does a host install.
 *
 * yaac launches permission postures and effort levels as each CLI's flags
 * or config and reads the CLI's reports back (docs/permission-modes.md,
 * docs/effort-levels.md). A release that changes either can fail silently,
 * so bump a version only after re-checking both against the new binary.
 * Bump the matching `ACP_ADAPTERS` entry with it, since codex-acp and pi-acp
 * depend on their CLI's version. Then run `pnpm gen:providers`: the claude
 * catalog and every tool's effort levels are read from the pinned CLIs.
 * For codex, also check that its TUI offers no `create_worktree` tool
 * (`codexLaunchConfig`), which no test covers.
 *
 * The auth daemon's Install button and the workspace image run only what
 * matches a SHA-256 pinned here, since release assets can be replaced in
 * place. Bump the sums with the version:
 *
 * - `binarySha256`: claude's release binary per platform, the `checksum`s in
 *   `https://downloads.claude.ai/claude-code-releases/<version>/manifest.json`.
 * - `installScriptSha256`: the `install.sh` asset of codex's release
 *   (`curl -fsSL <url> | shasum -a 256`).
 */
export const AGENT_CLIS = {
  claude: {
    package: '@anthropic-ai/claude-code',
    version: '2.1.321',
    binarySha256: CLAUDE_BINARY_SHA256,
  },
  codex: {
    package: '@openai/codex',
    version: '0.166.0',
    installScriptSha256: '44ac252c1b9a68c02bdf0de8e1c6cbfde36fc1afa8684624962eae7d4c461e70',
  },
  opencode: { package: '@opencode/cli', version: '2.2.6' },
  pi: { package: '@earendil-works/pi-coding-agent', version: '1.5.1' },
  omp: { package: '@oh-my-pi/pi-coding-agent', version: '18.18.6' },
} as const satisfies Record<AgentTool, {
  package: string
  version: string
  binarySha256?: typeof CLAUDE_BINARY_SHA256
  installScriptSha256?: string
}>

/**
 * The bun omp runs under: its `omp` is a bun script (`#!/usr/bin/env bun`).
 * Installed from npm beside the agents, by the image and on a host, with its
 * install script, which puts the platform's binary in place.
 */
export const BUN_RUNTIME = { package: 'bun', version: '1.4.4' } as const

/**
 * The ACP adapter each tool uses in `acp` mode. The image install steps, the
 * host preflight and the driver's launch profiles all derive from this.
 *
 * `needsCli`: the adapter drives the CLI (codex-acp runs `codex app-server`,
 * pi-acp runs `pi --mode rpc`), so the CLI must be on PATH. claude's adapter
 * bundles its own SDK; opencode's and omp's adapters are the CLI itself
 * (`opencode acp`, `omp acp`).
 *
 * `verified`: the version whose advertised session modes yaac maps to
 * permission postures. An adapter that drops a mode fails silently, so a
 * test ties this to `dockerfiles/Dockerfile.tools`, and host installs use it.
 */
export const ACP_ADAPTERS = {
  claude: {
    binary: 'claude-agent-acp',
    package: '@agentclientprotocol/claude-agent-acp',
    verified: '0.103.0',
    needsCli: false,
  },
  codex: {
    binary: 'codex-acp',
    package: '@agentclientprotocol/codex-acp',
    verified: '2.6.0',
    needsCli: true,
  },
  opencode: {
    binary: 'opencode',
    package: AGENT_CLIS.opencode.package,
    verified: AGENT_CLIS.opencode.version,
    needsCli: true,
  },
  pi: {
    binary: 'pi-acp',
    package: 'pi-acp',
    verified: '0.0.34',
    needsCli: true,
  },
  omp: {
    binary: 'omp',
    package: AGENT_CLIS.omp.package,
    verified: AGENT_CLIS.omp.version,
    needsCli: true,
  },
} as const satisfies Record<
  AgentTool,
  { binary: string; package: string; verified: string; needsCli: boolean }
>

/**
 * How much the agent may do before it stops to ask: its permission posture
 * (docs/permission-modes.md). Each tool spells it differently (a launch flag
 * for claude and codex, a config block for opencode, nothing for pi).
 *
 * - `bypass`        no prompts. Suits a sandboxed workspace, where the
 *                   sandbox is the containment.
 * - `auto`          no routine prompts; a reviewer model blocks dangerous
 *                   actions. claude gates it by plan and fails in-pane when
 *                   the account is ineligible.
 * - `accept-edits`  file edits in the workspace run unprompted; anything else
 *                   (other shells, out-of-tree paths, network) still asks.
 * - `manual`        every tool use asks first.
 * - `plan`          read and explore only; no edits until a plan is approved.
 * - `read-only`     read freely; every edit and network access asks. codex's
 *                   equivalent of `plan`, enforced by its sandbox.
 *
 * Not every tool has every posture; check `SUPPORTED_PERMISSION_MODES`.
 * There is no "tool default" member, because defaults differ per tool, so a
 * workspace records the posture it actually launched with.
 */
export type PermissionMode = 'bypass' | 'auto' | 'accept-edits' | 'manual' | 'plan' | 'read-only'

/**
 * Postures ranked from most to least permissive. A Record, so a new member
 * can't go unranked. A spawned workspace may be no more permissive than its
 * caller. `plan` and `read-only` tie for strictest.
 */
const PERMISSIVENESS_RANK: Record<PermissionMode, number> = {
  bypass: 0, auto: 1, 'accept-edits': 2, manual: 3, plan: 4, 'read-only': 4,
}

/** Every posture, most permissive first, the order lists display them in. */
export const PERMISSION_MODES: readonly PermissionMode[] = (Object.keys(PERMISSIVENESS_RANK) as PermissionMode[])
  .sort((a, b) => PERMISSIVENESS_RANK[a] - PERMISSIVENESS_RANK[b])

/** Whether `mode` is ranked. A row written by another build may hold one
 *  that isn't. */
export function isRankedPermissionMode(mode: string): boolean {
  return Object.hasOwn(PERMISSIVENESS_RANK, mode)
}

/** Whether `mode` lets an agent do more unasked than `ceiling` does. */
export function morePermissive(mode: PermissionMode, ceiling: PermissionMode): boolean {
  return PERMISSIVENESS_RANK[mode] < PERMISSIVENESS_RANK[ceiling]
}

/** `modes` in hierarchy order, however they were listed. */
function ranked(...modes: PermissionMode[]): readonly PermissionMode[] {
  return PERMISSION_MODES.filter((m) => modes.includes(m))
}

/**
 * Which postures each tool can be launched in. The TUI takes them as CLI
 * flags; in ACP mode they are the adapter's session modes, which cover the
 * same set (runtime/agents/acp-adapters.ts).
 *
 * - claude: all but `read-only`, one `--permission-mode` value each.
 * - codex: four, as an approval-policy × sandbox pair (plus
 *   `--approve-for-me`). No `plan`: codex's plan mode only instructs the
 *   model and no flag launches into it. No `manual`: the pinned codex
 *   accepts only the `on-request` and `never` approval policies.
 * - opencode: no reviewer-model posture, so no `auto`.
 * - pi: no permission system at all, so `bypass` only.
 * - omp: an approval mode per posture (`--approval-mode`) plus its plan
 *   mode; no reviewer model, so no `auto`.
 */
export const SUPPORTED_PERMISSION_MODES: Record<AgentTool, readonly PermissionMode[]> = {
  claude: ranked('bypass', 'auto', 'accept-edits', 'manual', 'plan'),
  codex: ranked('bypass', 'auto', 'accept-edits', 'read-only'),
  opencode: ranked('bypass', 'accept-edits', 'manual', 'plan'),
  pi: ranked('bypass'),
  omp: ranked('bypass', 'accept-edits', 'manual', 'plan'),
}

export function toolSupportsPermissionMode(tool: AgentTool, mode: PermissionMode): boolean {
  return SUPPORTED_PERMISSION_MODES[tool].includes(mode)
}

/**
 * The most permissive posture `tool` offers that is no looser than `mode`.
 * Undefined when it has nothing that strict (a spawn refuses then), or when
 * this build doesn't rank `mode`, which would otherwise match `bypass`.
 */
export function nearestPermissionMode(
  tool: AgentTool,
  mode: PermissionMode,
): PermissionMode | undefined {
  if (!isRankedPermissionMode(mode)) return undefined
  return SUPPORTED_PERMISSION_MODES[tool].find((m) => !morePermissive(m, mode))
}

/** The ranking as shown in refusals: `bypass > … > plan = read-only`. */
const PERMISSION_HIERARCHY = PERMISSION_MODES.map((m, i) =>
  i === 0 ? m : `${morePermissive(PERMISSION_MODES[i - 1], m) ? '>' : '='} ${m}`).join(' ')

/**
 * The permission mode for a workspace an agent creates or queues: the one it
 * named, else the inherited one (the queue parent's, or the caller's), never
 * more permissive than the caller's.
 *
 * A named mode above the ceiling or unsupported by the tool is refused. An
 * inherited one steps down to the nearest supported mode within both limits.
 */
export function agentPermissionMode(
  tool: AgentTool,
  ceiling: PermissionMode,
  requested: PermissionMode | undefined,
  inherited: PermissionMode = ceiling,
): { ok: true; permissionMode: PermissionMode } | { ok: false; error: string } {
  // A row from another build may hold an unknown mode, which cannot be
  // compared safely.
  if (!isRankedPermissionMode(ceiling)) {
    return { ok: false, error: `the caller's ceiling '${ceiling}' is not a permission mode this server knows` }
  }
  if (requested !== undefined) {
    // Otherwise an agent in `plan` could escape it via a sibling.
    if (morePermissive(requested, ceiling)) {
      return {
        ok: false,
        error: `permission mode '${requested}' is more permissive than the caller's ceiling `
          + `('${ceiling}'); a workspace it starts may be granted at most that `
          + `(${PERMISSION_HIERARCHY})`,
      }
    }
    return toolSupportsPermissionMode(tool, requested)
      ? { ok: true, permissionMode: requested }
      : { ok: false, error: `${tool} has no '${requested}' permission mode` }
  }
  const cap = isRankedPermissionMode(inherited) && morePermissive(ceiling, inherited) ? inherited : ceiling
  const stepped = nearestPermissionMode(tool, cap)
  return stepped !== undefined
    ? { ok: true, permissionMode: stepped }
    : {
      ok: false,
      error: `${tool} has no permission mode at or below the caller's ceiling ('${ceiling}')`,
    }
}

/**
 * What to launch `tool` in for a posture it may lack (from another build, a
 * restart, or a remembered choice): the nearest no looser, else the tool's
 * strictest. Never the driver default (`bypass` in a container), so a
 * recorded restriction is kept as far as the tool allows.
 */
export function launchablePermissionMode(tool: AgentTool, mode: PermissionMode): PermissionMode {
  const supported = SUPPORTED_PERMISSION_MODES[tool]
  return nearestPermissionMode(tool, mode) ?? supported[supported.length - 1]
}

/** User-facing labels for each posture. */
export const PERMISSION_MODE_COPY: Record<PermissionMode, string> = {
  bypass: 'Bypass permissions',
  auto: 'Auto permissions',
  'accept-edits': 'Accept edits',
  manual: 'Manual permissions',
  plan: 'Plan mode',
  'read-only': 'Read-only',
}

/**
 * The posture a workspace gets when neither the request nor the project's
 * remembered choice names one. `bypass` in a sandboxed container;
 * `accept-edits` under containerless, where the agent acts as the user on
 * their own machine. pi is always `bypass`, having no permission system.
 */
export function defaultPermissionMode(driver: DriverKind, tool: AgentTool): PermissionMode {
  if (!toolSupportsPermissionMode(tool, 'accept-edits')) return 'bypass'
  return driver === 'containerless' ? 'accept-edits' : 'bypass'
}

/**
 * On/off options a session's agent runs with beside its model, posture and
 * effort, each for the tools that have it (docs/sessions.md, "Agent
 * options"). Both spend tokens while nobody is using the session, so every
 * option is off unless asked for.
 *
 * - `idleCompaction`: claude compacts a long conversation shortly before its
 *   one-hour prompt cache expires, so the next prompt reads a summary rather
 *   than the whole context.
 * - `idleCacheWarming`: pi and omp re-send the last request between turns,
 *   for up to 30 minutes, to keep the prompt cache warm. Warming during a
 *   turn is not affected.
 *
 * `live`: the modes in which a running session's option can change. In the
 * others it is fixed at launch.
 */
export const AGENT_OPTIONS = {
  idleCompaction: {
    tools: ['claude'],
    live: ['acp'],
    label: 'Compact when idle',
    hint: 'Compact a long conversation before its prompt cache expires',
  },
  idleCacheWarming: {
    tools: ['pi', 'omp'],
    live: ['acp', 'tui'],
    label: 'Keep cache warm when idle',
    hint: 'Re-send the last request between turns to keep the prompt cache warm',
  },
} as const satisfies Record<string, { tools: readonly AgentTool[]; live: readonly AgentMode[]; label: string; hint: string }>

export type AgentOption = keyof typeof AGENT_OPTIONS
export const AGENT_OPTION_NAMES = Object.keys(AGENT_OPTIONS) as AgentOption[]
export type AgentOptions = Partial<Record<AgentOption, boolean>>
export const agentOptionsSchema = z.partialRecord(z.enum(AGENT_OPTION_NAMES as [AgentOption, ...AgentOption[]]), z.boolean())

/** The options `tool` has. */
export function toolAgentOptions(tool: AgentTool): AgentOption[] {
  return AGENT_OPTION_NAMES.filter((o) => (AGENT_OPTIONS[o].tools as readonly AgentTool[]).includes(tool))
}

/** Whether a running `mode` session of its tool can change `option`. */
export function agentOptionIsLive(option: AgentOption, mode: AgentMode): boolean {
  return (AGENT_OPTIONS[option].live as readonly AgentMode[]).includes(mode)
}

/**
 * Every option `tool` has, as `wanted` names it, else as `remembered` does,
 * else off. Options the tool lacks are dropped, so a remembered choice for
 * another tool never leaks into this one's launch.
 */
export function resolveAgentOptions(tool: AgentTool, wanted?: AgentOptions, remembered?: AgentOptions): AgentOptions {
  return Object.fromEntries(toolAgentOptions(tool).map((o) => [o, wanted?.[o] ?? remembered?.[o] ?? false]))
}

/**
 * What one agent was last created with in a project
 * (`project_tool_defaults`). Each field is absent until first picked.
 */
export interface ToolCreateDefaults {
  model?: string
  permissionMode?: PermissionMode
  mode?: AgentMode
  effort?: string
  agentOptions?: AgentOptions
}

/**
 * The model, posture, effort and agent options a create for `tool` runs
 * with when the request names none of them: what the project remembers for
 * that agent where it still fits, else the fallback. Both the create form and the
 * server call this, so the form shows what an untouched create would run.
 *
 * A remembered posture the tool lacks goes through
 * `launchablePermissionMode`. A remembered api-key tool's model must name
 * the credential's current provider; any claude or codex model stands, since the
 * catalog is not an allowlist. A remembered effort stands where the model
 * has it, else the model's default; a model with no effort levels gets none.
 */
export function resolveToolCreateDefaults(args: {
  driver: DriverKind
  tool: AgentTool
  remembered: ToolCreateDefaults | undefined
  /** An api-key tool's provider: the one its stored credential authenticates against. */
  provider?: string
  /** What the tool runs when nothing is remembered (`defaultModelFor`). */
  defaultModel: string
  /** A model's effort levels, from the catalog (`ModelOption.efforts`). */
  effortsFor: (model: string) => ModelEfforts | undefined
}): { model: string; permissionMode: PermissionMode; effort?: string; agentOptions: AgentOptions } {
  const { driver, tool, remembered, provider } = args
  const posture = remembered?.permissionMode
  const qualified = isApiKeyTool(tool)
  const rememberedModel = remembered?.model
  const modelFits = rememberedModel !== undefined
    && (!qualified || provider === undefined || rememberedModel.startsWith(`${provider}/`))
  const model = modelFits ? rememberedModel : args.defaultModel
  const efforts = args.effortsFor(model)
  const effort = efforts !== undefined ? effortFor(efforts, remembered?.effort) : undefined
  return {
    model,
    permissionMode: posture !== undefined
      ? launchablePermissionMode(tool, posture)
      : defaultPermissionMode(driver, tool),
    ...(effort !== undefined ? { effort } : {}),
    agentOptions: resolveAgentOptions(tool, undefined, remembered?.agentOptions),
  }
}

export type ToolAuthKind = 'api-key' | 'oauth'

/**
 * Credential kinds `yaac auth fake` can seed: a placeholder credential, never
 * a real secret, so an inner yaac authenticates through the outer yaac's
 * proxy (see packages/server/src/domain/auth/fake-auth.ts). Shared by the
 * CLI's choices and the server route's validator.
 */
export const FAKE_AUTH_KINDS = [
  'claude-oauth',
  'opencode-openrouter',
  'pi-openrouter',
  'omp-openrouter',
  'github',
] as const
export type FakeAuthKind = (typeof FAKE_AUTH_KINDS)[number]

/**
 * Claude Code's native OAuth bundle, under the "claudeAiOauth" key in both
 * Claude's `.credentials.json` and yaac's host-side copy. `refreshToken` and
 * `expiresAt` may be empty when `saveToolAuth` got a bare access token; the
 * proxy refreshes on first use.
 */
export const claudeOAuthBundleSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string(),
  /** Unix epoch in milliseconds. */
  expiresAt: z.number(),
  scopes: z.array(z.string()),
  subscriptionType: z.string().optional(),
})
export type ClaudeOAuthBundle = z.infer<typeof claudeOAuthBundleSchema>

/**
 * Codex's "Sign in with ChatGPT" OAuth bundle, under the "codexOauth" key in
 * yaac's `codex.json`. Holds the parts of Codex's `auth.json` the proxy needs
 * to swap placeholders and refresh.
 */
export const codexOAuthBundleSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** Full signed JWT; an identity assertion, not a bearer credential, so it
   *  goes into the container's auth.json unmodified. */
  idTokenRawJwt: z.string().min(1),
  /** Unix epoch ms from the access token's `exp`, else now + 28d (Codex's
   *  proactive-refresh window). */
  expiresAt: z.number(),
  /** ISO timestamp matching Codex's `last_refresh`. */
  lastRefresh: z.string(),
  /** `tokens.account_id` from Codex's auth.json (not the id_token's
   *  `chatgpt_account_id` claim). Codex sends it as the `ChatGPT-Account-Id`
   *  header, so it reaches the container unchanged. */
  accountId: z.string().optional(),
})
export type CodexOAuthBundle = z.infer<typeof codexOAuthBundleSchema>

/** A stored or submitted api key; the shape every tool accepts. */
const apiKeyCredentialSchema = z.object({
  kind: z.literal('api-key'),
  apiKey: z.string().min(1),
})

const savedAt = z.string()

/**
 * Shape of a user's stored claude sign-in (the server's `tool_credentials`):
 * OAuth with a full bundle, or a single sk-ant-api03-… API key.
 */
export const claudeCredentialsFileSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('oauth'), savedAt, claudeAiOauth: claudeOAuthBundleSchema }),
  apiKeyCredentialSchema.extend({ savedAt }),
])
export type ClaudeCredentialsFile = z.infer<typeof claudeCredentialsFileSchema>

/**
 * Shape of a user's stored codex sign-in (the server's `tool_credentials`):
 * OAuth with a full bundle, or an API key.
 */
export const codexCredentialsFileSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('oauth'), savedAt, codexOauth: codexOAuthBundleSchema }),
  apiKeyCredentialSchema.extend({ savedAt }),
])
export type CodexCredentialsFile = z.infer<typeof codexCredentialsFileSchema>

/** An http(s) URL, as a custom endpoint's base URL. */
const endpointUrlSchema = z.string().trim().max(2000).refine((v) => {
  try {
    return ['http:', 'https:'].includes(new URL(v).protocol)
  } catch {
    return false
  }
}, 'the endpoint must be an http(s) URL')

const endpointEffortSchema = z.enum(ENDPOINT_EFFORTS)

/** One model of a custom endpoint (`EndpointModel`), as stored and sent. */
export const endpointModelSchema = z.object({
  // Each id launches as `custom/<id>`, so it must pass the create form's
  // model check, which also keeps it shell-safe.
  id: z.string().trim().regex(MODEL_RE, 'a model id is letters, digits and . _ : / -, starting with a letter or digit')
    .max(100 - `${CUSTOM_PROVIDER}/`.length),
  name: z.string().trim().min(1).max(200).optional(),
  efforts: z.object({
    levels: z.array(endpointEffortSchema).min(1, 'list at least one level')
      .refine((l) => new Set(l).size === l.length, 'a level is listed twice'),
    default: endpointEffortSchema,
  }).strict().refine((e) => e.levels.includes(e.default), { message: 'the default is not one of the levels', path: ['default'] })
    .optional(),
}).strict()

/** A custom endpoint's model list: at least one, ids unique. */
export const endpointModelsSchema = z.array(endpointModelSchema)
  .min(1, 'list at least one model the endpoint serves')
  .superRefine((models, ctx) => {
    const seen = new Set<string>()
    models.forEach((m, i) => {
      if (seen.has(m.id)) ctx.addIssue({ code: 'custom', message: `"${m.id}" is listed twice`, path: [i, 'id'] })
      seen.add(m.id)
    })
  })

/** The `POST /auth/endpoints` body. `apiKey` may be omitted for an
 *  endpoint that takes none. */
export const customEndpointCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: endpointUrlSchema,
  apiKey: z.string().trim().max(4000).optional(),
  models: endpointModelsSchema,
})
export type CustomEndpointCreate = z.infer<typeof customEndpointCreateSchema>

/** The `PATCH /auth/endpoints/:id` body: what changes. An omitted `apiKey`
 *  keeps the stored one and `''` removes it. */
export const customEndpointPatchSchema = customEndpointCreateSchema.partial()
export type CustomEndpointPatch = z.infer<typeof customEndpointPatchSchema>

/** The `POST /auth/endpoints/discover` body: a URL and key to try, or a
 *  stored endpoint whose URL and key to use. */
export const endpointDiscoverSchema = z.union([
  z.object({ endpointId: z.string().uuid() }).strict(),
  z.object({ baseUrl: endpointUrlSchema, apiKey: z.string().trim().max(4000).optional() }).strict(),
])
export type EndpointDiscoverRequest = z.infer<typeof endpointDiscoverSchema>

/** What an endpoint's `/models` listed: the models it serves, and the ids
 *  left out, each with why. */
export interface EndpointDiscovery {
  models: EndpointModel[]
  skipped: { id: string; reason: string }[]
}

/**
 * A custom sign-in's endpoint inside its credential file: filled in from
 * the endpoint for the runtime, which needs only where to send the key, and
 * written whole (with model ids) by servers that kept the endpoint on the
 * credential (docs/legacy-compat-shims.md).
 */
const embeddedEndpointSchema = z.object({
  baseUrl: endpointUrlSchema,
  models: z.array(z.string()).optional(),
})

/**
 * Shape of a user's stored opencode, pi or omp sign-in (the server's
 * `tool_credentials`): an api key for one provider in the tool's registry
 * (`tool-providers.ts`). `provider` picks the env var and the host the proxy
 * swaps the key on; a sign-in whose provider is missing or unknown fails to
 * parse rather than defaulting, which could send the key to the wrong
 * vendor. The `custom` provider names one of the user's custom endpoints,
 * which holds the URL and key, so its own key is empty.
 */
function apiKeyToolCredentialsFileSchema<P extends string>(parse: (v: string | undefined) => P | undefined) {
  return z.object({
    kind: z.literal('api-key'),
    apiKey: z.string(),
    savedAt,
    provider: z.custom<P>(
      (v) => typeof v === 'string' && parse(v) !== undefined,
      'provider is missing or not in this build\'s registry',
    ),
    endpointId: z.string().uuid().optional(),
    endpoint: embeddedEndpointSchema.optional(),
  })
    .refine(
      (c) => (c.provider === CUSTOM_PROVIDER) === (c.endpointId !== undefined || c.endpoint !== undefined),
      'only the custom provider has an endpoint, and it needs one',
    )
    .refine((c) => c.apiKey !== '' || c.provider === CUSTOM_PROVIDER, 'an api key is required')
}

export const opencodeCredentialsFileSchema = apiKeyToolCredentialsFileSchema(parseOpencodeProvider)
export type OpencodeCredentialsFile = z.infer<typeof opencodeCredentialsFileSchema>

export const piCredentialsFileSchema = apiKeyToolCredentialsFileSchema(parsePiProvider)
export type PiCredentialsFile = z.infer<typeof piCredentialsFileSchema>

export const ompCredentialsFileSchema = apiKeyToolCredentialsFileSchema(parseOmpProvider)
export type OmpCredentialsFile = z.infer<typeof ompCredentialsFileSchema>

/**
 * The `PUT /auth/:tool` body. The server checks it against the named tool:
 * an OAuth bundle must be that tool's, an api-key tool needs a provider
 * from its registry, rejected rather than defaulted when missing or unknown,
 * and only its `custom` provider takes an `endpointId` (one of the caller's
 * custom endpoints) in place of a key.
 */
export const toolAuthPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('api-key'),
    apiKey: z.string(),
    provider: z.string().optional(),
    endpointId: z.string().uuid().optional(),
  }),
  z.object({
    kind: z.literal('oauth'),
    bundle: z.union([claudeOAuthBundleSchema, codexOAuthBundleSchema]),
  }),
])
export type ToolAuthPayload = z.infer<typeof toolAuthPayloadSchema>

/**
 * The tool credential files as one value, handed to a runtime whose
 * proxy injects credentials whenever a user's store changes. `null` means
 * signed out.
 */
export interface ToolCredentialBundle {
  claude: ClaudeCredentialsFile | null
  codex: CodexCredentialsFile | null
  opencode: OpencodeCredentialsFile | null
  pi: PiCredentialsFile | null
  omp: OmpCredentialsFile | null
}

/**
 * OAuth bundles a runtime's egress proxy captured from a workspace's token
 * refresh that the owner's store has not adopted yet. Each slot is the newest
 * capture, if any.
 */
export interface RefreshedToolCredentials {
  claude?: ClaudeOAuthBundle
  codex?: CodexOAuthBundle
}

/**
 * Summary of a per-tool credential file. Full OAuth bundles stay in the
 * files.
 */
interface ToolAuthEntryBase {
  kind: ToolAuthKind
  /** Access token (OAuth) or raw API key; empty for a keyless custom
   *  endpoint. */
  apiKey: string
  savedAt: string
}

/**
 * A stored credential, discriminated on `tool` so the provider is required
 * for the api-key tools. This keeps a consumer from falling back to a default
 * provider, which could send the key to the wrong vendor.
 */
export type ToolAuthEntry =
  // Listed separately, not as `'claude' | 'codex'`, so that
  // `Extract<ToolAuthEntry, { tool: 'claude' }>` isn't `never`.
  | (ToolAuthEntryBase & { tool: 'claude' })
  | (ToolAuthEntryBase & { tool: 'codex' })
  | (ToolAuthEntryBase & {
    tool: 'opencode'
    /** Which backend the stored api-key authenticates against. */
    opencodeProvider: OpencodeProvider
    /** The `custom` provider's endpoint. */
    endpoint?: CustomEndpoint
  })
  | (ToolAuthEntryBase & {
    tool: 'pi'
    /** Which provider the stored api-key authenticates against. */
    piProvider: PiProvider
    /** The `custom` provider's endpoint. */
    endpoint?: CustomEndpoint
  })
  | (ToolAuthEntryBase & {
    tool: 'omp'
    /** Which provider the stored api-key authenticates against. */
    ompProvider: OmpProvider
    /** The `custom` provider's endpoint. */
    endpoint?: CustomEndpoint
  })

export interface ProjectMeta {
  /** The project's immutable id, which names it in every route and row. */
  id: string
  /** Display name, by default derived from its first repo's path; not
   *  unique. */
  name: string
  addedAt: string
}

/** How far a git clone has got, from the progress git prints. */
export interface GitProgress {
  /** Git's phase name, such as "Receiving objects" or "Resolving deltas". */
  phase: string
  /** Null for a phase that reports only a count. */
  percent: number | null
  /** What git prints after the count, such as "1.20 MiB | 2.00 MiB/s". */
  detail?: string
}

/**
 * A project being added or created, tracked in server memory so every
 * client shows it until it is listed (docs/project-repos.md "Adding a
 * project"). A failed one stays until its owner dismisses it.
 */
export interface ProjectAddEntry {
  /** The id the project takes once added. */
  id: string
  owner: string
  name: string
  /** Empty for a project whose remote yaac hosts. */
  remoteUrl: string
  hosted: boolean
  progress?: GitProgress
  error?: string
}

/**
 * One repo of a create's selection (docs/project-repos.md): which repo, and
 * the branch (no `origin/` prefix) or full commit its checkout starts at;
 * neither starts at the remote's default branch. A request names the repo
 * by its folder in the project (`ProjectRepo.dir`) or its id; stored and
 * answered selections name it by id.
 */
export interface RepoStart {
  repo: string
  branch?: string
  commit?: string
}

/** Full commit by repo id: what a release or a secret-bearing run is at. */
export type RepoCommits = Record<string, string>

export const repoStartSchema = z.object({
  repo: z.string().min(1).max(255),
  branch: z.string().min(1).max(255).optional(),
  commit: z.string().min(1).max(64).optional(),
})

/** Most repos one project links. */
export const MAX_PROJECT_REPOS = 32

/**
 * What a create starts with, as every create-shaped request takes it: the
 * repos (absent takes the ones the project last included, `[]` none),
 * whether a lone repo sits in a folder of its own rather than at the
 * workspace root, and where the agent starts (`.` for the workspace root,
 * else a selected repo). `branch` and `commit` are shorthand for the
 * start of a selection of exactly one repo.
 */
export const repoSelectionShape = {
  repos: z.array(repoStartSchema).max(MAX_PROJECT_REPOS).optional(),
  nested: z.boolean().optional(),
  cwd: z.string().min(1).max(255).optional(),
  branch: z.string().min(1).max(255).optional(),
  commit: z.string().min(1).max(64).optional(),
}

/** A resolved selection, as queued entries, routines and drafts answer it. */
export interface RepoSelection {
  repos: RepoStart[]
  nested: boolean
  /** Relative to the workspace root: `''` or one checkout's path. */
  cwd: string
}

/** A folder name a repo's checkout can take: one path segment that is not
 *  `.`, `..` or `.git`, and does not read as an option. */
export const REPO_DIR_RE = /^(?!\.{1,2}$)(?!\.[gG][iI][tT]$)(?!-)[A-Za-z0-9._-]{1,100}$/

/** One repo a project links, as `ProjectSummary` lists it. */
export interface ProjectRepo {
  /** The repo's id. */
  id: string
  /** The folder its checkout takes in a workspace that nests its repos. */
  dir: string
  remoteUrl: string
  /** The repo's owner, who differs from the project's for a repo shared
   *  with them. */
  owner: string
  /** Whether the server hosts the remote (docs/hosted-projects.md). */
  hosted: boolean
  /** For a hosted repo, whether pushes may not delete or rewind the
   *  default branch. */
  guardDefaultBranch: boolean
  /** Set when the repo moved off yaac to another git host and yaac still
   *  keeps the repository it hosted. */
  keepsHostedRepo?: true
  /** Its git credential. Without one no workspace can start with it,
   *  unless it is hosted, which needs none. */
  gitCredential: { id: string; name: string } | null
  /** k8s only (docs/project-repos.md "Read-only repos"). */
  readOnly: boolean
  /** k8s only: whether its token may be `GH_TOKEN`. */
  ghToken: boolean
  /** Whether the last create included it, and the branch it named for it
   *  while origin still has it; the create form opens on both. */
  lastIncluded: boolean
  lastBranch?: string
}

/** One of a user's repos, as Settings → Repos lists it. */
export interface RepoSummary {
  id: string
  owner: string
  remoteUrl: string
  hosted: boolean
  guardDefaultBranch: boolean
  keepsHostedRepo?: true
  gitCredential: { id: string; name: string } | null
  /** The projects that link it, any user's. */
  projects: Array<{ id: string; name: string; owner: string }>
  /** The users it is shared with, by id. */
  sharedWith: string[]
  /** Set once its owner deleted it: the workspaces that still hold a
   *  checkout of it, with the last of which it goes for good. */
  deleted?: { heldBy: RepoHolder[] }
}

/** A workspace holding a checkout of a repo. */
export interface RepoHolder {
  workspaceId: string
  projectId: string
  projectName: string
  owner: string
}

/** What deleting a repo would reach, for the confirmation (`GET
 *  /repo/:repoId/delete-preview`): whether yaac holds the only copy of its
 *  code, the projects it is unlinked from, and the workspaces whose
 *  checkouts keep its main clone on disk until they are deleted. */
export interface RepoDeletePreview {
  hosted: boolean
  projects: Array<{ id: string; name: string; owner: string }>
  heldBy: RepoHolder[]
}

/** What moving a hosted repo to a git host stops and hands over, for the
 *  warning a client shows before it confirms (`GET
 *  /repo/:repoId/move-preview`). */
export interface RepoMovePreview {
  /** Running workspaces holding a checkout of it, every user's. */
  runningWorkspaces: number
  /** The users it is shared with, by login or name, who each need a
   *  credential of their own for the new remote. */
  sharedWith: string[]
}

/** One checkout of a workspace. */
export interface WorkspaceRepo {
  repoId: string
  /** Where it sits under the workspace root: `''` for the root itself. */
  path: string
  /** The branch its work is measured against, as its row records it. */
  baseBranch?: string
  /** The commit it was created at. */
  startCommit?: string
}

export interface PortForwardConfig {
  containerPort: number
  hostPortStart: number
}

/**
 * How the egress proxy injects one secret: which hosts and paths it applies
 * to, and where in the request the value goes. Stored on a project's secret
 * env-var row (`ProjectEnvVar.rule`), never in the workspace.
 */
export interface SecretProxyRule {
  /** Hostnames to match (exact, or a wildcard like *.example.com or store*.example.com) */
  hosts: string[]
  /** Path pattern to match (default: "/*") */
  path?: string
  /** Header name to set with the secret value */
  header?: string
  /** Prefix prepended to the value when injecting as a header (e.g. "Bearer ") */
  prefix?: string
  /** Form/JSON body parameter name to replace with the secret value */
  bodyParam?: string
}

/**
 * The project settings a workspace launches with besides its checkout
 * (docs/project-config.md), each a column of the project's row. The last
 * three apply under k8s only: a containerless server refuses to set them.
 */
export interface ProjectConfig {
  /** Ports forwarded from every workspace, each offered at a host port from
   *  `hostPortStart` up. */
  portForwards: PortForwardConfig[]
  /** Named directories that persist across workspaces, by name: the
   *  absolute path each is mounted at. */
  cacheVolumes: Record<string, string>
  /** Run an in-pod rootful podman so `docker` commands work inside
   *  workspaces (docs/nested-containers.md). */
  nestedContainers: boolean
  /** Whether workspaces may use the install's npm cache. When false, one
   *  fetches from npmjs through the egress proxy. */
  npmCache: boolean
}

/**
 * A project's egress allowlist (docs/workspace-egress.md): which hosts its
 * workspaces may reach through the proxy. Patterns are exact names
 * (`api.example.com`) or wildcards (`*.example.com`, `store*.example.com`); a lone `*` allows
 * everything.
 */
export interface EgressAllowlist {
  /** Hosts allowed besides the defaults. */
  hosts: string[]
  /** Whether the install's default hosts are allowed too. Off, only `hosts`
   *  are, so an empty list blocks all egress. */
  defaults: boolean
}

/**
 * One of a project's environment variables, as a client sees it.
 *
 * A secret's value is never returned. `hasValue` is false both for a secret
 * never supplied and for one that no longer decrypts (its key was rotated
 * away); either way the user must enter it again.
 */
export interface ProjectEnvVar {
  id: string
  name: string
  secret: boolean
  /** Plain variables only; absent for a secret. */
  value?: string
  /** Whether a usable value is stored. Always true for a plain variable. */
  hasValue: boolean
  /** Secrets only: how the proxy injects it. */
  rule?: SecretProxyRule
}

/**
 * One of a project's run secrets, as a client sees it
 * (docs/project-config.md "Run secrets"): never its value, only whether a
 * usable one is stored. Workflow revisions name the ones they get.
 */
export interface ProjectRunSecret {
  id: string
  name: string
  hasValue: boolean
}

/**
 * A project's named workflow (docs/workflows.md): the graph and run secrets
 * of the workflow it points at now, and what people approved that workflow
 * to run on with its secrets ("Approvals").
 */
export interface WorkflowEntry {
  id: string
  projectId: string
  name: string
  steps: StepGraph
  secrets: string[]
  /** The repos its steps are written for, by folder (docs/workflows.md
   *  "Repos"). */
  repos: string[]
  /** Started by every workspace that brings no graph of its own and has
   *  its repos. */
  init: boolean
  approvedCommits: string[]
  approvedBranches: string[]
  createdAt: string
}

// ---------------------------------------------------------------------------
// Wire types: RPC request/response shapes shared by the server and clients.
// ---------------------------------------------------------------------------

/** Host↔container port mapping returned by `/workspace/create`. */
export interface PortMapping {
  containerPort: number
  hostPort: number
}

// --- auth/list ---

/**
 * One stored git credential (docs/git-credentials.md): an HTTPS token the
 * user pasted, or an SSH key yaac generated. Never carries the secret.
 */
export interface GitCredentialSummary {
  id: string
  name: string
  kind: 'https' | 'ssh'
  /** Masked token suffix for https; the public key for ssh. */
  preview: string
  /** ssh only: the public key line, for the user to register with the host. */
  publicKey?: string
  /** The repos that authenticate with it, by remote URL. */
  repos: string[]
}

export interface ToolAuthSummary {
  tool: AgentTool
  kind: ToolAuthKind
  /** Masked preview of the access token / API key (last 4 chars). */
  keyPreview: string
  savedAt: string
  /** opencode only — which backend the stored api-key authenticates against. */
  opencodeProvider?: OpencodeProvider
  /** pi only — which provider the stored api-key authenticates against. */
  piProvider?: PiProvider
  /** An api-key tool with the `custom` provider: the endpoint it uses. */
  endpoint?: { id: string; name: string; baseUrl: string }
  /** omp only — which provider the stored api-key authenticates against. */
  ompProvider?: OmpProvider
  /** Candidate `--model` values for this credential, newest first, for the
   *  create form. Not an allowlist. */
  models: ModelOption[]
  /** What a create runs when this project remembers no model for the tool. */
  defaultModel: string
}

/** One model a create can be launched with. */
export interface ModelOption {
  id: string
  name?: string
  /** Its effort levels and default; absent when it has no effort setting. */
  efforts?: ModelEfforts
}

/** One of a user's custom endpoints (docs/custom-endpoints.md), for the
 *  settings page and `yaac auth list`. */
export interface CustomEndpointSummary {
  id: string
  name: string
  baseUrl: string
  /** Its key's last four characters; empty when it has none. */
  keyPreview: string
  models: EndpointModel[]
  /** The tools signed in with it. */
  tools: ApiKeyTool[]
}

export interface AuthListResult {
  gitCredentials: GitCredentialSummary[]
  toolAuth: ToolAuthSummary[]
  customEndpoints: CustomEndpointSummary[]
}

// --- subscription plan usage (domain/auth/plan-usage.ts, snapshot field) ---

/**
 * One limit row from a tool's subscription usage endpoint: Claude's
 * api/oauth/usage `limits[]` or Codex's wham/usage windows.
 */
export interface PlanUsageLimit {
  /** Limit kind. Claude: 'session' (its five-hour window), 'weekly_all',
   *  'weekly_scoped'. Codex: 'codex_primary' (the shorter window),
   *  'codex_secondary' (weekly). */
  kind: string
  /** Utilization of this limit, 0–100. */
  percent: number
  /** Upstream severity, 'normal' until the limit nears exhaustion. Always
   *  'normal' for Codex, which reports none. */
  severity: string
  /** ISO timestamp when this limit's window resets, when reported. */
  resetsAt: string | null
  /** Model display name for per-model limits (e.g. 'Fable'), else null. */
  modelName: string | null
  /** Window length in minutes (Codex only; Claude encodes it in `kind`). */
  windowMinutes?: number | null
}

/**
 * Plan-usage result for one tool. Only OAuth (subscription) credentials can
 * be queried; anything else is `available: false` and the UI hides it.
 */
export type PlanUsageResult =
  | {
    available: false
    reason: 'no-credentials' | 'api-key' | 'unauthorized' | 'error'
    message?: string
  }
  | {
    available: true
    /** Plan tier: Claude's subscriptionType (e.g. 'max') or Codex's
     *  plan_type (e.g. 'plus'), if known. */
    subscriptionType: string | null
    /** Claude's rate-limit tier (e.g. 'default_claude_max_20x'), which
     *  tells Max 20x from 10x. Null until fetched, and always for Codex. */
    rateLimitTier: string | null
    limits: PlanUsageLimit[]
  }

// --- web-driven tool sign-in (auth-daemon/src/tool-login.ts) ---

export type ToolLoginStatus = 'running' | 'success' | 'error'

/** A vendor-CLI browser login in progress (never carries tokens). */
export interface ToolLoginView {
  id: string
  tool: AgentTool
  status: ToolLoginStatus
  /** The CLI's output so far (ANSI-stripped, tail-capped), so the user can
   *  copy the sign-in URL if no browser opened. */
  output?: string
  error?: string
  /** The vendor CLI is not installed; the webapp offers to install it. */
  cliMissing?: boolean
}

/** A vendor-CLI install started from the webapp after a `cliMissing`
 *  sign-in. */
export interface ToolInstallView {
  id: string
  tool: AgentTool
  status: ToolLoginStatus
  /** Installer output so far (ANSI-stripped, tail-capped). */
  output?: string
  error?: string
}

// --- workspace/list ---

/**
 * A git credential the proxy injected that the upstream rejected (expired or
 * revoked), as opposed to a blocked host. Recorded per project, since the
 * credential is the project's; cleared when a later git request to the same
 * host from any of its workspaces succeeds.
 */
export interface GitAuthFailure {
  host: string
  /** HTTP status the upstream returned (401 or 403). */
  status: number
  /** Epoch ms when the proxy first saw the failure. */
  atMs: number
}

/**
 * What an agent is doing. `asking` is mid-turn, stopped on a permission
 * prompt or question the user must answer (ACP only). `background` is
 * between turns with work the agent started still live (a background shell,
 * a monitor, a background subagent), which will usually wake it again, so it
 * does not count as waiting for the user; only claude's ACP adapter reports
 * that work.
 */
export type AgentStatus = 'running' | 'background' | 'waiting' | 'asking'

/**
 * `AgentStatus` as listings send it: `asking` goes out as `waiting` plus an
 * `asking` flag, so a client that predates the flag (a desktop app is
 * installed on its own schedule) still alerts on an ask.
 */
export type ListedAgentStatus = Exclude<AgentStatus, 'asking'>

/**
 * One agent conversation a workspace hosted, keyed by the tool's own id. A
 * session holds one at a time and gathers more over its life (each
 * `/clear`); an agent started by hand in a terminal holds one with no
 * session.
 */
export interface ConversationEntry {
  /** The tool's own conversation id, not yaac's. */
  conversationId: string
  tool: AgentTool
  /** Which protocol drives it, and so which pane renders it. Absent means
   *  `tui`. */
  mode?: AgentMode
  /** The order the workspace first saw it in. */
  ordinal: number
  /** Had a live agent when the workspace was last seen running. */
  active: boolean
  /** The session that held it; absent for one started in a terminal. */
  sessionId?: string
  /** This conversation's first user message (differs from the workspace's
   *  founding prompt after a `/clear`). */
  prompt?: string
  /** 'YYYY-MM-DD HH:MM:SS' (UTC) of its transcript's last write. */
  lastActiveAt?: string
  /**
   * The model it is answering as, in the tool's spelling (`claude-opus-5`,
   * `anthropic/claude-opus-4-8`), for display only. Seeded from the launch
   * and updated by the agent, so it follows a `/model` switch (for a `tui`
   * opencode, at its next prompt). Absent until a conversation launched
   * without a model first answers.
   */
  model?: string
  /** `model`'s display name ("Opus 5.5"), when the catalog has one. */
  modelName?: string
}

/**
 * One agent session in a workspace (docs/sessions.md): an agent process in a
 * tmux window of its own, launched with these settings, which follow what
 * the agent reports. An open session comes back on a restart; closing one
 * stops its agent and keeps its conversations as history.
 */
export interface SessionEntry {
  /** yaac's id for it, which names its pane (`session:<id>`). */
  sessionId: string
  tool: AgentTool
  /** How its agent is driven, and so which pane renders it. */
  mode: AgentMode
  /** The tmux window it runs in. */
  window: string
  permissionMode: PermissionMode
  /** Its effort level, in the tool's words; absent when its model has none. */
  effort?: string
  /** Each option its tool has (`AGENT_OPTIONS`). */
  agentOptions: AgentOptions
  /** Where its agent runs, relative to the workspace root. */
  cwd: string
  /** The model it runs, in the tool's spelling, and its display name. */
  model?: string
  modelName?: string
  /** The user's name for it, else its conversation's own title. */
  title?: string
  /** The message it was opened with, else its conversation's first. */
  prompt?: string
  /** The conversation it holds now; absent until its agent names one. */
  conversationId?: string
  /** Display order within the workspace. */
  ordinal: number
  /** Live only: what its agent is doing. Absent while it starts, and once
   *  it has exited. */
  status?: ListedAgentStatus
  /** Live only: stopped on an ask the user must answer (`status` is then
   *  `waiting`). */
  asking?: true
  /** Live only: epoch ms when its waiting spell began. */
  waitingSinceMs?: number
  /** The users who viewed its current waiting spell. */
  waitingSeenBy?: string[]
  /** Its agent exited and its window is kept, for the user to resume or
   *  close it. */
  exited?: true
  /** Live only: a `tui` agent launched with its opening message has not
   *  started on it yet, so its pane shows the message, not the terminal. */
  opening?: true
}

/**
 * A workspace's status in a listing: its most pressing session's, or `idle`
 * when no session is running.
 */
export type WorkspaceStatus = ListedAgentStatus | 'idle'

export interface WorkspaceListEntry {
  workspaceId: string
  projectId: string
  /**
   * The most pressing of its sessions' statuses: `waiting` (including an
   * ask), then `running`, then `background`; `idle` with none running.
   */
  status: WorkspaceStatus
  /** Some session is stopped on an ask the user must answer (`status` is
   *  then `waiting`). */
  asking?: true
  /** The workspace is being torn down (its pod has a deletion timestamp,
   *  or a stop was just issued). Render a non-interactive "stopping…"
   *  placeholder. */
  stopping?: boolean
  /** Pod created time as 'YYYY-MM-DD HH:MM:SS' (UTC). */
  createdAt: string
  /** Epoch ms when the current waiting spell began; set only while
   *  `waiting`. The earliest waiting session's time wins. Kept in server
   *  memory, so a server restart starts a new spell. */
  waitingSinceMs?: number
  /** The message its first session was opened with; survives a `/clear`. */
  prompt?: string
  /** The user's title, else the agent's own for its opening conversation,
   *  else one generated from `prompt` (docs/workspace-titles.md). UIs fall
   *  back to `prompt`. */
  title?: string
  /** Its open sessions, in order. */
  sessions: SessionEntry[]
  /** Every conversation the workspace has hosted, in the order it first saw
   *  them. */
  conversations: ConversationEntry[]
  /** Its tmux windows other than its sessions' and its steps', which the
   *  webapp opens as terminal panes. Absent until the server first lists
   *  them (unknown, not none) and while the workspace is stopping. */
  terminals?: WorkspaceTerminalEntry[]
  /** Its current life's steps (docs/workspace-steps.md), each with the
   *  window it runs in while it has one. */
  steps?: Array<WorkspaceStep & { target?: string }>
  /** When its current life began (ISO time), which names that life's log
   *  dir (docs/workspace-steps.md "Logs"). */
  life?: string
  /** It runs one graph untouched and stops when it settles. */
  nonInteractive?: true
  /** The name of the public site it is a release of (docs/public-sites.md),
   *  which makes it read-only. */
  site?: string
  /** Its checkouts, and where its shells and steps start relative to the
   *  workspace root (`''`, or one checkout's path). */
  repos: WorkspaceRepo[]
  cwd: string
  blockedHosts: string[]
  /** Live host→container forwards. Briefly empty after a server restart,
   *  until the restore pass runs. */
  forwardedPorts: PortMapping[]
  /** Ports with a live listener in the workspace that aren't forwarded,
   *  dismissed, sensitive or infra. Drives the "forward this port?"
   *  badge. */
  unforwardedPorts: number[]
  /** Its scratch dirs that git tracks, found when it started: their
   *  tracked files show as deleted in it. Absent when there are none. */
  trackedScratchDirs?: string[]
  /** The sidebar group this workspace is filed under (see
   *  `WorkspaceGroupSummary`); absent means ungrouped. Kept through stop and
   *  restart. */
  groupId?: string
  /** When the server stops it (ISO), absent with no timeout
   *  (docs/routines.md "Timeouts"). */
  deadline?: string
  /** The routine it is a run of. */
  routineId?: string
}

/**
 * A named sidebar group of a project's workspaces. The sidebar lists
 * ungrouped workspaces first, then one section per group, both in
 * `createdAt` order.
 *
 * A group is shown when `pinned` or when it holds a live workspace, and then
 * lists all its members, stopped ones as ghost rows with a restart action.
 */
export interface WorkspaceGroupSummary {
  groupId: string
  projectId: string
  name: string
  /** Keep the group listed even with no live workspace in it. */
  pinned: boolean
  /** Most live workspaces it may hold at once; absent is unlimited
   *  (docs/workspace-groups.md). */
  workspaceLimit?: number
  /** 'YYYY-MM-DD HH:MM:SS' (UTC) — the groups' display order. */
  createdAt: string
  /** Stopped members. In the snapshot it leaves out members it draws a row
   *  of their own for (still stopping, held, or restarting). */
  stoppedCount: number
  /** Stopped members that died, among every one, and how many of those
   *  each user has viewed, by user id (absent for none). */
  deaths: number
  deathsSeenBy: Record<string, number>
}

/** How a file changed, mapped from git's name-status letters. */
export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange'

/**
 * Where a change sits in git: in commits since the fork base, in the index,
 * in the working tree of a tracked file (`modified`, git's unstaged
 * changes), or in a file git does not track.
 */
export type ChangeStage = 'committed' | 'staged' | 'modified' | 'untracked'

export interface LineCounts {
  additions: number
  deletions: number
}

/** One changed file in a workspace, relative to the fork base. */
export interface WorkspaceChange {
  path: string
  status: ChangeStatus
  additions: number
  deletions: number
  /** The file's line counts per stage it has changes in. Each is that
   *  stage's own diff (base→HEAD, HEAD→index, index→working tree), so they
   *  need not sum to the totals; an untracked file carries its totals. */
  stages: Partial<Record<ChangeStage, LineCounts>>
  /** Git reported the file as binary (no line counts / textual diff). */
  binary: boolean
  /** The pre-rename path, set only for `renamed`/`copied` files (git's "from"
   *  side); `path` is the "to" side. */
  oldPath?: string
}

/**
 * The review diff for a workspace: everything changed since it forked from
 * its base branch (committed, staged, unstaged, untracked). Computed with a
 * separate index so the agent's git state is untouched.
 */
export interface WorkspaceDiff {
  /** The base the diff is taken against: the merge-base with the fork
   *  point; with none, HEAD, or the empty tree when HEAD shares no history
   *  with origin (an empty repo's first commits, or none yet). */
  base: string
  /** False when `base` fell back to HEAD. The diff then covers only
   *  uncommitted work, and an empty `files` must not read as "no changes". */
  baseResolved: boolean
  /** The working tree's git tree the diff was read at. With `base` it
   *  names this reading, for `/changes/diff` to read more of it. */
  work: string
  files: WorkspaceChange[]
  /** The combined unified diff; the client splits it into per-file hunks.
   *  Capped for size — see `truncated`. A file whose part was cut short ends
   *  in a `DIFF_CUT_LINE` line, and a file past the cap has no part. Absent
   *  when the caller asked for no diff body. */
  diff?: string
  /** True when the diff body was capped for size; `files` stays complete. */
  truncated: boolean
  /** What is left out of the diff for being too large to stage: folders
   *  (as `dir/`) holding over 2,000 untracked files that nothing ignores,
   *  such as a build's output, whose tracked files are still diffed, and
   *  untracked files over 10 MiB. */
  skipped?: string[]
}

/** The working tree as the newer end of a compared range: what the Changes
 *  pane diffs against by default. `:` cannot appear in a ref name, so no
 *  branch can be mistaken for it. */
export const WORKTREE_REF = ':worktree'

/**
 * The diff between two refs of a checkout (`GET /workspace/:id/compare`):
 * from the merge base of `from` and `to` to `to`, or, with no `from`, from
 * `to`'s first parent, as `git show` diffs a commit. `work` is `to`'s
 * commit, and every change counts as committed.
 */
export interface WorkspaceComparison extends WorkspaceDiff {
  /** `to`'s commit, given when no `from` was. */
  commit?: CommitDetail
}

/** A commit as `git show` heads it. */
export interface CommitDetail {
  sha: string
  parents: string[]
  author: string
  /** Author time, in Unix seconds. */
  time: number
  /** The whole message, subject and body. */
  message: string
}

/** The line ending a file's part of `WorkspaceDiff.diff` that was cut short.
 *  No line of git's diff output can equal it. */
export const DIFF_CUT_LINE = '@@CUT@@'

/**
 * Everything the webapp polls about a workspace's checkout, in one answer:
 * the diff, where HEAD stands against the base branch, and the listing.
 */
export interface WorkspaceChanges extends WorkspaceDiff {
  /** The branch compared against (the caller's pick, else the fork branch);
   *  null when nothing records one. */
  branch: string | null
  /** Null when no fork point was found: `base` fell back to HEAD or the
   *  empty tree. */
  comparison: BranchComparison | null
  /** The checkout's listing, when asked for and not already current at the
   *  caller (its `known` version). */
  listing?: WorkspaceFiles
  /** How long the read behind this answer took in the workspace, so a
   *  client polls a slow checkout less often. */
  readMs: number
}

/** How far HEAD has diverged from the branch it is compared against.
 *  `behind` is only as fresh as `fetchedAt`. */
export interface BranchComparison {
  /** `origin/<branch>`, or `<branch>` for a branch that was never pushed. */
  ref: string
  ahead: number
  behind: number
  /** When `ref` was last fetched, 'YYYY-MM-DD HH:MM:SS' (UTC); absent for
   *  a local branch or when no fetch is on record. */
  fetchedAt?: string
}

/**
 * A workspace's commit history for the Commits pane: the newest `limit`
 * commits reachable from HEAD or the base branch, children before
 * parents and otherwise newest first (`git log --date-order`), so the
 * client can draw the graph from `parents` alone.
 */
export interface WorkspaceGitLog {
  /** The base ref (`origin/main`, or the start commit of a workspace
   *  created at one); null when it shares no history with HEAD. */
  ref: string | null
  /** The commit HEAD is at; null in an empty repo. */
  head: string | null
  commits: GitLogCommit[]
  /** True when older commits were left out by `limit`. */
  more: boolean
}

/** The most commits one `WorkspaceGitLog` holds. */
export const MAX_LOG_COMMITS = 2000

export interface GitLogCommit {
  sha: string
  parents: string[]
  author: string
  /** Author time, in Unix seconds. */
  time: number
  subject: string
  /** The message after its subject, empty when there is none; a long one
   *  is cut short, ending in `…`. */
  body: string
  /** The refs pointing at it, as `git log --decorate` names them
   *  (`HEAD -> agent/x`, `origin/main`, `tag: v1`). */
  refs: string[]
}

/** Where a symlink in a workspace leads: its resolved path relative to the
 *  workspace, or null when it is broken or leads outside the workspace. */
export interface SymlinkTarget {
  target: string | null
  dir: boolean
}

/**
 * Every path in a workspace's checkout, for the file explorer. `ignored`
 * and `emptyDirs` cost a walk of the working tree, so they are filled only
 * for a `full` listing and are empty otherwise.
 */
export interface WorkspaceFiles {
  /** Changes whenever anything below does; the caller sends it back as
   *  `known` so an unchanged listing is not sent again. */
  version: string
  /** The checkout's absolute path as the workspace sees it (`/workspace` in
   *  a pod, a host path otherwise), which `paths` are relative to. File
   *  links read an absolute path in agent output against it. */
  root: string
  /** Tracked and untracked files, gitignore-aware, deleted ones removed. */
  paths: string[]
  /** The entries of `paths` that are symlinks. */
  symlinks: Record<string, SymlinkTarget>
  /** Ignored files, and wholly ignored folders as one `dir/` entry each.
   *  A scratch dir holding no path of `paths` counts as a wholly ignored
   *  folder. */
  ignored: string[]
  /** Folders holding no path of `paths`, which the list alone cannot show. */
  emptyDirs: string[]
  /** The diff's `skipped` folders, whose untracked files `paths` leaves
   *  out; the explorer reads their children on expand. */
  skipped?: string[]
  /** Files with an unresolved merge conflict. */
  conflicted: string[]
  /** True when `paths` was capped. */
  truncated: boolean
}

/** A file's text at a commit: what the editor diffs the working copy
 *  against. `exists` is false when the commit has no such file; `content`
 *  is null when it does but is binary or over the editable size. */
export interface WorkspaceFileAtRev {
  exists: boolean
  content: string | null
}

/** One file of a workspace, as the editor reads it. */
export interface WorkspaceFile {
  path: string
  /** The sha256 of the file's bytes — what a save names as its base. */
  version: string
  size: number
  binary: boolean
  /** Omitted when the caller's `known` version is still current; null when
   *  the file is binary or too large to edit. */
  content?: string | null
}

/** A successful save: the version the file now has. */
export interface WorkspaceFileSaved {
  path: string
  version: string
  size: number
}

/** One child of a folder, for expanding a folder the listing leaves out. */
export interface WorkspaceDirEntry {
  name: string
  dir: boolean
  symlink?: SymlinkTarget
}

export interface WorkspaceDir {
  entries: WorkspaceDirEntry[]
  truncated: boolean
}

/**
 * Why a workspace died, captured at reap time from the pod's terminal state
 * before the teardown deletes the Job. Absent on a plain user delete.
 */
export type WorkspaceDeathReason =
  | 'oom'            // session container OOMKilled by the kernel
  | 'evicted'        // pod evicted by the kubelet (node pressure)
  | 'crashed'        // session container exited non-zero
  | 'pod-stopped'    // pod left Running with no conclusive terminal state
  | 'agent-exited'   // pod alive but the in-pod tmux server was gone
  | 'never-started'  // session create was interrupted before the agent ran
  | 'orphaned'       // Job/pod deleted out-of-band

export interface WorkspaceDeathCause {
  reason: WorkspaceDeathReason
  /** Free-form evidence: exit code, eviction message, … */
  detail?: string
}

/**
 * Where a skill was found. `personal` and `plugin` skills live in one agent's
 * config dir (`home`), and `repo` ones in the project's repository. `yaac`
 * skills are the ones yaac injects into every workspace (see
 * packages/server/src/domain/skills).
 */
export type SkillSource = 'personal' | 'plugin' | 'repo' | 'yaac'

/** One discovered agent skill (a `SKILL.md`), summarized for a listing. */
export interface SkillSummary {
  /** Stable, location-qualified id used to fetch the full body. */
  id: string
  /** Invocation name — frontmatter `name`, else the skill directory name. */
  name: string
  /** `description` with `when_to_use` appended. Empty when the frontmatter is
   *  absent or malformed (the skill still loads, per Claude Code semantics). */
  description: string
  source: SkillSource
  /** The agent whose config dir holds a personal or plugin skill. */
  home?: AgentTool
  /** The plugin a plugin skill came from, or the repo dir a repo skill was
   *  read from (`.claude/skills`). */
  sourceLabel?: string
  /** The agents that read this skill's dir. Every skill from one dir has
   *  the same list. */
  agents: AgentTool[]
  /** Those of `agents` that load a same-named skill from another dir
   *  instead. Which dir wins differs per agent (see
   *  packages/server/src/domain/skills/discover.ts); codex loads both. */
  overriddenFor: AgentTool[]
  /** False when frontmatter sets `user-invocable: false` (hidden from `/`). */
  userInvocable: boolean
  /** False when frontmatter sets `disable-model-invocation: true`. */
  modelInvocable: boolean
  /** Parsed `allowed-tools` (space/comma string or YAML list), if present. */
  allowedTools?: string[]
}

/** Every skill any agent can use in a project. */
export interface ProjectSkills {
  skills: SkillSummary[]
}

/** A single skill's full `SKILL.md`, for the on-demand detail view. */
export interface SkillDetail {
  id: string
  name: string
  source: SkillSource
  /** Raw frontmatter key→value (list values joined for display). */
  frontmatter: Record<string, string>
  /** The markdown body after the frontmatter block. */
  body: string
}

export interface StaleWorkspaceInfo {
  jobName: string
  projectId: string
  workspaceId: string
  /** True when the pod is still running but tmux is gone. */
  zombie: boolean
  /** Terminal-state evidence for the reap, when the pod carried any. */
  deathCause?: WorkspaceDeathCause
}

export interface ActiveWorkspacesResult {
  workspaces: WorkspaceListEntry[]
  stale: StaleWorkspaceInfo[]
  /** Project id -> git credentials the upstream rejected. Only projects
   *  with a failing host appear. */
  gitAuthFailures: Record<string, GitAuthFailure[]>
}

export interface StoppedWorkspaceEntry {
  workspaceId: string
  projectId: string
  /** 'YYYY-MM-DD HH:MM:SS' (UTC). Workspace birth time. */
  createdAt: string
  /** Last activity as 'YYYY-MM-DD HH:MM:SS' (UTC): the newest recorded
   *  across all its conversations (the mtime of the file each appends to),
   *  else the creation time. */
  lastActiveAt?: string
  /** When it was stopped, 'YYYY-MM-DD HH:MM:SS' (UTC); the sort key, newest
   *  first. */
  stoppedAt: string
  /** The message its first session was opened with. */
  prompt?: string
  /** Resolved as for a live workspace (`WorkspaceListEntry.title`). */
  title?: string
  /** The sessions open when it stopped, which a restart brings back. */
  sessions: SessionEntry[]
  /** Every conversation the workspace hosted. */
  conversations: ConversationEntry[]
  /** Why the workspace died, when the reaper (not the user) stopped it. */
  deathReason?: WorkspaceDeathReason
  /** Evidence accompanying `deathReason` (exit code, eviction message, …). */
  deathDetail?: string
  /** The server stopped it at its timeout. */
  timedOut?: true
  /** That deadline was its routine's next tick, which the next run took
   *  over from: it ended at the next run rather than running out of time. */
  endedAtNextRun?: true
  /** The ids of the users who have viewed this death's detail, which
   *  clears their notification dot. Stored on the workspace row, so each
   *  user's dot is the same on every client; meaningful only with
   *  `deathReason`. */
  deathSeenBy: string[]
  /** The sidebar group it is filed under; a stopped member shows as a ghost
   *  row there. */
  groupId?: string
  /** It ran one graph untouched (docs/workspace-steps.md), how that ended
   *  if it did, and the non-interactive workspace it reran. */
  nonInteractive?: true
  stepsOutcome?: StepsOutcome
  rerunOf?: string
  /** The public site it was a release of. */
  site?: string
}

/** One life's logs (docs/workspace-steps.md "Logs"): its dir name, and each
 *  file with its size in bytes. */
export interface WorkspaceLogLife {
  life: string
  files: Array<{ name: string; size: number }>
}

/** One page of `GET /workspace/list-stopped`, newest stop first. */
export interface StoppedWorkspacePage {
  entries: StoppedWorkspaceEntry[]
  /** Every stopped workspace matching the filters, not just this page. */
  total: number
  /** Pass back as `cursor` for the next page; absent on the last one. */
  nextCursor?: string
}

/** A tmux window in a workspace that runs no session or step, which the
 *  webapp can attach to: a scratch shell, or one opened by hand. */
export interface WorkspaceTerminalEntry {
  /** /pty/attach target: 'window:@<id>'. */
  target: string
  /** Display name (the tmux window name). */
  name: string
}

// ---------------------------------------------------------------------------
// Webapp event stream, pushed over the `/events` WebSocket.
// ---------------------------------------------------------------------------

/** Project row in the snapshot, and what `listProjects` answers. */
export interface ProjectSummary extends ProjectConfig {
  id: string
  name: string
  addedAt: string
  /** The owning user's id (`User.id`). Every other snapshot row belongs to
   *  its project's owner. */
  owner: string
  /** A hash of the picture its chip shows instead of its initial, which
   *  `GET /project/:id/icon` serves; absent when it has none. */
  iconHash?: string
  workspaceCount: number
  /** Stopped workspaces. In the snapshot it leaves out workspaces it draws
   *  a row of their own for (still stopping, held, or restarting). */
  stoppedCount: number
  /** Stopped workspaces that died, among every one, and how many of those
   *  each user has viewed, by user id (absent for none). */
  deaths: number
  deathsSeenBy: Record<string, number>
  /** The agent last created with; the create form opens on it. Absent
   *  before the first create (claude is assumed). */
  lastTool?: AgentTool
  /** Per agent, what it was last created with here (see
   *  `resolveToolCreateDefaults`). */
  createDefaults: Partial<Record<AgentTool, ToolCreateDefaults>>
  /** The repos it links, in order (docs/project-repos.md). */
  repos: ProjectRepo[]
  /** The layout and cwd the last create chose, which the create form opens
   *  on: whether a lone repo was nested, and the repo id (or `.` for the
   *  workspace root) the agent started in. Absent before a create chose. */
  lastNested?: boolean
  lastCwd?: string
  /** Days a stopped workspace is kept before the server deletes it, set by
   *  the owner; absent keeps them forever. */
  stoppedWorkspaceRetentionDays?: number
  /** Gitignored paths, relative to the checkout, that a stop keeps when it
   *  removes the rest; absent when there are none. */
  keptIgnoredPaths?: string[]
  scratchDirs: ScratchDirSettings
}

/**
 * One scratch dir: a checkout-relative dir of installed packages or build
 * output that belongs to a workspace's runtime rather than its checkout. A
 * pod backs it with a pod-local volume holding at most `sizeGiB`, or
 * `DEFAULT_SCRATCH_DIR_GIB` when it names none; a host workspace keeps it in
 * its checkout, uncapped. A stop removes it.
 */
export interface ScratchDir {
  path: string
  sizeGiB?: number
}

/** A project's scratch dirs (docs/project-config.md "Scratch directories"). */
export interface ScratchDirSettings {
  dirs: ScratchDir[]
  /** Scratch dirs git tracks that no workspace warns about (see
   *  `WorkspaceListEntry.trackedScratchDirs`). */
  ignoredTracked: string[]
}

/** The cap of a scratch dir that names none: room for a large monorepo's
 *  root `node_modules`, pnpm store included, or a mid-sized cargo `target`. */
export const DEFAULT_SCRATCH_DIR_GIB = 16

/**
 * A create or restart in flight, tracked in server memory. The webapp shows
 * it as a sidebar row with live progress until the workspace exists or a
 * failure is dismissed.
 */
export interface ProvisioningWorkspaceEntry {
  workspaceId: string
  projectId: string
  /** The agent its first session runs; absent for a workspace with none. */
  tool?: AgentTool
  kind: 'create' | 'restart'
  /** The title a create was given, or the one its draft or queued entry was
   *  shown under. Absent on a restart. */
  title?: string
  /** The model a create launches with, and its display name. Absent on a
   *  restart. */
  model?: string
  modelName?: string
  /** The session a create opens, and the prompt it opens with. Absent on a
   *  restart. */
  sessionId?: string
  prompt?: string
  /** Latest progress line (e.g. 'Pulling image…'). */
  message: string
  /** Set when provisioning failed; the row stays until dismissed. */
  error?: string
  /** The failure's code, when it had one the webapp acts on (a
   *  `VOLUME_HELD` restart offers to go without the volume). */
  errorCode?: ErrorCode
  /** The sidebar group it is filed under, so the row shows there while it
   *  provisions. Absent means ungrouped. */
  groupId?: string
  /** The id of the prewarmed spare a create claimed. Once ready, the
   *  workspace lists under this id rather than the row's. */
  claimedId?: string
  /** The user stopped it; the row goes once the create has rolled back. */
  stopping?: boolean
  /** When provisioning started, 'YYYY-MM-DD HH:MM:SS' (UTC). */
  createdAt: string
}

/**
 * A create request saved to run when its parent stops naturally
 * (docs/queued-workspaces.md). Every setting is concrete, so the sidebar
 * shows exactly what will launch. At most one parent field is set: a
 * workspace, or another queued entry. With neither, it waits for room in
 * its group (docs/workspace-groups.md).
 */
export interface QueuedWorkspaceEntry {
  id: string
  projectId: string
  /** Exactly one of these three: the workspace or entry it waits on, or
   *  when it starts (ISO). */
  parentWorkspaceId?: string
  parentQueuedId?: string
  startAt?: string
  /** Minutes the launched workspace runs before the server stops it,
   *  counted from `startAt` if set, else from the launch. */
  timeoutMinutes?: number
  /** The routine it is a run of. */
  routineId?: string
  /** Absent for a non-interactive entry, which opens no session. */
  prompt?: string
  tool: AgentTool
  model: string
  /** `model`'s display name, when the catalog has one. */
  modelName?: string
  mode: AgentMode
  permissionMode: PermissionMode
  /** The effort it launches at; absent when its model has none. */
  effort?: string
  agentOptions: AgentOptions
  /** What it starts with: each repo at a branch, fetched fresh at launch,
   *  or at a full commit (docs/project-repos.md). */
  selection: RepoSelection
  /** The step graph it would start with in place of the project's init
   *  steps, and the named workflow it follows until it launches
   *  (docs/workflows.md). */
  steps?: StepGraph
  workflow?: string
  nonInteractive?: true
  /** The user's title for the workspace; suppresses auto-titling. */
  title?: string
  /** Generated from the prompt for an untitled entry; the launched
   *  workspace uses it unless `title` is set. */
  generatedTitle?: string
  /** The sidebar group it launches into; absent means ungrouped. */
  groupId?: string
  /** 'YYYY-MM-DD HH:MM:SS' (UTC). */
  createdAt: string
  /** Why its last launch failed; it is back in the queue until run again. */
  launchError?: string
  /** Its parent workspace has no row (its create failed), so it renders at
   *  the top level. */
  orphaned?: boolean
  /** It starts as soon as its group has room: its parent has released it,
   *  or it has no parent. */
  waitingForRoom?: boolean
}

/**
 * Cap on a prompt, in UTF-8 bytes, both as a write takes it and as an
 * opening message is recorded. A `tui` agent is launched with its opening
 * message as one command-line argument, which Linux caps at 128 KiB with
 * its terminating NUL; this leaves room for what a launch adds around it
 * (`openingArg`), the same for every tool. Recorded messages are cut to this
 * many characters, which never cuts one a write took, since none has more
 * characters than bytes.
 */
export const MAX_PROMPT_BYTES = 130_000

/** Whether a prompt is within `MAX_PROMPT_BYTES`. */
export function promptFits(prompt: string): boolean {
  return new TextEncoder().encode(prompt).length <= MAX_PROMPT_BYTES
}

/** Why a prompt over `MAX_PROMPT_BYTES` is refused. */
export const PROMPT_TOO_LONG = 'the prompt is over the 130 KB limit'

/** A prompt as a write takes it (`promptFits`). */
export const promptText = z.string().refine(promptFits, PROMPT_TOO_LONG)

/**
 * How much of a prompt the `/events` snapshot and the stopped list carry.
 * The snapshot goes to every client on every change, and a stopped page
 * holds dozens of rows, so full prompts would send up to
 * `MAX_PROMPT_BYTES` per row each time. A row's prompt keeps 10,000
 * characters, which the sidebar's search matches against; a conversation's
 * first prompt, which nothing searches, keeps only enough for its tab label
 * and tooltip. A client needing the whole text fetches it:
 * `GET /workspace/prompt` for a queued entry, draft, routine or session;
 * `yaac-mama list` prints any workspace's whole.
 */
export const PROMPT_PREVIEW_LENGTH = 10_000
export const CONVERSATION_PROMPT_PREVIEW_LENGTH = 300

/**
 * A timeout in whole minutes (docs/routines.md "Timeouts"), up to a year.
 * The server acts on its minute resync, so nothing finer is offered.
 */
export const timeoutMinutesSchema = z.number().int().min(1).max(525_600)

/**
 * A queued workspace's settings as a queue write takes them. A present field
 * overrides what would otherwise be resolved at launch; blank `title` leaves
 * the workspace to be auto-titled.
 */
export const queuedWorkspaceSettingsSchema = z.object({
  prompt: promptText.min(1),
  ...repoSelectionShape,
  /** The step graph to start with, checked by the server; null for none
   *  (docs/workspace-steps.md). */
  steps: z.unknown().optional(),
  /** A named workflow to start with in place of `steps`, followed until it
   *  launches (docs/workflows.md). */
  workflow: z.string().min(1).max(200).optional(),
  /** Run `steps` untouched, with no prompt or session. */
  nonInteractive: z.boolean().optional(),
  tool: z.enum(AGENT_TOOLS).optional(),
  model: z.string().regex(MODEL_RE).max(100).optional(),
  mode: z.enum(AGENT_MODES).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  effort: effortSchema.optional(),
  /** Options the tool lacks are refused. Unnamed ones resolve as a create's. */
  agentOptions: agentOptionsSchema.optional(),
  title: z.string().max(500).optional(),
  /** Minutes until the server stops the workspace. */
  timeout: timeoutMinutesSchema.optional(),
})

/** Most runs one page of `GET /routine/runs` returns. */
export const ROUTINE_RUNS_PAGE_MAX = 100

/**
 * A routine as a create or update takes it (docs/routines.md). Settings
 * left out resolve as a scheduled workspace's do. An absent `group` on a
 * create files runs under a group named after the routine; null is the
 * default list. A null `timeout` stops each run at the next tick.
 */
export const routineSettingsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  cron: z.string().trim().min(1).max(100),
  /** IANA zone the cron is read in; absent is the user's. */
  timeZone: z.string().min(1).max(64).optional(),
  /** Absent only for a non-interactive routine. */
  prompt: promptText.min(1).optional(),
  ...repoSelectionShape,
  /** A named workflow each run starts with (docs/workflows.md); null on an
   *  edit runs the project's init steps instead. */
  workflow: z.string().min(1).max(200).nullable().optional(),
  nonInteractive: z.boolean().optional(),
  tool: z.enum(AGENT_TOOLS).optional(),
  model: z.string().regex(MODEL_RE).max(100).optional(),
  mode: z.enum(AGENT_MODES).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  effort: effortSchema.optional(),
  /** Options the tool lacks are refused. Unnamed ones resolve as a create's. */
  agentOptions: agentOptionsSchema.optional(),
  group: z.string().min(1).max(500).nullable().optional(),
  timeout: timeoutMinutesSchema.nullable().optional(),
})

export type RoutineSettings = z.infer<typeof routineSettingsSchema>

/**
 * A volume as `GET /api/volume/list` lists it (docs/workspace-volumes.md): app
 * data one running workspace at a time mounts.
 */
export interface VolumeEntry {
  name: string
  /** The size asked for, as a Kubernetes quantity (`10Gi`); enforced only
   *  on a cluster that gives each volume its own claim. */
  size: string
  createdAt: string
  /** The workspace that has it mounted now. */
  holder?: { workspaceId: string; title?: string; attachedAt: string }
  /** Stopped workspaces that attach it again when they restart. */
  stoppedWorkspaces: Array<{ workspaceId: string; title?: string }>
}

/**
 * Where a deploy is (docs/public-sites.md "Deploys"): its release is being
 * created, then runs the steps that do not need the site's volume, waits
 * for the old release to let the volume go, starts what needs it, and once
 * ready takes the hostname while the old release drains.
 */
export type SiteDeployPhase = 'launching' | 'building' | 'handoff' | 'starting'

/** A commit of one checkout of a release: `dir` is where the checkout sat,
 *  '' for a lone repo at the root. */
export interface SiteCommit {
  dir: string
  commit: string
}

/** Which edge serves a site, derived from its hostname (`siteEdgeOf`). */
export type SiteEdge = 'public' | 'tailnet'

/**
 * The tailnet tunnel's state: `absent` with no Tailscale auth key given to
 * install (or under containerless), `joining` until its device is on the
 * tailnet, `no-certificate` until the site domain's certificate is in its
 * Secret, `ready` while it serves.
 */
export type SiteTailnetState = 'absent' | 'joining' | 'no-certificate' | 'ready'

/** A site, public or tailnet, as `GET /site/list` answers it. */
export interface SiteEntry {
  name: string
  hostname: string
  edge: SiteEdge
  /** The port its releases serve on. */
  port: number
  /** The port of its releases that its owner may forward or preview, for
   *  an admin view the internet never reaches. */
  adminPort?: number
  /** The named workflow each release runs, and its current graph. */
  workflow: string
  steps: StepGraph
  /** Its volume's name. */
  volume?: string
  /** The repos its releases start with, by folder, each at a branch or a
   *  full commit. */
  repos: Array<{ dir: string; branch?: string; commit?: string }>
  /** It deploys whenever a branch in `repos` moves, while serving. */
  follow: boolean
  /** Why following deploys nothing now: its owner is not an admin. */
  followPaused?: string
  /** The commits whose deploy failed, which following does not try again;
   *  a deploy by hand does. */
  followSkipped?: SiteCommit[]
  createdAt: string
  /** The release the hostname points at, while one is meant to serve.
   *  `running` is false while a crashed one is being replaced. */
  live?: { workspaceId: string; commits: SiteCommit[]; since: string; running: boolean }
  /** A deploy in progress. `replacing`: it replaces a release that died,
   *  at that release's commits. */
  deploy?: { workspaceId: string; commits: SiteCommit[]; startedAt: string; phase: SiteDeployPhase; replacing?: true }
  /** How the last deploy that finished ended. */
  lastDeploy?: { workspaceId: string; commits: SiteCommit[]; outcome: 'succeeded' | 'failed'; error?: string; finishedAt: string }
}

/** A site with its recent releases, newest first, for `GET /site/show`. */
export interface SiteDetail extends SiteEntry {
  releases: Array<{ workspaceId: string; commits: SiteCommit[]; createdAt: string; stoppedAt?: string; rerunOf?: string }>
}

/** What `GET /site/edge` answers: the state of the install's two site
 *  tunnels, and the site domain whose names are tailnet sites'. */
export interface SiteEdgeStatus {
  /** `absent`: install was given no Cloudflare tunnel token. */
  cloudflare: 'connected' | 'disconnected' | 'absent'
  tailnet: SiteTailnetState
  siteDomain?: string
}

/** A routine as the snapshot carries it. */
export interface RoutineEntry {
  id: string
  projectId: string
  name: string
  cron: string
  timeZone: string
  /** Absent for a non-interactive routine, whose runs open no session. */
  prompt?: string
  tool: AgentTool
  model: string
  modelName?: string
  mode: AgentMode
  permissionMode: PermissionMode
  effort?: string
  agentOptions: AgentOptions
  /** What each run starts with. */
  selection: RepoSelection
  /** The named workflow its runs start with; absent runs the project's
   *  init steps. */
  workflow?: string
  nonInteractive?: true
  groupId?: string
  /** Each run's timeout; absent stops each run at the next tick. */
  timeoutMinutes?: number
  paused: boolean
  /** The next three ticks (ISO); empty while paused. */
  nextRuns: string[]
  /** The last tick that fired (ISO). */
  lastRunAt?: string
  /** Why its newest run has not launched, if that run failed. */
  lastError?: string
  /** 'YYYY-MM-DD HH:MM:SS' (UTC). */
  createdAt: string
}

/** One run of a routine, as its history lists it. */
export interface RoutineRunEntry {
  /** The queued entry the run was. */
  id: string
  /** The tick it was for (ISO). */
  startAt?: string
  title?: string
  /** `waiting`: not launched yet. `failed`: its launch failed. The rest
   *  describe the workspace it became: `ended` was stopped at the next tick
   *  (a routine with no timeout), `timed-out` at the routine's timeout. */
  state: 'waiting' | 'failed' | 'running' | 'stopped' | 'ended' | 'timed-out' | 'died'
  launchError?: string
  workspaceId?: string
  /** When the server stops it (ISO), while running. */
  deadline?: string
  deathReason?: WorkspaceDeathReason
}

/** One page of `GET /routine/runs`, newest first. */
export interface RoutineRunPage {
  runs: RoutineRunEntry[]
  /** Pass back as `cursor` for the next page; absent on the last one. */
  nextCursor?: string
}

/**
 * The new-workspace pane's fields as a draft keeps them
 * (docs/draft-workspaces.md). `model`, and `repos` (each row's repo, by id
 * or folder, with its branch), `nested` and `cwd`, are absent if the pane
 * hadn't resolved them; `startAfter` is the parent workspace or queued entry
 * id, absent for "Now"; `title` is absent if left blank.
 */
export const draftWorkspaceSettingsSchema = queuedWorkspaceSettingsSchema.omit({ branch: true, commit: true, steps: true, nonInteractive: true }).extend({
  tool: z.enum(AGENT_TOOLS),
  mode: z.enum(AGENT_MODES),
  permissionMode: z.enum(PERMISSION_MODES),
  startAfter: z.string().min(1).optional(),
  groupId: z.string().min(1).optional(),
  /** An `At a time…` Start, as an ISO instant. */
  startAt: z.iso.datetime({ offset: true }).optional(),
  /** An `On a schedule…` Start: the routine's cron and zone, checked only
   *  when a routine is created from the draft. */
  cron: z.string().min(1).max(100).optional(),
  timeZone: z.string().min(1).max(64).optional(),
})

export type DraftWorkspaceSettings = z.infer<typeof draftWorkspaceSettingsSchema>

/** A new-workspace pane's contents the user kept instead of running. */
export interface DraftWorkspaceEntry extends DraftWorkspaceSettings {
  id: string
  projectId: string
  /** Generated from the prompt; never set for a draft with a `title`. */
  generatedTitle?: string
  /** 'YYYY-MM-DD HH:MM:SS' (UTC). */
  createdAt: string
  updatedAt: string
}

/**
 * A stopped workspace that queued workspaces still wait on, kept in the
 * sidebar until the last of them launches or is discarded. Slimmer than
 * `StoppedWorkspaceEntry` because the snapshot rebuilds on every change and
 * can't afford transcript stats.
 */
export interface HeldWorkspaceEntry {
  workspaceId: string
  projectId: string
  /** The sessions it had open when it stopped. */
  sessions: SessionEntry[]
  title?: string
  prompt?: string
  groupId?: string
  /** 'YYYY-MM-DD HH:MM:SS' (UTC). */
  stoppedAt: string
  deathReason?: WorkspaceDeathReason
  deathDetail?: string
  timedOut?: true
  endedAtNextRun?: true
  deathSeenBy: string[]
}

/** Named step in a project's image chain, in build order. */
export type ImageLayerName = 'base' | 'tools' | 'nestable' | 'project' | 'user'

/**
 * An image build tracked in server memory. The snapshot
 * carries metadata only; the log tail comes from
 * `GET /image/builds/:id/log`.
 */
export interface ImageBuildEntry {
  id: string
  tag: string
  /** The chain step. */
  layer: ImageLayerName
  /** Every project that requested this tag. */
  projectIds: string[]
  reason: 'session' | 'prewarm'
  status: 'running' | 'succeeded' | 'failed'
  /** Parsed from podman's `STEP N/M: <instruction>` output lines. */
  stepCurrent?: number
  stepTotal?: number
  stepText?: string
  error?: string
  /** 'YYYY-MM-DD HH:MM:SS' UTC, same shape as provisioning `createdAt`. */
  startedAt: string
  finishedAt?: string
}

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip'

/** One line of `yaac cluster check`. */
export interface CheckResult {
  name: string
  status: CheckStatus
  detail: string
  /** Actionable fix instructions, printed only on fail/warn. */
  fix?: string
}

/**
 * Which substrate a server runs workspaces on. `k8s` runs each workspace as
 * a single-pod Job built from an image, behind an egress proxy.
 * `containerless` runs it as a tmux server on the host in the checkout, with
 * no image, proxy or sandbox.
 *
 * Sent to the webapp because a containerless server has no Dockerfile,
 * builds or blocked hosts to show. The driver contract re-exports it and
 * says when callers may branch on it.
 */
export type DriverKind = 'k8s' | 'containerless'

/**
 * What the server health overlay shows (`GET /server/usage`,
 * docs/server-health.md): the install's CPU, memory and disk, split by node,
 * infrastructure component and workspace, each with an hour of history.
 */

/** CPU and memory in use at one instant. Memory is the working set under
 *  `k8s` and RSS under `containerless`. */
export interface ResourceUse {
  cpuCores: number
  memoryBytes: number
}

/** One minute's sample of a series. */
export interface UsagePoint extends ResourceUse {
  /** Epoch ms. */
  at: number
}

/** One filesystem or volume. `usedBytes` is null for a volume that reports
 *  no usage (hostPath, kind's local-path), whose capacity alone is known. */
export interface VolumeUsage {
  name: string
  usedBytes: number | null
  capacityBytes: number | null
}

export interface UsageTotals extends ResourceUse {
  cpuCapacityCores: number
  memoryCapacityBytes: number
  swapBytes: number
  swapCapacityBytes: number
  /** One per filesystem, since a summed number would mean nothing. */
  disks: VolumeUsage[]
  /** `k8s` only: pod requests against allocatable capacity, which decides
   *  whether the next workspace can be scheduled. */
  scheduled?: {
    cpuRequestCores: number
    cpuAllocatableCores: number
    memoryRequestBytes: number
    memoryAllocatableBytes: number
  }
}

/** Which work a node takes (docs/cluster-setup.md "A dedicated workspace
 *  node pool"); `gvisor-pending` until its sandbox runtime is installed. */
export type NodeRole = 'infrastructure' | 'workspaces' | 'both' | 'gvisor-pending'

export interface NodeUsage extends ResourceUse {
  name: string
  role: NodeRole
  cpuCapacityCores: number
  memoryCapacityBytes: number
  swapBytes: number
  swapCapacityBytes: number
  /** Conditions that are not as they should be (`NotReady`,
   *  `MemoryPressure`, …). */
  conditions: string[]
  /** When the kubelet took the node's sample, epoch ms. */
  sampledAt: number | null
  /** Why the node's stats are missing. */
  error?: string
}

/** One infrastructure row: a yaac component, or what is left of the host
 *  or node once yaac's own usage is taken out. */
export interface ComponentUsage extends ResourceUse {
  /** Stable across samples; keys the history series. */
  key: string
  label: string
  /** Pods or processes summed into the row, for a row that sums several. */
  count?: number
  /** The volumes it owns. A volume several components mount is listed
   *  under the first. */
  volumes: VolumeUsage[]
  /** Per-project rows, under the project registries. */
  children?: Array<ComponentUsage & { projectId: string }>
}

/** What the substrate reports for one workspace. */
export interface WorkspaceResourceUse extends ResourceUse {
  memoryLimitBytes: number | null
  ephemeralStorageBytes: number | null
  node?: string
}

export type WithHistory<T> = T & { history: UsagePoint[] }

/** A workspace row: live while it runs, then its last hour until that
 *  history ages out. */
export interface WorkspaceUsageRow extends WorkspaceResourceUse {
  workspaceId: string
  running: boolean
  title?: string
  projectId?: string
  projectName?: string
  /** The owning user's display name. */
  owner?: string
  peakMemoryBytes: number
  deathReason?: WorkspaceDeathReason
  deathDetail?: string
  history: UsagePoint[]
}

export interface ResourceReport {
  driver: DriverKind
  /** Epoch ms. */
  sampledAt: number
  totals: WithHistory<UsageTotals>
  nodes: Array<WithHistory<NodeUsage>>
  components: Array<WithHistory<ComponentUsage>>
  workspaces: WorkspaceUsageRow[]
}

/**
 * Which callers an install admits (docs/remote-hosting.md "Access modes"):
 * `local` admits only loopback, as the one built-in user; `tailnet` admits
 * only requests through `tailscale serve`, each as its tailnet user. Recorded
 * in the install's database and checked on every start.
 */
export type AccessMode = 'local' | 'tailnet'

/**
 * Who a request came from (`GET /whoami`, docs/remote-hosting.md). `local`
 * reached the server directly (loopback, or a nested server's direct path)
 * and is the install's built-in user. `tailnet` came through `tailscale
 * serve`, which stamped the tailnet user's login and display name on it.
 * `userId` is the caller's `users` row.
 */
export type Principal =
  | { kind: 'local'; userId: string }
  | { kind: 'tailnet'; userId: string; login: string; name: string }

/** A user's install-wide role (docs/multi-user.md "Roles"): an `admin`
 *  publishes sites and sets roles; a `member` does neither. */
export type UserRole = 'admin' | 'member'

/** A user of the install. `login` is null only for the built-in user of a
 *  `local` install. */
export interface User {
  id: string
  login: string | null
  name: string
  role: UserRole
}

/** An admin, as the server's admin socket lists them to `--admin`'s
 *  revoke check: `signedIn` is false for a login a start named that has
 *  not reached the server yet. */
export interface AdminEntry {
  login: string | null
  name: string
  signedIn: boolean
}

/** `GET /whoami`: the caller, and every user of the install. */
export type Whoami = Principal & { users: User[] }

/**
 * All server-owned state the webapp renders, sent as a `snapshot` event on
 * connect and replaced whole on each later one. Every `prompt` in it is a
 * preview (`PROMPT_PREVIEW_LENGTH`, `CONVERSATION_PROMPT_PREVIEW_LENGTH`).
 */
export interface ServerSnapshot {
  /** Which substrate this server runs — see `DriverKind`. */
  driver: DriverKind
  /** The host this server forwards feedback to (docs/feedback.md), which
   *  the form names; null when it has no endpoint, which hides the form. */
  feedbackHost: string | null
  workspaces: WorkspaceListEntry[]
  /** Every project's sidebar groups, hidden ones included (the client
   *  decides visibility from the members). */
  workspaceGroups: WorkspaceGroupSummary[]
  stale: StaleWorkspaceInfo[]
  projects: ProjectSummary[]
  provisioning: ProvisioningWorkspaceEntry[]
  /** Every user's project adds in flight or failed, oldest first. */
  projectAdds: ProjectAddEntry[]
  /** Every project's queued workspaces not currently launching, oldest
   *  first. A launching one appears as a provisioning row. */
  queuedWorkspaces: QueuedWorkspaceEntry[]
  /** Stopped workspaces that queued workspaces still wait on. */
  heldWorkspaces: HeldWorkspaceEntry[]
  /** Every project's draft workspaces, oldest first. */
  draftWorkspaces: DraftWorkspaceEntry[]
  /** Every project's routines, oldest first. */
  routines: RoutineEntry[]
  /** See `ActiveWorkspacesResult.gitAuthFailures`. */
  gitAuthFailures: Record<string, GitAuthFailure[]>
  imageBuilds: ImageBuildEntry[]
  /** Each user's Claude subscription plan usage, by user id
   *  (domain/auth/plan-usage.ts); a user with no tool sign-in is absent.
   *  Null until the first refresh after a webapp client connects. */
  planUsage: Record<string, PlanUsageResult | null>
  /** Each user's Codex (ChatGPT) plan usage, by user id. Null until the
   *  first refresh, or without a ChatGPT (OAuth) sign-in. */
  codexPlanUsage: Record<string, PlanUsageResult | null>
}

/** Messages the server pushes over `/events`. */
export type ServerEvent =
  | { type: 'snapshot'; data: ServerSnapshot }

/**
 * The desktop shell's Servers page, over its preload bridge (`window.yaacServer`).
 */
export interface DesktopServerSelection {
  url: string
}

export interface DesktopServerTargets {
  /** The selected origin, or null when this machine has none. */
  current: string | null
  /**
   * Origins of every server configured and not since removed
   * (`server.json`'s `saved`).
   */
  saved: string[]
}

/**
 * After a switch or add, success means the shell is about to reland the
 * window on that server; after a remove, the window stays where it is.
 */
export type DesktopServerOutcome =
  | { ok: true }
  | { ok: false; error: string }

/**
 * One of this machine's servers as `yaac server|cluster status --json`
 * reports it, read from the server lock in that install's data dir. The
 * desktop tray starts, stops and restarts the server from it.
 */
export interface LocalServerStatus {
  /** null when this machine cannot read the lock (a `--byo` install's is on the cluster). */
  running: boolean | null
  /** The install's recorded driver; null before any server was started. */
  driver: DriverKind | null
  /** The running server's build; null when none runs. */
  serverBuildId: string | null
  /** The build of the CLI that answered, the one `yaac server restart` would start. */
  cliBuildId: string
  /** The origin the install's server last registered at; null before it ever did. */
  origin: string | null
  /**
   * Why the running server refused to start, from its `/health`. It stays up
   * serving nothing else until restarted. null when none runs or it did not refuse.
   */
  refused: string | null
  /**
   * Whether the running server's `/health` answered: false for a server that
   * runs but hangs, or whose origin is unreachable from here. null when none
   * runs or there is nowhere to ask (a pod's lock and no cluster origin).
   */
  reachable: boolean | null
}

/**
 * Which of this Mac's installs: the host server (containerless) or a kind
 * cluster's. Also the id of the setup that creates it, the only thing a
 * renderer sends to start one.
 */
export type DesktopLocalScope = 'server' | 'cluster'

/** One of this Mac's installs as the desktop app shows it. */
export type DesktopInstallState =
  | 'missing'
  | 'stopped'
  | 'running'
  /** Running a different build than the installed CLI. */
  | 'outdated'
  /** A `--byo` cluster's server, whose lock this Mac cannot read. */
  | 'elsewhere'
  /** `yaac … status` failed, e.g. an older CLI without `cluster status`. */
  | 'unavailable'

export type DesktopSetupStepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled'

export interface DesktopSetupStep {
  label: string
  /** The command line, as a user would type it. */
  command: string
  state: DesktopSetupStepState
  /** Why a step was skipped, or how it failed. */
  note?: string
}

/** A setup the desktop app runs in the background, from its first step to the last. */
export interface DesktopSetupRun {
  scope: DesktopLocalScope
  phase: 'running' | 'succeeded' | 'failed' | 'cancelled'
  steps: DesktopSetupStep[]
  /** The last lines the commands printed. */
  log: string[]
  error?: string
  /** `yaac host check`'s failing lines after a containerless start. */
  hostCheckFailures?: string
}

export interface DesktopSetupChoice {
  scope: DesktopLocalScope
  /** What a user would run in a terminal for the same result. */
  commands: string[]
  /** Why the app cannot run this setup itself: not an Apple silicon Mac, or no Homebrew. */
  blocked: 'unsupported' | 'no-brew' | null
}

/** This Mac's installs, their setups, and what the app is doing to them. */
export interface DesktopLocalState {
  /** Whether a `yaac` CLI is on PATH. */
  cli: boolean
  brew: boolean
  /** null until read, and for a host data dir that is itself the cluster install. */
  installs: Record<DesktopLocalScope, DesktopInstallState | null>
  /** The origin each install's server last registered at; null before it ever did. */
  origins: Record<DesktopLocalScope, string | null>
  busy: { scope: DesktopLocalScope; action: 'setup' | 'start' | 'stop' | 'restart' } | null
  /** The setup under way, or the last one to finish. */
  setup: DesktopSetupRun | null
  choices: Record<DesktopLocalScope, DesktopSetupChoice>
}


/**
 * Cap on a recorded model id. Model ids come from the agent (a tmux pane
 * option anything in the workspace can set, or an adapter's reply), so they
 * could otherwise be any length.
 */
export const MAX_MODEL_LENGTH = 128

/**
 * What a workspace's agent may ask its own yaac server to do, via the
 * in-workspace `yaac-mama` command.
 *
 * This list is the allowlist, enforced where requests are answered
 * (`runMamaCommand`), so no transport can widen it.
 *
 * `stop` is allowed because a stop is reversible: the checkout, row, title,
 * group and conversation are kept, so it can be restarted. `restart` only
 * undoes a stop, and only for a workspace at or below the caller's
 * permission mode, as does `run-queued` for a queued one. `group-set-limit`
 * caps how many of a group's workspaces run at once, which an orchestrating
 * agent sets for the workers it queues there (docs/workspace-groups.md). Any
 * agent may raise or clear a limit, its own group's included, so a limit
 * schedules agents and does not contain them. `delete-queued` discards a
 * queued workspace, which loses only a prompt that never ran; deleting a
 * workspace stays the user's.
 * The `routine-*` commands manage routines (docs/routines.md) on the same
 * terms as the queue commands: what a routine launches is held to the
 * caller's permission mode. `routine-delete` loses a schedule, its prompt
 * and the run history it lists, but no run's workspace, and runs already
 * started keep going.
 * `fetch` reads another workspace's branches into the caller's checkout, and
 * `history` its conversations, never writing to theirs. `send` messages a
 * running one's agent, held to the caller's permission mode. `set-base`
 * changes only the caller's own reference branch. `as-repo` answers the
 * `GH_TOKEN` value that stands for another of the project's repos, which
 * the project's link must allow (docs/project-repos.md). `icon-get` reads the
 * project's one picture, and `icon-set` and `icon-remove` replace or drop
 * it, which every viewer of the project sees and whose previous version is
 * not kept; like a `rename` title, it changes what people see and nothing
 * that runs. `workflow-list` and `workflow-show` read the project's
 * workflows (docs/workflows.md), which `create` and `routine-*` may run by
 * name; no command edits one.
 */
export const MAMA_COMMANDS = [
  'list',
  'create',
  'rename',
  'set-base',
  'as-repo',
  'icon-get',
  'icon-set',
  'icon-remove',
  'stop',
  'restart',
  'rerun',
  'status',
  'group-create',
  'group-move',
  'group-set-limit',
  'models',
  'queue',
  'edit-queued',
  'run-queued',
  'delete-queued',
  'routine-create',
  'routine-edit',
  'routine-pause',
  'routine-resume',
  'routine-run',
  'routine-delete',
  'fetch',
  'history',
  'send',
  'volumes',
  'logs',
  'workflow-list',
  'workflow-show',
] as const
export type MamaCommand = (typeof MAMA_COMMANDS)[number]
