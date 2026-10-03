import { z } from 'zod'
import {
  parseOpencodeProvider,
  parsePiProvider,
  type OpencodeProvider,
  type PiProvider,
} from '#tool-providers'

export type AgentTool = 'claude' | 'codex' | 'opencode' | 'pi'

export const AGENT_TOOLS: readonly AgentTool[] = ['claude', 'codex', 'opencode', 'pi']

/** Each tool's product name, for messages that name it in full. */
export const TOOL_LABELS: Record<AgentTool, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
}

/**
 * The tools that choose their own conversation ids. claude and pi launch
 * under an id yaac picks (the workspace id, for a create), but codex and
 * opencode take none, so the recorded id is a stand-in until the pane
 * reports the real one.
 */
export const SELF_NAMING_TOOLS: readonly AgentTool[] = ['codex', 'opencode']

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
 * An agent conversation id from outside the server, checked before it is
 * joined into a path (`acp/<ws>/<id>.jsonl`) or a launch command
 * (`--resume <id>`). It must start with a letter or digit so it can't be read
 * as a flag. Fits UUIDs (claude, codex, pi) and opencode's `ses_…` ids.
 */
export const agentSessionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)

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

/**
 * Each tool's agent CLI, pinned. `dockerfiles/Dockerfile.tools` installs the
 * same versions (a test checks) and so does a host install.
 *
 * yaac launches permission postures as each CLI's flags or config and reads
 * the CLI's reports back as postures (docs/permission-modes.md). A release
 * that changes either can fail silently, so bump a version only after
 * re-checking both against the new binary. Bump the matching
 * `ACP_ADAPTERS` entry with it, since codex-acp and pi-acp depend on their
 * CLI's version.
 */
export const AGENT_CLIS = {
  claude: { package: '@anthropic-ai/claude-code', version: '2.1.286' },
  codex: { package: '@openai/codex', version: '0.159.3' },
  opencode: { package: '@opencode/cli', version: '2.0.21' },
  pi: { package: '@earendil-works/pi-coding-agent', version: '0.99.2' },
} as const satisfies Record<AgentTool, { package: string; version: string }>

/**
 * The ACP adapter each tool uses in `acp` mode. The image install steps, the
 * host preflight and the driver's launch profiles all derive from this.
 *
 * `needsCli`: the adapter drives the CLI (codex-acp runs `codex app-server`,
 * pi-acp runs `pi --mode rpc`), so the CLI must be on PATH. claude's adapter
 * bundles its own SDK; opencode's adapter is the CLI itself (`opencode acp`).
 *
 * `verified`: the version whose advertised session modes yaac maps to
 * permission postures. An adapter that drops a mode fails silently, so a
 * test ties this to `dockerfiles/Dockerfile.tools`, and host installs use it.
 */
export const ACP_ADAPTERS = {
  claude: {
    binary: 'claude-agent-acp',
    package: '@agentclientprotocol/claude-agent-acp',
    verified: '0.84.0',
    needsCli: false,
  },
  codex: {
    binary: 'codex-acp',
    package: '@agentclientprotocol/codex-acp',
    verified: '2.1.0',
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
 */
export const SUPPORTED_PERMISSION_MODES: Record<AgentTool, readonly PermissionMode[]> = {
  claude: ranked('bypass', 'auto', 'accept-edits', 'manual', 'plan'),
  codex: ranked('bypass', 'auto', 'accept-edits', 'read-only'),
  opencode: ranked('bypass', 'accept-edits', 'manual', 'plan'),
  pi: ranked('bypass'),
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
 * What one agent was last created with in a project
 * (`project_tool_defaults`). Each field is absent until first picked.
 */
export interface ToolCreateDefaults {
  model?: string
  permissionMode?: PermissionMode
  mode?: AgentMode
}

/**
 * The model and posture a create for `tool` runs with when the request names
 * neither: what the project remembers for that agent where it still fits,
 * else the fallback. Both the create form and the server call this, so the
 * form shows what an untouched create would run.
 *
 * A remembered posture the tool lacks goes through
 * `launchablePermissionMode`. A remembered opencode/pi model must name the
 * credential's current provider; any claude or codex model stands, since the
 * catalog is not an allowlist.
 */
export function resolveToolCreateDefaults(args: {
  driver: DriverKind
  tool: AgentTool
  remembered: ToolCreateDefaults | undefined
  /** opencode / pi: the provider the stored credential authenticates against. */
  provider?: string
  /** What the tool runs when nothing is remembered (`defaultModelFor`). */
  defaultModel: string
}): { model: string; permissionMode: PermissionMode } {
  const { driver, tool, remembered, provider } = args
  const posture = remembered?.permissionMode
  const model = remembered?.model
  const qualified = tool === 'opencode' || tool === 'pi'
  const modelFits = model !== undefined
    && (!qualified || provider === undefined || model.startsWith(`${provider}/`))
  return {
    model: modelFits ? model : args.defaultModel,
    permissionMode: posture !== undefined
      ? launchablePermissionMode(tool, posture)
      : defaultPermissionMode(driver, tool),
  }
}

export type ToolAuthKind = 'api-key' | 'oauth'

/**
 * Credential kinds `yaac auth fake` can seed: a placeholder credential, never
 * a real secret, so an inner yaac authenticates through the outer yaac's
 * proxy (see packages/server/src/domain/projects/fake-auth.ts). Shared by the
 * CLI's choices and the server route's validator.
 */
export const FAKE_AUTH_KINDS = [
  'claude-oauth',
  'opencode-openrouter',
  'pi-openrouter',
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
 * Shape of the server's `.credentials/claude.json`: OAuth with a full bundle,
 * or a single sk-ant-api03-… API key.
 */
export const claudeCredentialsFileSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('oauth'), savedAt, claudeAiOauth: claudeOAuthBundleSchema }),
  apiKeyCredentialSchema.extend({ savedAt }),
])
export type ClaudeCredentialsFile = z.infer<typeof claudeCredentialsFileSchema>

/**
 * Shape of the server's `.credentials/codex.json`: OAuth with a full bundle,
 * or an API key.
 */
export const codexCredentialsFileSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('oauth'), savedAt, codexOauth: codexOAuthBundleSchema }),
  apiKeyCredentialSchema.extend({ savedAt }),
])
export type CodexCredentialsFile = z.infer<typeof codexCredentialsFileSchema>

/**
 * Shape of the server's `.credentials/opencode.json`: an api key for one
 * provider in the generated registry (`tool-providers.ts`). `provider` picks
 * the env var and the host the proxy swaps the key on; a file whose provider
 * is missing or unknown fails to parse rather than defaulting, which could
 * send the key to the wrong vendor.
 */
export const opencodeCredentialsFileSchema = apiKeyCredentialSchema.extend({
  savedAt,
  provider: z.custom<OpencodeProvider>(
    (v) => typeof v === 'string' && parseOpencodeProvider(v) !== undefined,
    'provider is missing or not in this build\'s registry',
  ),
})
export type OpencodeCredentialsFile = z.infer<typeof opencodeCredentialsFileSchema>

/** Shape of the server's `.credentials/pi.json`; like opencode's. */
export const piCredentialsFileSchema = apiKeyCredentialSchema.extend({
  savedAt,
  provider: z.custom<PiProvider>(
    (v) => typeof v === 'string' && parsePiProvider(v) !== undefined,
    'provider is missing or not in this build\'s registry',
  ),
})
export type PiCredentialsFile = z.infer<typeof piCredentialsFileSchema>

/**
 * The `PUT /auth/:tool` body. The server checks it against the named tool:
 * an OAuth bundle must be that tool's, and opencode/pi need a provider from
 * their registry, rejected rather than defaulted when missing or unknown.
 */
export const toolAuthPayloadSchema = z.discriminatedUnion('kind', [
  apiKeyCredentialSchema.extend({ provider: z.string().optional() }),
  z.object({
    kind: z.literal('oauth'),
    bundle: z.union([claudeOAuthBundleSchema, codexOAuthBundleSchema]),
  }),
])
export type ToolAuthPayload = z.infer<typeof toolAuthPayloadSchema>

/**
 * The four tool credential files as one value, handed to a runtime whose
 * proxy injects credentials whenever the host store changes. `null` means
 * signed out.
 */
export interface ToolCredentialBundle {
  claude: ClaudeCredentialsFile | null
  codex: CodexCredentialsFile | null
  opencode: OpencodeCredentialsFile | null
  pi: PiCredentialsFile | null
}

/**
 * OAuth bundles a runtime's egress proxy captured from a workspace's token
 * refresh that the host store has not adopted yet. Each slot is the newest
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
  /** Access token (OAuth) or raw API key. */
  apiKey: string
  savedAt: string
}

/**
 * A stored credential, discriminated on `tool` so the provider is required
 * for opencode and pi. This keeps a consumer from falling back to a default
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
  })
  | (ToolAuthEntryBase & {
    tool: 'pi'
    /** Which provider the stored api-key authenticates against. */
    piProvider: PiProvider
  })

export interface ProjectMeta {
  slug: string
  remoteUrl: string
  addedAt: string
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
  /** Hostnames to match (exact or wildcard like *.example.com) */
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
 * Object form of an `initCommands` entry. Each spec gets its own tmux window,
 * so several long-running processes can run side by side.
 */
export interface InitCommandSpec {
  /** tmux window name. Must be unique, kebab-ish, and must not collide
   *  with the agent window name (claude/codex/opencode/pi). */
  name: string
  /** Commands chained with `&&` inside this window. */
  commands: string[]
  /** Per-window override for `hideInitPane`. Defaults to the top-level
   *  `hideInitPane`, which itself defaults to false. */
  hidePane?: boolean
}

/**
 * A project's config overlay (`config/yaac-config.json`), edited through the
 * server so a client needs no shell on its host. Env vars and secrets are
 * rows (`ProjectEnvVar`), not keys here, and there are no host-directory
 * mounts: both would need a shell on the server machine to set up.
 */
export interface YaacConfig {
  cacheVolumes?: Record<string, string>
  /**
   * Run an in-pod rootful podman so `docker` commands work inside
   * workspaces (docs/nested-containers.md).
   */
  nestedContainers?: boolean
  /**
   * Whether the project's workspaces may use the install's npm cache (k8s
   * only). When false, a workspace can't reach it and fetches from npmjs
   * through the egress proxy. Unset → true.
   */
  npmCache?: boolean
  /** Either a flat string list (collapsed into a single `init` window) or
   *  a list of `InitCommandSpec` objects (one tmux window per entry).
   *  Mixing the two forms is rejected by the config parser. */
  initCommands?: string[] | InitCommandSpec[]
  portForward?: PortForwardConfig[]
  hideInitPane?: boolean
  addAllowedUrls?: string[]
  setAllowedUrls?: string[]
  /**
   * Paths (relative to /workspace) of installed-package dirs that belong to
   * the workspace's runtime rather than the shared checkout. A pod backs each
   * with a pod-local volume; a host workspace keeps them in its checkout.
   * Removed at stop. Unset → `["node_modules"]`; empty disables.
   */
  ephemeralModulesPaths?: string[]
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
  /** The projects that authenticate with it. */
  projects: string[]
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
}

export interface AuthListResult {
  gitCredentials: GitCredentialSummary[]
  toolAuth: ToolAuthSummary[]
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
 * One agent conversation inside a workspace. Several can be live at once
 * (a second terminal, or a `/clear` that left the old window open); the
 * rest are the workspace's history.
 */
export interface AgentSessionEntry {
  /** The tool's own conversation id, not yaac's. */
  agentSessionId: string
  tool: AgentTool
  /** Which protocol drives it, and so which pane renders it. Absent means
   *  `tui`. */
  mode?: AgentMode
  /** Restore order; 0 is the workspace's original agent. */
  ordinal: number
  /** Had a live agent process when the workspace was last seen running, so
   *  a restart brings it back. */
  active: boolean
  /** Live only: this conversation's own busy/idle, from its pane. */
  status?: 'running' | 'waiting'
  /** Live only: epoch ms when this conversation's waiting spell began. */
  waitingSinceMs?: number
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

export interface WorkspaceListEntry {
  workspaceId: string
  projectSlug: string
  tool: AgentTool
  /**
   * `waiting` if any of its agent sessions is waiting, else `running`.
   */
  status: 'running' | 'waiting'
  /** The workspace is being torn down (its pod has a deletion timestamp,
   *  or a stop was just issued). Render a non-interactive "stopping…"
   *  placeholder. */
  stopping?: boolean
  /** Pod created time as 'YYYY-MM-DD HH:MM:SS' (UTC). */
  createdAt: string
  /** Epoch ms when the current waiting spell began; set only while
   *  `waiting`. The earliest waiting agent's time wins. Kept in server
   *  memory, so it is absent after a server restart. */
  waitingSinceMs?: number
  /** The first user message of the workspace's first agent session;
   *  survives a `/clear`. */
  prompt?: string
  /** User-assigned display title (falls back to `prompt` in UIs). */
  title?: string
  /** Every conversation the workspace has hosted, in restore order. */
  agentSessions: AgentSessionEntry[]
  /** Its tmux windows other than the agent's, which the webapp opens as
   *  terminal panes. Absent until the server first lists them (unknown, not
   *  none) and while the workspace is stopping. */
  terminals?: WorkspaceTerminalEntry[]
  blockedHosts: string[]
  /** Live host→container forwards. Briefly empty after a server restart,
   *  until the restore pass runs. */
  forwardedPorts: PortMapping[]
  /** Ports with a live listener in the workspace that aren't forwarded,
   *  dismissed, sensitive or infra. Drives the "forward this port?"
   *  badge. */
  unforwardedPorts: number[]
  /** The branch this workspace forked from (its reference branch), as its
   *  row records it. Unset when the row records none. */
  baseBranch?: string
  /** The sidebar group this workspace is filed under (see
   *  `WorkspaceGroupSummary`); absent means ungrouped. Kept through stop and
   *  restart. */
  groupId?: string
  /** The permission posture its agents run in; a workspace queued after
   *  this one defaults to it. Absent until its row is written. */
  permissionMode?: PermissionMode
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
  projectSlug: string
  name: string
  /** Keep the group listed even with no live workspace in it. */
  pinned: boolean
  /** 'YYYY-MM-DD HH:MM:SS' (UTC) — the groups' display order. */
  createdAt: string
}

/** How a file changed, mapped from git's name-status letters. */
export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange'

/** One changed file in a workspace, relative to the fork base. */
export interface WorkspaceChange {
  path: string
  status: ChangeStatus
  additions: number
  deletions: number
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
export interface WorkspaceChanges {
  /** The base commit the diff is taken against (merge-base with the fork
   *  point), or HEAD when no upstream is resolvable. */
  base: string
  /** False when `base` fell back to HEAD. The diff then covers only
   *  uncommitted work, and an empty `files` must not read as "no changes". */
  baseResolved: boolean
  files: WorkspaceChange[]
  /** The combined unified diff; the client splits it into per-file hunks.
   *  Capped for size — see `truncated`. */
  diff: string
  /** True when the diff body was capped for size; `files` stays complete. */
  truncated: boolean
}

/** Where a workspace's HEAD stands against its reference branch, for the
 *  status bar. `behind` is only as fresh as `fetchedAt`. */
export interface WorkspaceGitStatus {
  /** The branch compared against; null when nothing records one. */
  base: string | null
  /** Null when `base` resolves to no branch, remote or local. */
  comparison: {
    /** `origin/<base>`, or `<base>` for a branch that was never pushed. */
    ref: string
    ahead: number
    behind: number
    /** When `ref` was last fetched, 'YYYY-MM-DD HH:MM:SS' (UTC); absent for
     *  a local branch or when no fetch is on record. */
    fetchedAt?: string
  } | null
}

/**
 * A file's git status in the file explorer — what differs from HEAD, staged
 * and unstaged alike. Deletions are absent: a deleted file is not in the tree.
 */
export type FileStatus = 'modified' | 'added' | 'untracked' | 'conflicted'

/** Where a symlink in a workspace leads: its resolved path relative to the
 *  workspace, or null when it is broken or leads outside the workspace. */
export interface SymlinkTarget {
  target: string | null
  dir: boolean
}

/** Every path in a workspace's checkout, for the file explorer. */
export interface WorkspaceFiles {
  /** Tracked and untracked files, gitignore-aware, deleted ones removed. */
  paths: string[]
  /** The entries of `paths` that are symlinks. */
  symlinks: Record<string, SymlinkTarget>
  /** Ignored files, and wholly ignored folders as one `dir/` entry each. */
  ignored: string[]
  /** Folders holding no path of `paths`, which the list alone cannot show. */
  emptyDirs: string[]
  status: Record<string, FileStatus>
  /** True when `paths` was capped. */
  truncated: boolean
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
 * Where a skill was found. Personal/plugin/project are loose `SKILL.md`
 * files. `system` is built in: an agent's bundled skills (`sourceLabel`
 * `bundled`) and the skills yaac injects into every workspace
 * (`sourceLabel` `yaac`; see packages/server/src/domain/skills).
 */
export type SkillSource = 'personal' | 'plugin' | 'project' | 'system'

/** One discovered agent skill (a `SKILL.md`), summarized for a listing. */
export interface SkillSummary {
  /** Stable, source-qualified id used to fetch the full body. */
  id: string
  /** Invocation name — frontmatter `name`, else the skill directory name. */
  name: string
  /** `description` with `when_to_use` appended. Empty when the frontmatter is
   *  absent or malformed (the skill still loads, per Claude Code semantics). */
  description: string
  source: SkillSource
  /** For plugin skills, the plugin the skill came from. */
  sourceLabel?: string
  /** False when frontmatter sets `user-invocable: false` (hidden from `/`). */
  userInvocable: boolean
  /** False when frontmatter sets `disable-model-invocation: true`. */
  modelInvocable: boolean
  /** Parsed `allowed-tools` (space/comma string or YAML list), if present. */
  allowedTools?: string[]
  /** Set when a higher-precedence skill shares this name (personal > project). */
  shadowedBy?: SkillSource
}

/** All personal + plugin + project skills available to a project's agent. */
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
  projectSlug: string
  workspaceId: string
  /** True when the pod is still running but tmux is gone. */
  zombie: boolean
  /** Terminal-state evidence for the reap, when the pod carried any. */
  deathCause?: WorkspaceDeathCause
}

export interface ActiveWorkspacesResult {
  workspaces: WorkspaceListEntry[]
  stale: StaleWorkspaceInfo[]
  /** Project slug -> git credentials the upstream rejected. Only projects
   *  with a failing host appear. */
  gitAuthFailures: Record<string, GitAuthFailure[]>
}

export interface StoppedWorkspaceEntry {
  workspaceId: string
  projectSlug: string
  tool: AgentTool
  /** 'YYYY-MM-DD HH:MM:SS' (UTC). Workspace birth time. */
  createdAt: string
  /** Last activity as 'YYYY-MM-DD HH:MM:SS' (UTC): the newest transcript
   *  mtime across all its conversations, else the creation time (opencode
   *  leaves no host transcript). */
  lastActiveAt?: string
  /** When it was stopped, 'YYYY-MM-DD HH:MM:SS' (UTC); the sort key, newest
   *  first. Absent if removed out-of-band (sorted by `lastActiveAt`). */
  stoppedAt?: string
  /** The first conversation's first user message. */
  prompt?: string
  /** User-assigned display title. */
  title?: string
  /** Every conversation the workspace hosted, in restore order; a restart
   *  brings back the `active` ones. */
  agentSessions: AgentSessionEntry[]
  /** Why the workspace died, when the reaper (not the user) stopped it. */
  deathReason?: WorkspaceDeathReason
  /** Evidence accompanying `deathReason` (exit code, eviction message, …). */
  deathDetail?: string
  /** Whether the user has viewed this death's detail, which clears the
   *  notification dot. Stored on the workspace row so every client shares
   *  it; meaningful only with `deathReason`. */
  seen: boolean
  /** The sidebar group it is filed under; a stopped member shows as a ghost
   *  row there. */
  groupId?: string
}

/** A non-agent tmux window in a workspace the webapp can attach to: an
 *  initCommands window or a scratch shell. */
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
export interface ProjectSummary {
  slug: string
  remoteUrl: string
  addedAt: string
  workspaceCount: number
  /** The agent last created with; the create form opens on it. Absent
   *  before the first create (claude is assumed). */
  lastTool?: AgentTool
  /** The branch last named by a create; the create form's Branch field
   *  opens on it while origin still has it. */
  lastBranch?: string
  /** Per agent, what it was last created with here (see
   *  `resolveToolCreateDefaults`). */
  createDefaults: Partial<Record<AgentTool, ToolCreateDefaults>>
  /** The project's git credential. Without one it can't create
   *  workspaces. */
  gitCredential: { id: string; name: string } | null
}

/**
 * A create or restart in flight, tracked in server memory. The webapp shows
 * it as a sidebar row with live progress until the workspace exists or a
 * failure is dismissed.
 */
export interface ProvisioningWorkspaceEntry {
  workspaceId: string
  projectSlug: string
  tool: AgentTool
  kind: 'create' | 'restart'
  /** The model a create launches with, and its display name. Absent on a
   *  restart. */
  model?: string
  modelName?: string
  /** Latest progress line (e.g. 'Pulling image…'). */
  message: string
  /** Set when provisioning failed; the row stays until dismissed. */
  error?: string
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
 * shows exactly what will launch. Exactly one parent field is set: a
 * workspace, or another queued entry.
 */
export interface QueuedWorkspaceEntry {
  id: string
  projectSlug: string
  parentWorkspaceId?: string
  parentQueuedId?: string
  prompt: string
  tool: AgentTool
  model: string
  /** `model`'s display name, when the catalog has one. */
  modelName?: string
  mode: AgentMode
  permissionMode: PermissionMode
  /** The reference branch it forks from, fetched fresh at launch. */
  branch: string
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
}

/**
 * Cap on a prompt, both as a create or queue write takes it and as an opening
 * message is recorded. Shared so routes, the store and the discovery sweeps
 * apply the same bound.
 */
export const MAX_PROMPT_LENGTH = 10000

/**
 * A queued workspace's settings as a queue write takes them. A present field
 * overrides what would otherwise be resolved at launch; blank `title` leaves
 * the workspace to be auto-titled.
 */
export const queuedWorkspaceSettingsSchema = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  tool: z.enum(AGENT_TOOLS).optional(),
  model: z.string().regex(MODEL_RE).max(100).optional(),
  mode: z.enum(AGENT_MODES).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  branch: z.string().min(1).max(255).optional(),
  title: z.string().max(500).optional(),
})

/**
 * The create dialog's fields as a draft keeps them
 * (docs/draft-workspaces.md). `model` and `branch` are absent if the dialog
 * hadn't resolved them; `startAfter` is the parent workspace or queued entry
 * id, absent for "Now"; `title` is absent if left blank.
 */
export const draftWorkspaceSettingsSchema = queuedWorkspaceSettingsSchema.extend({
  tool: z.enum(AGENT_TOOLS),
  mode: z.enum(AGENT_MODES),
  permissionMode: z.enum(PERMISSION_MODES),
  startAfter: z.string().min(1).optional(),
  groupId: z.string().min(1).optional(),
})

export type DraftWorkspaceSettings = z.infer<typeof draftWorkspaceSettingsSchema>

/** A create-dialog's contents the user kept instead of running. */
export interface DraftWorkspaceEntry extends DraftWorkspaceSettings {
  id: string
  projectSlug: string
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
  projectSlug: string
  tool: AgentTool
  title?: string
  prompt?: string
  groupId?: string
  /** 'YYYY-MM-DD HH:MM:SS' (UTC). */
  stoppedAt: string
  deathReason?: WorkspaceDeathReason
  deathDetail?: string
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
  projectSlugs: string[]
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
 * Who a request came from (`GET /whoami`, docs/remote-hosting.md). `local`
 * reached the server directly (loopback, or a nested server's direct path).
 * `tailnet` came through `tailscale serve`, which stamped the tailnet user's
 * login and display name on it.
 */
export type Principal =
  | { kind: 'local' }
  | { kind: 'tailnet'; login: string; name: string }

/**
 * All server-owned state the webapp renders, sent as a `snapshot` event on
 * connect and replaced whole on each later one.
 */
export interface ServerSnapshot {
  /** Which substrate this server runs — see `DriverKind`. */
  driver: DriverKind
  workspaces: WorkspaceListEntry[]
  /** Every project's sidebar groups, hidden ones included (the client
   *  decides visibility from the members). */
  workspaceGroups: WorkspaceGroupSummary[]
  stale: StaleWorkspaceInfo[]
  projects: ProjectSummary[]
  provisioning: ProvisioningWorkspaceEntry[]
  /** Every project's queued workspaces not currently launching, oldest
   *  first. A launching one appears as a provisioning row. */
  queuedWorkspaces: QueuedWorkspaceEntry[]
  /** Stopped workspaces that queued workspaces still wait on. */
  heldWorkspaces: HeldWorkspaceEntry[]
  /** Every project's draft workspaces, oldest first. */
  draftWorkspaces: DraftWorkspaceEntry[]
  /** See `ActiveWorkspacesResult.gitAuthFailures`. */
  gitAuthFailures: Record<string, GitAuthFailure[]>
  imageBuilds: ImageBuildEntry[]
  /** Claude subscription plan usage (domain/auth/plan-usage.ts). Null
   *  until the first refresh after a webapp client connects. */
  planUsage: PlanUsageResult | null
  /** Codex (ChatGPT) plan usage. Null until the first refresh, or without
   *  a ChatGPT (OAuth) sign-in. */
  codexPlanUsage: PlanUsageResult | null
  /** The host port-forward listeners bind (`YAAC_FORWARD_BIND`), so the UI
   *  can state it; it may differ from the page origin. */
  forwardBindHost: string
}

/** Messages the server pushes over `/events`. */
export type ServerEvent =
  | { type: 'snapshot'; data: ServerSnapshot }

/**
 * Desktop-shell server picker, over the preload bridge (`window.yaacServer`).
 */
export interface DesktopServerSelection {
  url: string
}

export interface DesktopServerTargets {
  /** The selected origin, or null when this machine has none. */
  current: string | null
  /** Origins of every server ever configured (`server.json`'s `saved`). */
  saved: string[]
}

/** Success means the shell is about to reland the window on that server. */
export type DesktopServerOutcome =
  | { ok: true }
  | { ok: false; error: string }


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
 * group and conversation are kept, so the user can restart it. Anything that
 * deletes, restarts or reconfigures stays the user's. `fetch` reads another
 * workspace's branches into the caller's checkout, never writing to theirs.
 */
export const MAMA_COMMANDS = [
  'list',
  'create',
  'rename',
  'stop',
  'group-create',
  'group-move',
  'models',
  'queue',
  'edit-queued',
  'fetch',
] as const
export type MamaCommand = (typeof MAMA_COMMANDS)[number]
