export type AgentTool = 'claude' | 'codex'

export type ToolAuthKind = 'api-key' | 'oauth'

/**
 * Claude Code's native OAuth bundle. Stored under the "claudeAiOauth" key in
 * both Claude's `.credentials.json` and yaac's host-side mirror.
 */
export interface ClaudeOAuthBundle {
  accessToken: string
  refreshToken: string
  /** Unix epoch in milliseconds. */
  expiresAt: number
  scopes: string[]
  subscriptionType?: string
}

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
export interface CodexOAuthBundle {
  accessToken: string
  refreshToken: string
  /** Full signed JWT — identity assertion, not a bearer credential. Flows
   *  through the proxy into the container's auth.json unmodified. */
  idTokenRawJwt: string
  /** Unix epoch ms, derived from access_token JWT `exp` (best-effort; falls
   *  back to now + 28d to mirror Codex's proactive-refresh window). */
  expiresAt: number
  /** ISO timestamp matching Codex's `last_refresh`. */
  lastRefresh: string
  /** Top-level `tokens.account_id` from Codex's auth.json — distinct from
   *  id_token's `chatgpt_account_id` claim. Codex uses this to populate the
   *  `ChatGPT-Account-Id` request header on api.openai.com, so it must flow
   *  through to the container unchanged. */
  accountId?: string
}

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
}

export interface GithubTokenEntry {
  /** Pattern: "*", "<owner>/*", or "<owner>/<repo>" */
  pattern: string
  token: string
}

/**
 * Shape of `~/.yaac/.credentials/github.json`.
 */
export interface GithubCredentialsFile {
  tokens: GithubTokenEntry[]
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
