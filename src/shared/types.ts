import { z } from 'zod'

export type AgentTool = 'claude' | 'codex' | 'opencode'

export type ToolAuthKind = 'api-key' | 'oauth'

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
 * integration in yaac is OpenRouter-only at the moment.
 */
export type OpencodeCredentialsFile = {
  kind: 'api-key'
  savedAt: string
  apiKey: string
}

/**
 * Per-yaac-session opencode metadata cache. Stores the first-message
 * snapshot so deleted-session listings can still surface it without
 * needing to spin up a sqlite reader against the persisted DB.
 */
export interface OpencodeSessionMeta {
  firstMessage?: string
  /** ISO timestamp of last successful capture. */
  capturedAt?: string
}

/**
 * Summary view over per-tool credential files — used by `auth list`, etc.
 */
export interface ToolAuthEntry {
  tool: AgentTool
  kind: ToolAuthKind
  /** Access token (OAuth) or raw API key. */
  apiKey: string
  savedAt: string
  /** OAuth only. */
  refreshToken?: string
  /** OAuth only. Unix epoch ms. */
  expiresAt?: number
  /** Claude OAuth only. */
  scopes?: string[]
  /** Claude OAuth only. */
  subscriptionType?: string
  /** Codex OAuth only — the full bundle, carried here so consumers like
   *  `auth list` can render plan type / email from the id_token. */
  codexBundle?: CodexOAuthBundle
}

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

export interface PostgresRelayConfig {
  /** Whether to enable the PostgreSQL relay (default: false) */
  enabled: boolean
  /** Port PostgreSQL listens on the host (default: 5432) */
  hostPort?: number
  /** Port to expose inside the relay container (default: 5432) */
  containerPort?: number
}

export interface YaacConfig {
  envPassthrough?: string[]
  env?: Record<string, string>
  envSecretProxy?: Record<string, SecretProxyRule>
  cacheVolumes?: Record<string, string>
  initCommands?: string[]
  nestedContainers?: boolean
  portForward?: PortForwardConfig[]
  bindMounts?: BindMountConfig[]
  hideInitPane?: boolean
  pgRelay?: PostgresRelayConfig
  addAllowedUrls?: string[]
  setAllowedUrls?: string[]
  /**
   * Paths (relative to /workspace) whose directory should be redirected
   * to `.cached-packages/modules/<sessionId>/<slotKey>` via a symlink,
   * so package-manager writes don't land on the host worktree. Sharing
   * a filesystem with pnpm-store keeps hardlinks across sessions.
   * Unset → `["node_modules"]`. Empty array disables the feature.
   */
  ephemeralModulesPaths?: string[]
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

export interface SessionMeta {
  id: string
  containerId: string
  containerName: string
  proxyToken: string | null
  worktreeBranch: string
  createdAt: string
  status: 'running' | 'waiting' | 'stopped'
}

// ---------------------------------------------------------------------------
// Wire types — RPC request/response shapes used across the daemon/CLI
// boundary. Lib and daemon modules return these; commands receive them via
// the Hono RPC client.
// ---------------------------------------------------------------------------

/** Host↔container port mapping returned by `/session/create`. */
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
}

export interface AuthListResult {
  gitCredentials: GitCredentialSummary[]
  toolAuth: ToolAuthSummary[]
}

// --- session/list ---

export interface SessionListEntry {
  sessionId: string
  projectSlug: string
  tool: AgentTool
  status: 'running' | 'waiting' | 'prewarm'
  /** Container created time as 'YYYY-MM-DD HH:MM:SS' (UTC). */
  createdAt: string
  prompt?: string
  blockedHosts: string[]
}

export interface StaleSessionInfo {
  containerName: string
  projectSlug: string
  sessionId: string
  /** True when the container is still running but tmux is gone. */
  zombie: boolean
}

export interface FailedPrewarmInfo {
  slug: string
  fingerprint: string
  /** Unix epoch ms. */
  verifiedAt: number
}

export interface ActiveSessionsResult {
  sessions: SessionListEntry[]
  stale: StaleSessionInfo[]
  failedPrewarms: FailedPrewarmInfo[]
}

export interface DeletedSessionEntry {
  sessionId: string
  projectSlug: string
  tool: AgentTool
  /** 'YYYY-MM-DD HH:MM:SS' (UTC). */
  createdAt: string
  /** First user message from the transcript, if any. */
  prompt?: string
}

// --- session stream picker ---

export type StreamOutcome = 'detached' | 'closed_blank' | 'closed_prompted' | 'none'

export interface PickNextInput {
  project?: string
  tool?: AgentTool
  visited: string[]
  lastVisited?: string
  /**
   * Project slug of the last-attached session. The daemon uses it to
   * look up the session transcript if the session disappeared between
   * this call and the previous one — which tells us whether the user
   * closed a blank session.
   */
  lastProjectSlug?: string
  lastTool?: AgentTool
  lastOutcome: StreamOutcome
}

export type PickNextResult =
  | {
      done: false
      sessionId: string
      containerName: string
      tmuxSession: 'yaac'
      projectSlug: string
      tool: AgentTool
      visited: string[]
      lastVisited: string
    }
  | {
      done: true
      reason: 'no_active' | 'closed_blank' | 'needs_project'
      candidates?: string[]
    }

// ---------------------------------------------------------------------------
// Webapp event stream — pushed over the `/events` WebSocket. The slice
// pushes a full snapshot on connect and after each background-loop tick
// when the state changed; granular per-entity events come later.
// ---------------------------------------------------------------------------

/**
 * Project row in the snapshot. Structurally matches `ProjectListEntry`
 * from `@/lib/project/list`; inlined here so this module stays
 * browser-safe (the frontend imports it without pulling node-only lib
 * files into its type graph).
 */
export interface ProjectSummary {
  slug: string
  remoteUrl: string
  addedAt: string
  sessionCount: number
}

/**
 * Prewarm row in the snapshot. Structurally matches `PrewarmEntry` from
 * `@/lib/prewarm`; inlined for the same browser-safety reason.
 */
export interface PrewarmSummary {
  sessionId: string
  containerName: string
  fingerprint: string
  state: 'creating' | 'ready' | 'failed'
  verifiedAt: number
  tool?: AgentTool
}

/**
 * Full picture of daemon-owned state the webapp renders. Hydrated from a
 * `snapshot` event on connect and replaced wholesale on every subsequent
 * `snapshot`. Mirrors the union of `GET /session/list`, `GET /project/list`,
 * and `GET /prewarm`.
 */
export interface DaemonSnapshot {
  sessions: SessionListEntry[]
  stale: StaleSessionInfo[]
  failedPrewarms: FailedPrewarmInfo[]
  projects: ProjectSummary[]
  prewarm: Record<string, PrewarmSummary>
}

/** Messages the daemon pushes over `/events`. */
export type DaemonEvent =
  | { type: 'snapshot'; data: DaemonSnapshot }
