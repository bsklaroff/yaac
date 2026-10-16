/**
 * Per-tool facts about each ACP adapter: how it is launched, how it is told
 * a permission posture and a model, and whether it replays history on
 * reconnect. Kept in one table because the facts are related (e.g. a tool
 * that cannot take a model at launch must be sent one over the protocol).
 *
 * Every value was verified against `ACP_ADAPTERS[tool].verified`, the
 * version `dockerfiles/Dockerfile.tools` installs and host installs pin (a
 * test ties them together). An adapter that drops a mode does not fail; it
 * silently runs its default, so only the version check catches drift.
 */
import { ACP_ADAPTERS, launchablePermissionMode, type AgentTool, type PermissionMode } from '@yaac/shared/types'
import { PI_DEFAULT_PROVIDER, piProviderInfo } from '@yaac/shared/tool-providers'
import { envJsonAssignment } from '#lib/shell'
import { claudeModelArg, opencodeConfigArg } from './agent-command'
import { CLAUDE_SESSION_META, CODEX_CAPABILITIES_META, OPENCODE_CAPABILITIES_META } from './acp-protocol'
import { type AcpSessionProfile } from './acp-client'
import type { AgentLaunchSpec } from './drivers'

export interface AcpAdapterProfile extends AcpSessionProfile {
  /** The command the tmux window runs, joined with spaces. Never quoted: the
   *  launch string is embedded in a single-quoted `respawn-window '<cmd>'`. */
  argv: string[]
  /** `NAME=value` assignments prefixed to that command. */
  env(spec: AgentLaunchSpec): string[]
  /**
   * How the model is set: `env` before launch, or `set_config_option` (the
   * `model` config option) after the handshake. Never `session/set_model`:
   * opencode v2 removed it and pi-acp 0.0.34 answers "Method not found",
   * while both advertise `model` in `configOptions`.
   */
  modelVia: 'env' | 'set_config_option'
}

/** The model to name for an ACP conversation. For pi, the provider decides
 *  which api-key env var the egress proxy swaps, so with no override it
 *  still names that provider's default model rather than whatever pi's
 *  settings hold. Other tools send only what the create asked for. */
export function acpLaunchModel(spec: Pick<AgentLaunchSpec, 'tool' | 'model' | 'piProvider'>): string | undefined {
  if (spec.tool !== 'pi') return spec.model
  return spec.model ?? piProviderInfo(spec.piProvider ?? PI_DEFAULT_PROVIDER).defaultModel
}

/**
 * codex-acp's mode presets as codex config, sent at launch so a loaded
 * thread starts in its posture. codex restores the approval policy, reviewer
 * and sandbox a thread last ran with unless `thread/resume` names each, and
 * codex-acp names none (its `session/set_mode` applies only from the next
 * `turn/start`), so a turn the thread starts by itself, such as a goal
 * continuing, would otherwise run in the last life's posture.
 */
const CODEX_POSTURE_CONFIG: Partial<Record<PermissionMode, Record<string, string>>> = {
  bypass: { approval_policy: 'never', approvals_reviewer: 'user', sandbox_mode: 'danger-full-access' },
  auto: { approval_policy: 'on-request', approvals_reviewer: 'auto_review', sandbox_mode: 'workspace-write' },
  'accept-edits': { approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'workspace-write' },
  'read-only': { approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'read-only' },
}

const PROFILES: Record<AgentTool, AcpAdapterProfile> = {
  /**
   * Has a mode for every posture.
   *
   * The model comes only from `ANTHROPIC_MODEL`; the adapter ignores argv,
   * so `--model` would be silently dropped. It reports the picker's alias
   * (`opus`) where one exists.
   *
   * ACP's `default` mode is "Manual". `dontAsk` (deny anything not
   * pre-approved) is never selected by yaac and reads as `manual`.
   *
   * Its running/idle report must be asked for (`CLAUDE_SDK_MESSAGE`).
   */
  claude: {
    argv: [ACP_ADAPTERS.claude.binary],
    env: (spec) => (spec.model !== undefined ? [`ANTHROPIC_MODEL=${claudeModelArg(spec.model)}`] : []),
    modeIds: {
      bypass: 'bypassPermissions',
      auto: 'auto',
      'accept-edits': 'acceptEdits',
      plan: 'plan',
      manual: 'default',
    },
    readsAs: { dontAsk: 'manual' },
    modelVia: 'env',
    forwardAsksUnderBypass: false,
    steers: true,
    sessionMeta: CLAUDE_SESSION_META,
  },

  /**
   * Configured only through env. The posture's settings
   * (`CODEX_POSTURE_CONFIG`) and the model go in `CODEX_CONFIG`: there is
   * no `--model`, and `session/set_model` ids carry an effort suffix
   * (`gpt-5.2-codex[medium]`) that `MODEL_RE` excludes. `NO_BROWSER=1` stops
   * the ChatGPT login from opening a browser. `CODEX_PATH` makes it run the
   * pinned CLI on PATH rather than the copy it bundles.
   *
   * Its four modes are presets of codex's approval × sandbox grid, one per
   * posture the TUI offers. Its default is `agent`, weaker than
   * `accept-edits`, which is why a failed `session/set_mode` steps down to a
   * stricter mode and is shown in the pane rather than only logged.
   *
   * Reports its thread's running/idle state unasked (`agentRunningReport`),
   * goal continuations included.
   */
  codex: {
    argv: [ACP_ADAPTERS.codex.binary],
    env: (spec) => [
      'NO_BROWSER=1',
      'CODEX_PATH=codex',
      envJsonAssignment('CODEX_CONFIG', {
        ...CODEX_POSTURE_CONFIG[launchablePermissionMode('codex', spec.permissionMode)],
        ...(spec.model !== undefined ? { model: spec.model } : {}),
      }),
    ],
    modeIds: {
      bypass: 'agent-full-access',
      auto: 'agent',
      'accept-edits': 'workspace-write',
      'read-only': 'read-only',
    },
    modelVia: 'env',
    forwardAsksUnderBypass: false,
    steers: true,
    capabilitiesMeta: CODEX_CAPABILITIES_META,
  },

  /**
   * `opencode acp` is built in, so no separate package can drift from the
   * CLI. Posture uses the same `OPENCODE_CONFIG_CONTENT` document as the TUI,
   * and a new session starts in its `default_agent`, so `plan` is already
   * the session's mode; mapping it lets that mode read as the posture. The
   * model goes through `session/set_config_option`, since v2 removed
   * `session/set_model`.
   */
  opencode: {
    argv: [ACP_ADAPTERS.opencode.binary, 'acp'],
    env: (spec) => [opencodeConfigArg(spec.permissionMode, undefined)],
    modeIds: { plan: 'plan' },
    modelVia: 'set_config_option',
    forwardAsksUnderBypass: false,
    steers: false,
    capabilitiesMeta: OPENCODE_CAPABILITIES_META,
  },

  /**
   * pi-acp drives `pi --mode rpc` (so the pi CLI must be installed) and
   * takes no flags or config env. The model is sent after the handshake as
   * the `model` config option. This matters: pi's model id names the
   * provider, which decides the api-key var the egress proxy swaps.
   *
   * Its `availableModes` are the model's thinking levels (`off`, `low`, …),
   * not postures, so pi is `bypass`-only. Its asks are extension questions, so they are
   * forwarded even under `bypass`.
   *
   * An extension can start a run (`sendMessage` with `triggerTurn`). The
   * pi-acp patch adopts it, reporting its start and queueing prompts behind
   * it.
   */
  pi: {
    argv: [ACP_ADAPTERS.pi.binary],
    env: () => [],
    modeIds: {},
    modelVia: 'set_config_option',
    forwardAsksUnderBypass: true,
    steers: true,
  },
}

/**
 * The adapter profile for a tool. Every tool has one.
 */
export function acpAdapterFor(tool: AgentTool): AcpAdapterProfile {
  return PROFILES[tool]
}

/** Test-only: the table, to check against the shared adapter list and the
 *  image's versions. */
export const _ACP_PROFILES = PROFILES

/** Whether the model must be sent after the handshake rather than at
 *  launch. */
export function acpModelIsProtocol(profile: AcpAdapterProfile): boolean {
  return profile.modelVia === 'set_config_option'
}
