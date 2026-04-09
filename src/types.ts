export interface ProjectMeta {
  slug: string
  remoteUrl: string
  addedAt: string
}

export interface YaacConfig {
  envPassthrough?: string[]
  envSecretProxy?: Record<string, string[]>
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
