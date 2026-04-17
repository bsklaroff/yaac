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
 * Shape of `~/.yaac/.credentials/codex.json`.
 */
export interface CodexCredentialsFile {
  kind: ToolAuthKind
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
  /** OAuth only. */
  scopes?: string[]
  /** OAuth only. */
  subscriptionType?: string
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
