import { z } from 'zod'

export type AgentTool = 'claude' | 'codex' | 'opencode'

export type ToolAuthKind = 'api-key' | 'oauth'

/**
 * Backend an opencode session authenticates against. Both are api-key only
 * and both are first-class opencode providers (registered in models.dev), so
 * the only runtime difference is which env var carries the key and which host
 * the proxy swaps the placeholder on. Stored on the opencode credential and
 * chosen at `yaac auth update` time; legacy credentials (no provider field)
 * load as 'openrouter'.
 */
export type OpencodeProvider = 'openrouter' | 'neuralwatt'

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
 * integration in yaac authenticates via an api-key for either OpenRouter or
 * NeuralWatt. `provider` defaults to 'openrouter' on load for credentials
 * written before the field existed.
 */
export type OpencodeCredentialsFile = {
  kind: 'api-key'
  provider: OpencodeProvider
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
  /** opencode only — which backend the stored api-key authenticates against. */
  opencodeProvider?: OpencodeProvider
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

/**
 * Object form of an `initCommands` entry. Each spec becomes its own tmux
 * window so multiple long-running processes (e.g. a backend and a frontend
 * dev server) can run in parallel and be inspected independently.
 */
export interface InitCommandSpec {
  /** tmux window name. Must be unique, kebab-ish, and must not collide
   *  with the agent window name (claude/codex/opencode). */
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
   * Run an in-pod rootless podman so `docker build` / `docker run` /
   * `docker compose` work inside sessions. Adds the nestable image layer
   * and the nested pod-spec branch (userns-scoped SYS_ADMIN, graphroot
   * emptyDir, shared image store).
   */
  nestedContainers?: boolean
  /**
   * Give each session its own virtual kubernetes cluster (vcluster) plus
   * a per-project push registry the node can pull from. Implies
   * `nestedContainers` (the in-pod podman is the session's only build
   * engine, so vcluster workflows that build images need it); the config
   * parser rejects an explicit `nestedContainers: false` alongside this.
   */
  virtualCluster?: boolean
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
  /** opencode only — which backend the stored api-key authenticates against. */
  opencodeProvider?: OpencodeProvider
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
  status: 'running' | 'waiting'
  /** Pod created time as 'YYYY-MM-DD HH:MM:SS' (UTC). */
  createdAt: string
  /** Epoch ms when the current waiting spell began, stamped by the
   *  daemon's push-fed status store at the transition itself. Only set
   *  while status is 'waiting'; a new spell gets a new value, so clients
   *  can tell "still the same wait" from "waited, ran, waits again" —
   *  even for sub-second turns. In-memory on the daemon: a restart (or a
   *  still-booting session with no watcher yet) has no stamp, which
   *  clients treat as its own spell. */
  waitingSinceMs?: number
  prompt?: string
  /** User-assigned display title (falls back to `prompt` in UIs). */
  title?: string
  blockedHosts: string[]
}

export interface StaleSessionInfo {
  jobName: string
  projectSlug: string
  sessionId: string
  /** True when the pod is still running but tmux is gone. */
  zombie: boolean
}

export interface ActiveSessionsResult {
  sessions: SessionListEntry[]
  stale: StaleSessionInfo[]
}

export interface DeletedSessionEntry {
  sessionId: string
  projectSlug: string
  tool: AgentTool
  /** 'YYYY-MM-DD HH:MM:SS' (UTC). */
  createdAt: string
  /** First user message from the transcript, if any. */
  prompt?: string
  /** User-assigned display title (survives delete; ids are stable). */
  title?: string
}

/** A webapp-attachable terminal inside a session's container (beyond the
 *  primary agent view): a `yaac`-session tmux window — an initCommands
 *  window (dev server, watcher, …) or a scratch shell. */
export interface SessionTerminalEntry {
  /** /pty/attach target: 'window:@<id>'. */
  target: string
  /** Display name (the tmux window name). */
  name: string
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
      jobName: string
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
 * A session that is currently provisioning — a create or restart in flight,
 * tracked in daemon memory and surfaced in the snapshot so the webapp renders
 * it as a first-class, selectable sidebar row that survives a reload (with live
 * progress) until the real session lands or a failure is dismissed.
 */
export interface ProvisioningSessionEntry {
  sessionId: string
  projectSlug: string
  tool: AgentTool
  kind: 'create' | 'restart'
  /** Latest progress line (e.g. 'Pulling image…'). */
  message: string
  /** Set when provisioning failed; the row stays until dismissed. */
  error?: string
  /** 'YYYY-MM-DD HH:MM:SS' UTC, derived from when provisioning started — so
   *  the sidebar can show a relative age for a row that has no pod yet. */
  createdAt: string
}

/**
 * Full picture of daemon-owned state the webapp renders. Hydrated from a
 * `snapshot` event on connect and replaced wholesale on every subsequent
 * `snapshot`. Mirrors the union of `GET /session/list` and
 * `GET /project/list`.
 */
export interface DaemonSnapshot {
  sessions: SessionListEntry[]
  stale: StaleSessionInfo[]
  projects: ProjectSummary[]
  provisioning: ProvisioningSessionEntry[]
}

/** Messages the daemon pushes over `/events`. */
export type DaemonEvent =
  | { type: 'snapshot'; data: DaemonSnapshot }
