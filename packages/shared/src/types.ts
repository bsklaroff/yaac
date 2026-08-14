import { z } from 'zod'
import type { OpencodeProvider, PiProvider } from '#tool-providers'

export type AgentTool = 'claude' | 'codex' | 'opencode' | 'pi'

export const AGENT_TOOLS: readonly AgentTool[] = ['claude', 'codex', 'opencode', 'pi']

/**
 * Coerce a raw tool name into an `AgentTool`, defaulting to claude.
 *
 * Where raw strings enter: a driver reading back what it stamped on a
 * workspace, and config or wire input naming a tool this build may not
 * know. Defaulting rather than rejecting is the point — a workspace
 * stamped with something unrecognized still has to render and be exec'd
 * into, so `tool` always resolves to something runnable. (What a workspace
 * DECLARES is a separate question, and `RuntimeHandle.declaredTool` is
 * where a caller asks it.)
 */
export function normalizeTool(raw: string | undefined): AgentTool {
  return AGENT_TOOLS.includes(raw as AgentTool) ? raw as AgentTool : 'claude'
}

/**
 * Allowed shape for a `--model` override. Deliberately strict: the value is
 * embedded bare in agent launch commands that travel inside single-quoted
 * `respawn-window '<cmd>'` wrappers (see buildAgentCmd), so no quotes,
 * whitespace, or shell metacharacters — model ids, aliases, and
 * `provider/model` paths (`claude-opus-4-8`, `opus`,
 * `anthropic/claude-opus-4-8`) never need them.
 *
 * Here rather than beside the command builder because it is request
 * vocabulary: the route that accepts a model and the launch path that runs with
 * it both need it, and neither may import the other.
 */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/

/**
 * How yaac drives a conversation, and therefore how the webapp renders it.
 * Orthogonal to `AgentTool`: it selects the *protocol* between the server and
 * the agent, not which agent runs.
 *
 * - `tui`  the agent's own terminal UI under tmux; the server observes it
 *          through tmux control mode and the browser attaches a PTY.
 * - `acp`  the agent speaks the Agent Client Protocol (JSON-RPC over stdio)
 *          to the server, which renders structured messages in a chat pane.
 *
 * Both modes run the agent in a tmux window — tmux is the process supervisor
 * that outlives the viewer either way. Only the presentation transport
 * differs (a PTY stream vs a ctrl stream into acpd's socket).
 */
export type AgentMode = 'tui' | 'acp'

export const AGENT_MODES: readonly AgentMode[] = ['tui', 'acp']

/** Tools with an ACP adapter in the worktree image. */
export const ACP_TOOLS: readonly AgentTool[] = ['claude']

/**
 * How much the agent may do before it stops to ask. Orthogonal to both
 * `AgentTool` and `AgentMode`: it selects the agent's *permission posture*,
 * which every tool spells differently (a launch flag for claude and codex, a
 * config block for opencode, nothing at all for pi).
 *
 * - `bypass`        no prompts; the agent acts freely. What a sandboxed
 *                   worktree wants — the sandbox is the containment, so a
 *                   second layer inside it only costs interruptions.
 * - `auto`          no routine prompts, but a reviewer model adjudicates each
 *                   action and blocks the dangerous ones. Availability is not
 *                   ours to check: claude gates it by subscription plan and
 *                   fails loudly in-pane when the account is ineligible.
 * - `accept-edits`  file edits in the worktree run unprompted; anything else
 *                   (other shells, out-of-tree paths, network) still asks.
 * - `plan`          read and explore only; no edits until a plan is approved.
 * - `manual`        every tool use asks first.
 *
 * Not every tool has every posture — ask `SUPPORTED_PERMISSION_MODES`, never
 * assume. There is deliberately no "the tool's own default" member: what a
 * bare `claude` does differs from a bare `codex` or `opencode`, so a worktree
 * records the posture it actually launched with.
 */
export type PermissionMode = 'bypass' | 'auto' | 'accept-edits' | 'plan' | 'manual'

export const PERMISSION_MODES: readonly PermissionMode[] = [
  'bypass',
  'auto',
  'accept-edits',
  'plan',
  'manual',
]

/**
 * Which postures each tool can actually be launched in.
 *
 * - claude and codex carry all five (claude `--permission-mode`, codex's
 *   approval-policy × sandbox pair plus `--approve-for-me`).
 * - opencode has no reviewer-model posture, so no `auto`.
 * - pi has no permission system at all — by design, per its own docs: tools
 *   execute immediately and nothing prompts. Rather than dress that up as a
 *   posture it does not have, pi is `bypass`-only and callers are refused
 *   anything else.
 */
export const SUPPORTED_PERMISSION_MODES: Record<AgentTool, readonly PermissionMode[]> = {
  claude: PERMISSION_MODES,
  codex: PERMISSION_MODES,
  opencode: ['bypass', 'accept-edits', 'plan', 'manual'],
  pi: ['bypass'],
}

export function toolSupportsPermissionMode(tool: AgentTool, mode: PermissionMode): boolean {
  return SUPPORTED_PERMISSION_MODES[tool].includes(mode)
}

/** Dropdown labels — the enum's user-facing vocabulary, in one place. */
export const PERMISSION_MODE_COPY: Record<PermissionMode, string> = {
  bypass: 'Bypass permissions',
  auto: 'Auto permissions',
  'accept-edits': 'Accept edits',
  plan: 'Plan mode',
  manual: 'Manual permissions',
}

/**
 * The posture a worktree gets when nobody has chosen one — neither the request
 * nor the project's remembered last choice.
 *
 * A sandboxed substrate answers `bypass` for every tool: the container is the
 * containment, and prompting inside it protects nothing. Containerless
 * worktrees act as the user on the user's own machine, so they start at
 * `accept-edits` — edits land in the worktree without nagging, while shells and
 * out-of-tree writes still ask. pi is the exception in both directions: having
 * no permission system, `bypass` is the only truthful answer anywhere.
 */
export function defaultPermissionMode(driver: DriverKind, tool: AgentTool): PermissionMode {
  if (!toolSupportsPermissionMode(tool, 'accept-edits')) return 'bypass'
  return driver === 'containerless' ? 'accept-edits' : 'bypass'
}

export type ToolAuthKind = 'api-key' | 'oauth'

/**
 * Credential kinds `yaac auth fake` can seed. Each seeds a proxy-placeholder
 * credential (never a real secret) so a worktree authenticates through a parent
 * yaac's MITM proxy — the yaac-in-yaac case (see lib/project/fake-auth.ts).
 * Single source of truth shared by the CLI's `Argument.choices()` and the
 * server route's zod validator, which must stay in lockstep.
 */
export const FAKE_AUTH_KINDS = [
  'claude-oauth',
  'opencode-openrouter',
  'pi-openrouter',
  'github',
] as const
export type FakeAuthKind = (typeof FAKE_AUTH_KINDS)[number]

/**
 * Claude Code's native OAuth bundle. Stored under the "claudeAiOauth" key in
 * both Claude's `.credentials.json` and yaac's host-side mirror.
 *
 * Source of truth for both the TS type and the runtime validator. Fields
 * accept empty `refreshToken`/`expiresAt` because `saveToolAuth` may be
 * called with a bare OAuth access token — the proxy refreshes on first use.
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
 * Shape of `~/.yaac/.credentials/claude/claude.json`. Either OAuth (with a
 * full bundle) or API-key (a single sk-ant-api03-… key).
 */
export type ClaudeCredentialsFile =
  | {
    kind: 'oauth'
    savedAt: string
    claudeAiOauth: ClaudeOAuthBundle
  }
  | {
    kind: 'api-key'
    savedAt: string
    apiKey: string
  }

/**
 * Codex's "Sign in with ChatGPT" OAuth bundle. Stored under the "codexOauth"
 * key in yaac's host-side `codex.json`. Mirrors the bits of Codex's native
 * `~/.codex/auth.json` that the proxy needs to swap placeholders and refresh.
 */
export const codexOAuthBundleSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** Full signed JWT — identity assertion, not a bearer credential. Flows
   *  through the proxy into the container's auth.json unmodified. */
  idTokenRawJwt: z.string().min(1),
  /** Unix epoch ms, derived from access_token JWT `exp` (best-effort; falls
   *  back to now + 28d to mirror Codex's proactive-refresh window). */
  expiresAt: z.number(),
  /** ISO timestamp matching Codex's `last_refresh`. */
  lastRefresh: z.string(),
  /** Top-level `tokens.account_id` from Codex's auth.json — distinct from
   *  id_token's `chatgpt_account_id` claim. Codex uses this to populate the
   *  `ChatGPT-Account-Id` request header on api.openai.com, so it must flow
   *  through to the container unchanged. */
  accountId: z.string().optional(),
})
export type CodexOAuthBundle = z.infer<typeof codexOAuthBundleSchema>

/**
 * Shape of `~/.yaac/.credentials/codex.json`. Either OAuth (with a full
 * bundle) or API-key.
 */
export type CodexCredentialsFile =
  | {
    kind: 'oauth'
    savedAt: string
    codexOauth: CodexOAuthBundle
  }
  | {
    kind: 'api-key'
    savedAt: string
    apiKey: string
  }

/**
 * Shape of `~/.yaac/.credentials/opencode.json`. Only api-key — opencode
 * integration in yaac authenticates via an api-key for one of the providers in
 * the generated registry (`tool-providers.ts`). `provider` picks which env var
 * carries the key and which host the proxy swaps the placeholder on, so it
 * is required: a file whose provider is missing or absent from the registry
 * loads as null rather than being coerced to a default.
 */
export type OpencodeCredentialsFile = {
  kind: 'api-key'
  provider: OpencodeProvider
  savedAt: string
  apiKey: string
}

/**
 * Shape of `~/.yaac/.credentials/pi.json`. Only api-key — pi integration in
 * yaac authenticates via an api-key for one of the providers in the generated
 * registry (`tool-providers.ts`). `provider` picks which env var carries the
 * key and which host the proxy swaps the placeholder on.
 */
export type PiCredentialsFile = {
  kind: 'api-key'
  provider: PiProvider
  savedAt: string
  apiKey: string
}

/**
 * Summary view over per-tool credential files. Consumers (`auth list`,
 * worktree-create's per-tool placeholder wiring) read only kind / apiKey /
 * savedAt / opencodeProvider — full OAuth bundles stay in the per-tool
 * credentials files.
 */
interface ToolAuthEntryBase {
  kind: ToolAuthKind
  /** Access token (OAuth) or raw API key. */
  apiKey: string
  savedAt: string
}

/**
 * A stored credential, discriminated on `tool` so the provider is required
 * exactly where it applies. The loaders already refuse to return an
 * opencode/pi credential without a usable provider — expressing that here
 * makes it the compiler's invariant instead of each consumer's: a `??
 * DEFAULT` at the point that picks the pod's env var would silently scope the
 * key to a vendor the user never chose, and now cannot be written at all.
 */
export type ToolAuthEntry =
  // claude and codex are listed separately, not as `'claude' | 'codex'`, so
  // that `Extract<ToolAuthEntry, { tool: 'claude' }>` resolves to a member
  // rather than never — that is what lets loadToolAuthEntry narrow on a
  // literal tool argument.
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

export interface BindMountConfig {
  /** Absolute path on the host to mount */
  hostPath: string
  /** Absolute path inside the container */
  containerPath: string
  /** Mount mode: "ro" for read-only, "rw" for read-write */
  mode: 'ro' | 'rw'
}

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
 * Object form of an `initCommands` entry. Each spec becomes its own tmux
 * window so multiple long-running processes (e.g. a backend and a frontend
 * dev server) can run in parallel and be inspected independently.
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

export interface YaacConfig {
  envPassthrough?: string[]
  env?: Record<string, string>
  envSecretProxy?: Record<string, SecretProxyRule>
  cacheVolumes?: Record<string, string>
  /**
   * Run an in-pod rootful podman so `docker build` / `docker run` /
   * `docker compose` work inside worktrees. Adds the nestable image layer and
   * the nested pod-spec branch (gvisor-nested runtime, in-sandbox engine
   * caps, tmpfs graphroot, shared image store).
   */
  nestedContainers?: boolean
  /** Either a flat string list (collapsed into a single `init` window) or
   *  a list of `InitCommandSpec` objects (one tmux window per entry).
   *  Mixing the two forms is rejected by the config parser. */
  initCommands?: string[] | InitCommandSpec[]
  portForward?: PortForwardConfig[]
  bindMounts?: BindMountConfig[]
  hideInitPane?: boolean
  addAllowedUrls?: string[]
  setAllowedUrls?: string[]
  /**
   * Paths (relative to /workspace) whose directory should be redirected
   * to `.cached-packages/modules/<worktreeId>/<slotKey>` via a symlink,
   * so package-manager writes don't land on the host worktree. Sharing
   * a filesystem with pnpm-store keeps hardlinks across worktrees.
   * Unset → `["node_modules"]`. Empty array disables the feature.
   */
  ephemeralModulesPaths?: string[]
  /**
   * Default reference branch for new worktrees: the branch on `origin`
   * (written without the `origin/` prefix, e.g. "develop") that fresh
   * worktree worktrees are created from and set upstream to. A per-create
   * `branch` option overrides it. Unset → the remote's default branch.
   */
  referenceBranch?: string
}

export interface HttpsGitCredentialEntry {
  kind: 'https'
  /** Pattern: "<host>/*", "<host>/<path>", or "<host>/<prefix>/*" */
  pattern: string
  /** PAT used as the password in basic auth with username 'x-access-token'. */
  token: string
}

export interface SshGitCredentialEntry {
  kind: 'ssh'
  pattern: string
  /** Host path to the private key; may start with '~'. yaac never copies it. */
  privateKeyPath: string
  /** One OpenSSH known_hosts line: '<host>[:port] <keytype> <base64>'. */
  knownHostsEntry: string
}

export type GitCredentialEntry = HttpsGitCredentialEntry | SshGitCredentialEntry

/**
 * Shape of `~/.yaac/.credentials/github.json` (path retained for back-compat).
 * Legacy entries (no `kind`, bare-pattern) are normalized on load.
 */
export interface GitCredentialsFile {
  tokens: GitCredentialEntry[]
}

// ---------------------------------------------------------------------------
// Wire types — RPC request/response shapes used across the server/CLI
// boundary. Lib and server modules return these; commands receive them via
// the Hono RPC client.
// ---------------------------------------------------------------------------

/** Host↔container port mapping returned by `/worktree/create`. */
export interface PortMapping {
  containerPort: number
  hostPort: number
}

// --- auth/list ---

export interface GitCredentialSummary {
  kind: 'https' | 'ssh'
  pattern: string
  /** Masked token suffix for https; un-expanded key path for ssh. */
  preview: string
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
}

export interface AuthListResult {
  gitCredentials: GitCredentialSummary[]
  toolAuth: ToolAuthSummary[]
}

// --- subscription plan usage (server/plan-usage.ts, snapshot field) ---

/**
 * One limit row from a tool's subscription usage endpoint, normalized for
 * the wire. Covers both Claude (Anthropic's api/oauth/usage `limits[]`) and
 * Codex (ChatGPT's wham/usage primary/secondary windows).
 */
export interface PlanUsageLimit {
  /** Limit kind, verbatim from the provider. Claude: 'session' (its
   *  five-hour usage window, not a yaac worktree), 'weekly_all',
   *  'weekly_scoped'. Codex:
   *  'codex_primary' (the shorter window) and 'codex_secondary' (weekly). */
  kind: string
  /** Utilization of this limit, 0–100. */
  percent: number
  /** Upstream severity — 'normal' until the limit nears exhaustion. Codex
   *  has no severity field, so its rows are always 'normal' (percent drives
   *  the tone). */
  severity: string
  /** ISO timestamp when this limit's window resets, when reported. */
  resetsAt: string | null
  /** Model display name for per-model limits (e.g. 'Fable'), else null. */
  modelName: string | null
  /** Window length in minutes when the upstream reports it (Codex windows,
   *  so a 5h vs weekly label is derived rather than assumed); null for
   *  Claude limits, which encode the window in `kind`. */
  windowMinutes?: number | null
}

/**
 * Plan-usage query result for one tool. Only OAuth (subscription)
 * credentials are queryable; api-key auth and every failure path degrade to
 * `available: false` so the UI can simply hide the readout.
 */
export type PlanUsageResult =
  | {
    available: false
    reason: 'no-credentials' | 'api-key' | 'unauthorized' | 'error'
    message?: string
  }
  | {
    available: true
    /** Plan tier — Claude's OAuth bundle subscriptionType (e.g. 'max') or
     *  Codex's plan_type (e.g. 'plus', 'pro', 'team'), if known. */
    subscriptionType: string | null
    /** The org's rate-limit tier from Claude's OAuth profile endpoint (e.g.
     *  'default_claude_max_20x') — distinguishes Max 20x from Max 10x.
     *  Null until the server's per-credential profile fetch lands, and
     *  always null for Codex (no analogous multiplier). */
    rateLimitTier: string | null
    limits: PlanUsageLimit[]
  }

// --- web-driven tool sign-in (server/tool-login.ts) ---

export type ToolLoginStatus = 'running' | 'success' | 'error'

/** Wire view of a server-run vendor-CLI browser login (never carries tokens).
 *  The CLI opens the browser itself — same-machine setups need no relaying. */
export interface ToolLoginView {
  id: string
  tool: AgentTool
  status: ToolLoginStatus
  /** The CLI's output so far (ANSI-stripped, tail-capped) — shown so the user
   *  can grab the printed sign-in URL when no browser window opened. */
  output?: string
  error?: string
  /** Set when the flow failed because the vendor CLI is not installed on
   *  this machine — the webapp offers an install instead of a retry. */
  cliMissing?: boolean
}

/** Wire view of a server-run vendor-CLI install kicked off from the webapp
 *  (the "Install Claude Code / Codex" button on a cliMissing sign-in). */
export interface ToolInstallView {
  id: string
  tool: AgentTool
  status: ToolLoginStatus
  /** Installer output so far (ANSI-stripped, tail-capped). */
  output?: string
  error?: string
}

// --- worktree/list ---

/**
 * A git credential the proxy injected that the upstream rejected — the
 * stored token is bad (expired or revoked), as opposed to a blocked host.
 * Recorded per project by the proxy (the credential belongs to the
 * project's repo, so one bad token affects every worktree of the project);
 * cleared automatically when a later git request to the same host from any
 * of the project's worktrees succeeds.
 */
export interface GitAuthFailure {
  host: string
  /** HTTP status the upstream returned (401 or 403). */
  status: number
  /** Epoch ms when the proxy first saw the failure. */
  atMs: number
}

/**
 * One agent conversation inside a worktree — a claude/codex/pi/opencode
 * worktree. Several can be live at once (a second terminal, or a `/clear`
 * that left the old conversation's window open), and the ones that are not
 * live are the worktree's history.
 */
export interface AgentSessionEntry {
  /** The tool's own conversation id, not yaac's. */
  agentSessionId: string
  tool: AgentTool
  /** Which protocol drives it, and therefore which pane renders it. Absent
   *  on rows recorded before modes existed, which are `tui`. */
  mode?: AgentMode
  /** Restore order; 0 is the worktree's original agent. */
  ordinal: number
  /** Had a live agent process when the worktree was last observed running —
   *  and therefore what a restart brings back. */
  active: boolean
  /** Live only: this conversation's own busy/idle, from its pane. */
  status?: 'running' | 'waiting'
  /** Live only: epoch ms when this conversation's waiting spell began. */
  waitingSinceMs?: number
  /** This conversation's own first user message (the worktree keeps the
   *  founding one separately — they differ after a `/clear`). */
  prompt?: string
  /** 'YYYY-MM-DD HH:MM:SS' (UTC) of its transcript's last write. */
  lastActiveAt?: string
}

export interface WorktreeListEntry {
  worktreeId: string
  projectSlug: string
  tool: AgentTool
  /**
   * The worktree's aggregate: `waiting` if ANY of its agent sessions is
   * waiting, else `running`. Waiting is the actionable state — an agent that
   * needs you needs you whether or not a sibling is still working.
   */
  status: 'running' | 'waiting'
  /** The worktree's container is being torn down (its pod has a deletion
   *  timestamp, or a stop was just issued). Orthogonal to `status`: the
   *  row is on its way out and should render as a non-interactive
   *  "stopping…" placeholder rather than a live worktree. */
  stopping?: boolean
  /** Pod created time as 'YYYY-MM-DD HH:MM:SS' (UTC). */
  createdAt: string
  /** Epoch ms when the current waiting spell began, stamped by the
   *  server's push-fed status store at the transition itself. Only set
   *  while status is 'waiting'; the *earliest* waiting agent wins, so a
   *  second agent going idle joins the spell in progress rather than
   *  restarting it. In-memory on the server: a restart (or a still-booting
   *  worktree with no watcher yet) has no stamp, which clients treat as
   *  its own spell. */
  waitingSinceMs?: number
  /** The founding ask — the first user message of the worktree's first
   *  agent session. Survives a `/clear` that discards that conversation. */
  prompt?: string
  /** User-assigned display title (falls back to `prompt` in UIs). */
  title?: string
  /** Every conversation the worktree has hosted, in restore order. */
  agentSessions: AgentSessionEntry[]
  blockedHosts: string[]
  /** Live host→container forwards owned by the server (from the
   *  forwarder registry). Empty until forwarders are (re)provisioned —
   *  briefly so after a server restart, before the restore pass runs. */
  forwardedPorts: PortMapping[]
  /** Container ports with a live in-pod listener that is not forwarded —
   *  detected via streamd's `ports` push, minus forwarded, dismissed,
   *  sensitive, and infra ports. Drives the "forward this port?" badge;
   *  self-clears when a port is forwarded or its listener stops. */
  unforwardedPorts: number[]
  /** The remote branch this worktree tracks (its reference branch), read
   *  from the worktree branch's recorded upstream. Unset when the upstream
   *  record is missing or unreadable. */
  baseBranch?: string
  /** The sidebar group this worktree is filed under (see
   *  `WorktreeGroupSummary`); absent means the default list. Server-persisted
   *  and orthogonal to `status` and `stopping` — a worktree keeps its group
   *  through stopping and restarting (and, via `StoppedWorktreeEntry.groupId`,
   *  keeps a ghost row in it while stopped). */
  groupId?: string
}

/**
 * A named sidebar group — how the user has chosen to file a project's
 * worktrees. The sidebar lists ungrouped worktrees first and then one
 * collapsible section per group, both in `createdAt` order; membership is
 * `WorktreeListEntry.groupId`.
 *
 * A group is shown when it is `pinned` or holds at least one live worktree,
 * and every shown group lists ALL its members — live ones as ordinary rows,
 * stopped ones as ghost rows with a restart action. So an unpinned group
 * whose worktrees have all stopped just disappears (its row persists, and
 * restarting a member brings it back), while pinning keeps it on screen as a
 * place to restart into.
 */
export interface WorktreeGroupSummary {
  groupId: string
  projectSlug: string
  name: string
  /** Keep the group listed even with no live worktree in it. */
  pinned: boolean
  /** 'YYYY-MM-DD HH:MM:SS' (UTC) — the groups' display order. */
  createdAt: string
}

/** How a file changed, mapped from git's name-status letters. */
export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange'

/** One changed file in a worktree's worktree, relative to the fork base. */
export interface WorktreeChange {
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
 * The review diff for a worktree — everything the agent changed since the
 * worktree forked from its base branch (committed + staged + unstaged +
 * untracked), computed against an index of our own so it never disturbs the
 * agent's own git state.
 */
export interface WorktreeChanges {
  /** The base commit the diff is taken against (merge-base with the fork
   *  point), or HEAD when no upstream is resolvable. */
  base: string
  /** False when no fork point was resolvable and `base` fell back to HEAD. The
   *  diff then covers only UNCOMMITTED work, so an empty `files` means "nothing
   *  uncommitted", not "nothing changed" — say so rather than showing the
   *  ordinary no-changes state. */
  baseResolved: boolean
  files: WorktreeChange[]
  /** The combined unified diff; the client splits it into per-file hunks.
   *  Capped for size — see `truncated`. */
  diff: string
  /** True when the diff body was capped for size; `files` stays complete. */
  truncated: boolean
}

/**
 * Why a worktree died, derived at reap time from the pod's terminal state
 * and the reaper's own classification — the last chance to capture it,
 * since the reaper's teardown deletes the Job (and with it the pod's
 * `containerStatuses` and the Job's failure condition). Absent on a plain
 * user delete.
 */
export type WorktreeDeathReason =
  | 'oom'            // session container OOMKilled by the kernel
  | 'evicted'        // pod evicted by the kubelet (node pressure)
  | 'crashed'        // session container exited non-zero
  | 'pod-stopped'    // pod left Running with no conclusive terminal state
  | 'agent-exited'   // pod alive but the in-pod tmux server was gone
  | 'never-started'  // session create was interrupted before the agent ran
  | 'orphaned'       // Job/pod deleted out-of-band

export interface WorktreeDeathCause {
  reason: WorktreeDeathReason
  /** Free-form evidence: exit code, eviction message, … */
  detail?: string
}

/**
 * Which on-disk tier a skill was discovered from. Personal/plugin/project are
 * all loose `SKILL.md` files. `system` is a built-in tier: an agent's own
 * bundled skills (Codex's `.system/` under the host-mounted `~/.codex/skills/`,
 * or Claude's binary-bundled skills read list-only from its docs, `sourceLabel`
 * `bundled`), plus the skills yaac itself ships and injects into every worktree
 * (`sourceLabel` `yaac`; see the server's features/skills).
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

export interface StaleWorktreeInfo {
  jobName: string
  projectSlug: string
  worktreeId: string
  /** True when the pod is still running but tmux is gone. */
  zombie: boolean
  /** Terminal-state evidence for the reap, when the pod carried any. */
  deathCause?: WorktreeDeathCause
}

export interface ActiveWorktreesResult {
  worktrees: WorktreeListEntry[]
  stale: StaleWorktreeInfo[]
  /** Project slug -> git credentials the upstream rejected. Project-wide,
   *  not per-worktree: one bad token affects every worktree of the project.
   *  Only projects with at least one failing host appear. */
  gitAuthFailures: Record<string, GitAuthFailure[]>
}

export interface StoppedWorktreeEntry {
  worktreeId: string
  projectSlug: string
  tool: AgentTool
  /** 'YYYY-MM-DD HH:MM:SS' (UTC). Worktree birth time. */
  createdAt: string
  /** Last-activity time as 'YYYY-MM-DD HH:MM:SS' (UTC) — the newest
   *  transcript mtime across every conversation the worktree hosted, so a
   *  worktree the user `/clear`ed an hour ago reads as an hour old rather
   *  than as old as its opening question. Falls back to creation time when
   *  nothing is readable (opencode leaves no host transcript). */
  lastActiveAt?: string
  /** When the worktree was stopped, as 'YYYY-MM-DD HH:MM:SS' (UTC). Recorded
   *  at stop time; the primary sort key (newest-stopped first). Absent for
   *  worktrees removed out-of-band, which fall back to `lastActiveAt`. */
  stoppedAt?: string
  /** The founding ask — the first conversation's first user message. */
  prompt?: string
  /** User-assigned display title (survives stopping; ids are stable). */
  title?: string
  /** Every conversation the worktree hosted, in restore order. The ones
   *  marked `active` are what a restart brings back. */
  agentSessions: AgentSessionEntry[]
  /** Why the worktree died, when the reaper (not the user) stopped it. */
  deathReason?: WorktreeDeathReason
  /** Evidence accompanying `deathReason` (exit code, eviction message, …). */
  deathDetail?: string
  /** Whether the user has viewed this death's detail — clears the "Stopped
   *  worktrees" notification dot / row highlight. Server-persisted (on the
   *  worktree row) so the acknowledgement is durable and shared across
   *  clients; only meaningful when `deathReason` is set. */
  seen: boolean
  /** The sidebar group the worktree is filed under — membership survives
   *  stopping (worktree ids are stable across restarts), so a stopped member
   *  keeps a ghost row in its group with a restart action. */
  groupId?: string
}

/** A webapp-attachable terminal inside a worktree's container (beyond the
 *  primary agent view): a `yaac`-worktree tmux window — an initCommands
 *  window (dev server, watcher, …) or a scratch shell. */
export interface WorktreeTerminalEntry {
  /** /pty/attach target: 'window:@<id>'. */
  target: string
  /** Display name (the tmux window name). */
  name: string
}

// ---------------------------------------------------------------------------
// Webapp event stream — pushed over the `/events` WebSocket. The slice
// pushes a full snapshot on connect and after each background-loop tick
// when the state changed; granular per-entity events come later.
// ---------------------------------------------------------------------------

/**
 * Project row in the snapshot. Structurally matches `ProjectListEntry`
 * from `features/projects/list`; inlined here so this module stays
 * browser-safe (the frontend imports it without pulling node-only lib
 * files into its type graph).
 */
export interface ProjectSummary {
  slug: string
  remoteUrl: string
  addedAt: string
  worktreeCount: number
  /** The posture this project's last explicit create asked for, if any. What
   *  the create form shows as its default, so the value on screen is the one
   *  the server would pick if the form were submitted untouched. Absent until
   *  someone has picked one; `defaultPermissionMode` answers in the meantime. */
  lastPermissionMode?: PermissionMode
}

/**
 * A worktree that is currently provisioning — a create or restart in flight,
 * tracked in server memory and surfaced in the snapshot so the webapp renders
 * it as a first-class, selectable sidebar row that survives a reload (with live
 * progress) until the real worktree lands or a failure is dismissed.
 */
export interface ProvisioningWorktreeEntry {
  worktreeId: string
  projectSlug: string
  tool: AgentTool
  kind: 'create' | 'restart'
  /** Latest progress line (e.g. 'Pulling image…'). */
  message: string
  /** Set when provisioning failed; the row stays until dismissed. */
  error?: string
  /** The sidebar group this worktree is filed under — asked for by a create
   *  (`--group`), or already recorded for a restart — so the row renders in
   *  that section while it provisions rather than jumping to the top of the
   *  list and back. Absent means the default list. */
  groupId?: string
  /** 'YYYY-MM-DD HH:MM:SS' UTC, derived from when provisioning started — so
   *  the sidebar can show a relative age for a row that has no pod yet. */
  createdAt: string
}

/** Named step in a project's image chain, in build order. */
export type ImageLayerName = 'base' | 'tools' | 'nestable' | 'project' | 'user'

/**
 * An image build or registry push tracked in server memory and surfaced in
 * the snapshot (metadata only — the raw podman log tail is fetched via
 * `GET /image/builds/:id/log`, not streamed through snapshots).
 */
export interface ImageBuildEntry {
  id: string
  tag: string
  /** Which chain step this is; `'push'` for a registry push, and `'proxy'`
   *  / `'netd'` for the shared egress-proxy sidecar and per-node network
   *  daemon images (neither part of a project chain). */
  layer: ImageLayerName | 'push' | 'proxy' | 'netd'
  action: 'build' | 'push'
  /** Every project that requested this tag (joiners attach their slug).
   *  Empty for shared infrastructure builds with no owning project (the
   *  proxy sidecar) — the webapp always shows those regardless of the
   *  active project. */
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
 * Full picture of server-owned state the webapp renders. Hydrated from a
 * `snapshot` event on connect and replaced wholesale on every subsequent
 * `snapshot`. Mirrors the union of `GET /worktree/list` and
 * `GET /project/list`.
 */
/**
 * Which substrate a server runs worktrees on.
 *
 * `k8s` runs each worktree as a single-pod Job in a local cluster, built
 * from an image and reached through an egress proxy. `containerless` runs
 * it as a tmux server on the host, in the worktree checkout itself — no
 * image, no proxy, and no sandbox around the agent.
 *
 * On the wire because the webapp has to render two different products: a
 * containerless server has no Dockerfile to edit, no builds to show and no
 * blocked hosts to allow, and its worktrees start at a stricter permission
 * mode than the one a sandbox justifies. The server-side definition of
 * what a kind may be branched on is `DriverKind` in the driver contract,
 * which imports this one.
 */
export type DriverKind = 'k8s' | 'containerless'

export interface ServerSnapshot {
  /** Which substrate this server runs — see `DriverKind`. */
  driver: DriverKind
  worktrees: WorktreeListEntry[]
  /** Every project's sidebar groups (clients filter by slug, as they do
   *  `worktrees`). Carries hidden groups too — whether a group shows is a
   *  question about its members, which the client already has. */
  worktreeGroups: WorktreeGroupSummary[]
  stale: StaleWorktreeInfo[]
  projects: ProjectSummary[]
  provisioning: ProvisioningWorktreeEntry[]
  /** Project slug -> git credentials the upstream rejected (project-wide;
   *  see ActiveWorktreesResult.gitAuthFailures). */
  gitAuthFailures: Record<string, GitAuthFailure[]>
  imageBuilds: ImageBuildEntry[]
  /** Claude subscription plan usage, refreshed server-side
   *  (server/plan-usage.ts). Null until the first refresh after a webapp
   *  client connects lands. */
  planUsage: PlanUsageResult | null
  /** Codex (ChatGPT) subscription plan usage, refreshed server-side by the
   *  same engine. Null until the first refresh lands, or when Codex isn't
   *  signed in with a ChatGPT (OAuth) account. */
  codexPlanUsage: PlanUsageResult | null
  /** The host worktree port-forward listeners actually bind
   *  (`YAAC_FORWARD_BIND`; loopback locally, the tailnet IP on a remote
   *  host). Server-reported so UI exposure claims state the real bind —
   *  the page origin can differ from it (e.g. an SSH tunnel). */
  forwardBindHost: string
}

/** Messages the server pushes over `/events`. */
export type ServerEvent =
  | { type: 'snapshot'; data: ServerSnapshot }

/**
 * Desktop-shell server picker, over the preload bridge (`window.yaacServer`).
 * The renderer only ever sees origins — remote tokens stay in the main
 * process (remote.json).
 */
export type DesktopServerSelection =
  | { kind: 'local' }
  | { kind: 'remote'; url: string }

export interface DesktopServerTargets {
  current: DesktopServerSelection
  /** Origins of every remote ever configured (remote.json `saved`). */
  saved: string[]
}

/** `changed: true` means the shell is about to reland the window on the new server. */
export type DesktopServerOutcome =
  | { ok: true; changed: boolean }
  | { ok: false; error: string }

/**
 * Cap on a recorded opening message, applied by whoever stores it. Generous
 * next to a title — the sidebar truncates for display, but the prompt also
 * feeds title generation, which reads the opening ~1000 chars. Shared
 * vocabulary rather than a db-private constant because it bounds what
 * the store and the discovery sweeps cache as well as what the row keeps,
 * so the copies cannot disagree.
 */
export const MAX_PROMPT_LENGTH = 4000

/**
 * What a worktree's agent may ask its own yaac server to do, via the
 * in-worktree `yaac-mama` command.
 *
 * This union IS the allowlist — the strict subset of the yaac CLI reachable
 * from inside a worktree. It is enforced where the request is answered
 * (`runMamaCommand`), so neither transport can widen it: the k8s proxy
 * queues opaque envelopes without knowing what any command means, and the
 * containerless route validates against this same list.
 *
 * Deliberately absent: anything that stops, deletes or reconfigures. An
 * agent may make work and file it; unmaking it stays the user's.
 */
export const MAMA_COMMANDS = [
  'list',
  'create',
  'rename',
  'group-create',
  'group-move',
  'models',
] as const
export type MamaCommand = (typeof MAMA_COMMANDS)[number]

/**
 * One queued in-worktree `yaac-mama` request, as drained from a runtime that
 * holds them. Wire shape mirrors k8s/proxy/mama-queue.ts (MamaRequest sans
 * enqueuedAtMs) — the proxy bundles independently; keep them in sync.
 *
 * Shared vocabulary because it crosses a wire the proxy sidecar and the
 * server each hold one end of, exactly like the other types in this file:
 * the runtime that drains the queue and the mediator that answers each
 * request both name it, and neither owns it.
 *
 * The envelope is deliberately untyped beyond this: `command` is a bare
 * string because it comes off a wire, and `args` is a flat option map. What
 * any of it MEANS is the server's, which is what keeps the queue a queue.
 */
export interface PendingMamaRequest {
  requestId: string
  /** The CALLING worktree (attributed by the runtime, never by the caller). */
  worktreeId: string
  /** A `MamaCommand`, unvalidated — an unknown one is refused server-side. */
  command: string
  /** Options as `--name value` pairs, e.g. `{ tool: 'claude' }`. */
  args: Record<string, string>
  /** The single free-text positional: a prompt, or a group name. */
  body: string
}

/** Mirror of k8s/proxy/mama-queue.ts MamaResult — keep in sync. */
export interface MamaResultWire {
  requestId: string
  ok: boolean
  /** What the caller's stdout gets when ok — already rendered for a human
   *  (or an agent) to read, since the caller is a shell script. */
  output?: string
  error?: string
}
