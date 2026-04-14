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
  /** Whether the mount is writable (default: false — mounts are read-only by default) */
  writable?: boolean
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
  /** Whether to enable the PostgreSQL relay (default: true if section present) */
  enabled?: boolean
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
  postgres?: PostgresRelayConfig
}

export interface GithubTokenEntry {
  /** Pattern: "*", "<owner>/*", or "<owner>/<repo>" */
  pattern: string
  token: string
}

export interface CredentialsFile {
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
