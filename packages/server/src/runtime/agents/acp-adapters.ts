/**
 * What each tool's ACP adapter is, and everything about it that differs from
 * the others: how it is launched, how it is told a posture, how it is told a
 * model, and whether it rebuilds a conversation's history when reconnected.
 *
 * One table rather than four branches scattered through the driver and the
 * client, because these facts are not independent — a tool that cannot take a
 * model on its command line is exactly the tool that has to be sent one over
 * the protocol, and the posture it can honor follows from the modes its adapter
 * advertises. Read together they are a description of an adapter; read apart
 * they are four `if (tool === …)` chains that drift.
 *
 * Every value here was verified against `ACP_ADAPTERS[tool].verified`, which
 * is both the version `dockerfiles/Dockerfile.tools` installs and the one a
 * host install pins to (a test ties the record to the Dockerfile). That
 * matters more than it looks: an adapter that stops advertising a mode does
 * not fail, it silently runs in its default one, so nothing but a version
 * check tells us the table went stale.
 */
import { ACP_ADAPTERS, type AgentTool, type PermissionMode } from '@yaac/shared/types'
import { PI_DEFAULT_PROVIDER, piProviderInfo } from '@yaac/shared/tool-providers'
import { envJsonAssignment } from '#lib/shell'
import { opencodeConfigArg } from './agent-command'
import type { AgentLaunchSpec } from './drivers'

export interface AcpAdapterProfile {
  /** What the tmux window execs, as an argv the launch command joins with
   *  spaces. Never quoted — the whole launch string is embedded in a
   *  single-quoted `respawn-window '<cmd>'`. */
  argv(spec: AgentLaunchSpec): string[]
  /** `NAME=value` assignments prefixed to that command. */
  env(spec: AgentLaunchSpec): string[]
  /**
   * yaac's postures as the session mode ids this adapter advertises. A posture
   * that is absent is one the adapter has no mode for — either because it is
   * carried some other way (opencode's rules ride `OPENCODE_PERMISSION` at
   * launch) or because the tool has no such notion (pi). Absent means "send
   * nothing", never "send the default".
   */
  modeIds: Partial<Record<PermissionMode, string>>
  /**
   * Where the model is chosen. `argv` and `env` settle it before the agent
   * starts; `set_config_option` settles it after the handshake, as the `model`
   * config option, for an adapter that otherwise reads its model from the
   * tool's own settings. Never `session/set_model`: neither pinned adapter
   * that needs this answers it (opencode removed it in v2, and pi-acp 0.0.33
   * answers "Method not found"), while both advertise `model` among their
   * `configOptions`.
   */
  modelVia: 'argv' | 'env' | 'set_config_option'
  /**
   * Whether a `session/request_permission` still reaches the user under the
   * `bypass` posture. True for an adapter whose asks are not permission
   * prompts at all: pi has no permission system, and what it asks are its
   * extensions' own questions ("which of these?"), which auto-answering would
   * answer *for* the user rather than spare them.
   */
  forwardAsksUnderBypass: boolean
}

/** The model an ACP conversation should run, for the profiles that need one
 *  named. pi is the case that makes this more than `spec.model`: its provider
 *  decides which api-key env var the egress proxy swaps, so a pi conversation
 *  with no explicit override still has to name that provider's default model
 *  rather than inherit whatever pi's own settings hold. Every other tool sends
 *  only what the create asked for. */
export function acpLaunchModel(spec: AgentLaunchSpec): string | undefined {
  if (spec.tool !== 'pi') return spec.model
  return spec.model ?? piProviderInfo(spec.piProvider ?? PI_DEFAULT_PROVIDER).defaultModel
}

const PROFILES: Record<AgentTool, AcpAdapterProfile> = {
  /**
   * claude's adapter takes the model on its command line and names a mode for
   * every posture — the case every other profile is a departure from.
   *
   * The one mode id that does not read across is `manual`: ACP's id for "ask
   * me about everything" is `default`, which the adapter labels "Manual". It
   * also offers `dontAsk` (deny anything not pre-approved), which yaac has no
   * posture for and never selects.
   */
  claude: {
    argv: (spec) => [
      ACP_ADAPTERS.claude.binary,
      ...(spec.model !== undefined ? ['--model', spec.model] : []),
    ],
    env: () => [],
    modeIds: {
      bypass: 'bypassPermissions',
      auto: 'auto',
      'accept-edits': 'acceptEdits',
      plan: 'plan',
      manual: 'default',
    },
    modelVia: 'argv',
    forwardAsksUnderBypass: false,
  },

  /**
   * codex-acp takes no flags at all: everything is environment.
   *
   * `CODEX_CONFIG` is merged into the codex session config, which is how a
   * model is named — codex-acp's own `--model` does not exist, and the model
   * ids its `session/set_model` accepts carry a reasoning-effort suffix
   * (`gpt-5.2-codex[medium]`) that yaac's `MODEL_RE` deliberately excludes.
   * The plain id is what `codex --model` takes too, so one spelling serves
   * both modes.
   *
   * `NO_BROWSER=1` because the adapter's ChatGPT login would otherwise try to
   * open one; a worktree authenticates from the credentials it was launched
   * with or not at all.
   *
   * Its three modes are codex's approval × sandbox grid, collapsed: nothing
   * there is `plan` or `manual`, which is why neither is a posture codex can
   * be created with under acp.
   *
   * Its own default is `agent` — NOT the codex CLI's `read-only` preset — so
   * this is the one adapter where failing to set a mode lands somewhere weaker
   * than an `accept-edits` create asked for. That is why a failed
   * `session/set_mode` is reported in the pane rather than only logged.
   */
  codex: {
    argv: () => [ACP_ADAPTERS.codex.binary],
    env: (spec) => [
      'NO_BROWSER=1',
      ...(spec.model !== undefined
        ? [envJsonAssignment('CODEX_CONFIG', { model: spec.model })]
        : []),
    ],
    modeIds: {
      bypass: 'agent-full-access',
      auto: 'agent',
      'accept-edits': 'read-only',
    },
    modelVia: 'env',
    forwardAsksUnderBypass: false,
  },

  /**
   * opencode is its own adapter — `opencode acp` — so there is no second
   * package to install and no version that can drift from the CLI's.
   *
   * Its posture is the same `OPENCODE_CONFIG_CONTENT` document the TUI is
   * launched with, built by the same function: opencode reads it per process
   * whichever front end is running, so one table answers for both modes.
   *
   * Two halves of that document are NOT honored under acp, both verified
   * against the pinned build:
   *
   *  - `default_agent` is ignored, so `plan` — one of opencode's own agents —
   *    has to be selected over the protocol instead. It is the only posture
   *    with a mode id here; the rest are entirely permission rules. The
   *    rules still travel in the config, and they are most of what `plan`
   *    means: the agent adds `edit deny`, but says nothing about running
   *    commands.
   *  - `model` is ignored, so a `--model` create is honored by a
   *    `session/set_config_option` after the handshake. Its `session/set_model`
   *    was removed in v2 — it answers "Method not found" — which is why the
   *    method is part of this profile rather than one spelling for everyone.
   */
  opencode: {
    argv: () => [ACP_ADAPTERS.opencode.binary, 'acp'],
    env: (spec) => [opencodeConfigArg(spec.permissionMode, undefined)],
    modeIds: { plan: 'plan' },
    modelVia: 'set_config_option',
    forwardAsksUnderBypass: false,
  },

  /**
   * pi-acp drives `pi --mode rpc`, so the pi CLI has to be beside it, and it
   * takes neither flags nor configuration environment: the model is sent
   * after the handshake, as the `model` config option — the one route its
   * `setSessionConfigOption` answers (its `session/set_model` is not routed).
   *
   * That is not a cosmetic difference. pi's model id names its provider
   * (`openrouter/…`), and the provider decides which api-key variable the
   * egress proxy swaps — so a pi conversation that never sends one is a pi
   * conversation authenticating against whatever provider pi's shared settings
   * happen to name.
   *
   * Its `availableModes` are THINKING levels (`off`…`xhigh`), not postures, and
   * `session/set_mode` rejects anything else — so no posture maps to a mode
   * here, and pi stays `bypass`-only in both agent modes. What it does ask
   * about are its extensions' own questions, which is why they are forwarded
   * even under `bypass`: there is no permission being waived, only a person
   * being asked to choose.
   */
  pi: {
    argv: () => [ACP_ADAPTERS.pi.binary],
    env: () => [],
    modeIds: {},
    modelVia: 'set_config_option',
    forwardAsksUnderBypass: true,
  },
}

/**
 * The adapter profile for a tool. Total: every tool has an adapter, so there
 * is no "this tool cannot do acp" case for a caller to handle — what a create
 * can still be refused for is a POSTURE the adapter has no mode for
 * (`ACP_SUPPORTED_PERMISSION_MODES`).
 */
export function acpAdapterFor(tool: AgentTool): AcpAdapterProfile {
  return PROFILES[tool]
}

/**
 * The posture a session mode id stands for — `modeIds` read backwards, which
 * is how a mode the adapter moved to by itself becomes the worktree's posture.
 * Undefined for an id no posture maps to (claude's `dontAsk`, pi's thinking
 * levels), which is left unrecorded rather than rounded to a neighbour.
 */
export function acpPermissionModeFor(
  profile: Pick<AcpAdapterProfile, 'modeIds'>,
  modeId: string,
): PermissionMode | undefined {
  const entry = Object.entries(profile.modeIds).find(([, id]) => id === modeId)
  return entry?.[0] as PermissionMode | undefined
}

/** Test-only: the table itself, to check it against the shared adapter list
 *  and the versions the image installs. */
export const _ACP_PROFILES = PROFILES

/** Whether this adapter has to be TOLD its model after the handshake, rather
 *  than being launched with one. */
export function acpModelIsProtocol(profile: AcpAdapterProfile): boolean {
  return profile.modelVia === 'set_config_option'
}
