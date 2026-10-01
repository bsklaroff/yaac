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
import { ACP_ADAPTERS, type AgentTool, type PermissionMode } from '@yaac/shared/types'
import { PI_DEFAULT_PROVIDER, piProviderInfo } from '@yaac/shared/tool-providers'
import { envJsonAssignment } from '#lib/shell'
import { opencodeConfigArg } from './agent-command'
import type { AgentLaunchSpec } from './drivers'

export interface AcpAdapterProfile {
  /** The command the tmux window runs, joined with spaces. Never quoted: the
   *  launch string is embedded in a single-quoted `respawn-window '<cmd>'`. */
  argv: string[]
  /** `NAME=value` assignments prefixed to that command. */
  env(spec: AgentLaunchSpec): string[]
  /**
   * yaac postures mapped to this adapter's session mode ids. A missing
   * posture means "send nothing" (not "send the default"): it is either
   * carried another way (opencode's rules in `OPENCODE_PERMISSION`) or has
   * no meaning for the tool (pi).
   */
  modeIds: Partial<Record<PermissionMode, string>>
  /** Mode ids no posture launches in but the session can switch to, mapped to
   *  the posture they behave as. */
  readsAs?: Record<string, PermissionMode>
  /**
   * How the model is set: `env` before launch, or `set_config_option` (the
   * `model` config option) after the handshake. Never `session/set_model`:
   * opencode v2 removed it and pi-acp 0.0.34 answers "Method not found",
   * while both advertise `model` in `configOptions`.
   */
  modelVia: 'env' | 'set_config_option'
  /**
   * Whether `session/request_permission` still reaches the user under
   * `bypass`. True for pi, which has no permission system; its asks are
   * extension questions that auto-answering would answer for the user.
   */
  forwardAsksUnderBypass: boolean
}

/** The model to name for an ACP conversation. For pi, the provider decides
 *  which api-key env var the egress proxy swaps, so with no override it
 *  still names that provider's default model rather than whatever pi's
 *  settings hold. Other tools send only what the create asked for. */
export function acpLaunchModel(spec: AgentLaunchSpec): string | undefined {
  if (spec.tool !== 'pi') return spec.model
  return spec.model ?? piProviderInfo(spec.piProvider ?? PI_DEFAULT_PROVIDER).defaultModel
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
   */
  claude: {
    argv: [ACP_ADAPTERS.claude.binary],
    env: (spec) => (spec.model !== undefined ? [`ANTHROPIC_MODEL=${spec.model}`] : []),
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
  },

  /**
   * Configured only through env. The model goes in `CODEX_CONFIG`: there is
   * no `--model`, and `session/set_model` ids carry an effort suffix
   * (`gpt-5.2-codex[medium]`) that `MODEL_RE` excludes. `NO_BROWSER=1` stops
   * the ChatGPT login from opening a browser. `CODEX_PATH` makes it run the
   * pinned CLI on PATH rather than the copy it bundles.
   *
   * Its four modes are presets of codex's approval × sandbox grid, one per
   * posture the TUI offers. Its default is `agent`, weaker than
   * `accept-edits`, which is why a failed `session/set_mode` is shown in the
   * pane rather than only logged.
   */
  codex: {
    argv: [ACP_ADAPTERS.codex.binary],
    env: (spec) => [
      'NO_BROWSER=1',
      'CODEX_PATH=codex',
      ...(spec.model !== undefined
        ? [envJsonAssignment('CODEX_CONFIG', { model: spec.model })]
        : []),
    ],
    modeIds: {
      bypass: 'agent-full-access',
      auto: 'agent',
      'accept-edits': 'workspace-write',
      'read-only': 'read-only',
    },
    modelVia: 'env',
    forwardAsksUnderBypass: false,
  },

  /**
   * `opencode acp` is built in, so no separate package can drift from the
   * CLI. Posture uses the same `OPENCODE_CONFIG_CONTENT` document as the TUI.
   *
   * A new acp session reports the server defaults (the `build` agent, the
   * catalog's first model) and applies the config's `default_agent` and
   * `model` only at the first prompt. So `plan` and the model are set over
   * the protocol, which holds and reports them from the start. The
   * permission rules still travel in the config and supply most of what
   * `plan` means (the agent itself only adds `edit deny`). The model goes
   * through `session/set_config_option`, since v2 removed
   * `session/set_model`.
   */
  opencode: {
    argv: [ACP_ADAPTERS.opencode.binary, 'acp'],
    env: (spec) => [opencodeConfigArg(spec.permissionMode, undefined)],
    modeIds: { plan: 'plan' },
    modelVia: 'set_config_option',
    forwardAsksUnderBypass: false,
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
   */
  pi: {
    argv: [ACP_ADAPTERS.pi.binary],
    env: () => [],
    modeIds: {},
    modelVia: 'set_config_option',
    forwardAsksUnderBypass: true,
  },
}

/**
 * The adapter profile for a tool. Every tool has one.
 */
export function acpAdapterFor(tool: AgentTool): AcpAdapterProfile {
  return PROFILES[tool]
}

/**
 * The posture a session mode id stands for (`modeIds` reversed, then
 * `readsAs`), used when the adapter switches mode on its own. Undefined for
 * ids no posture maps to (pi's thinking levels).
 */
export function acpPermissionModeFor(
  profile: Pick<AcpAdapterProfile, 'modeIds' | 'readsAs'>,
  modeId: string,
): PermissionMode | undefined {
  const launched = (Object.keys(profile.modeIds) as PermissionMode[]).find((m) => profile.modeIds[m] === modeId)
  return launched ?? (profile.readsAs !== undefined && Object.hasOwn(profile.readsAs, modeId)
    ? profile.readsAs[modeId]
    : undefined)
}

/** Test-only: the table, to check against the shared adapter list and the
 *  image's versions. */
export const _ACP_PROFILES = PROFILES

/** Whether the model must be sent after the handshake rather than at
 *  launch. */
export function acpModelIsProtocol(profile: AcpAdapterProfile): boolean {
  return profile.modelVia === 'set_config_option'
}
