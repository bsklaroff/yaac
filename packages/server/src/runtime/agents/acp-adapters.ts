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
 * Every value here was verified against the version named in
 * `verifiedAgainst`, which is the version `dockerfiles/Dockerfile.tools`
 * installs (a test pins the two together). That matters more than it looks:
 * an adapter that stops advertising a mode does not fail, it silently runs in
 * its default one, so nothing but a version check tells us the table went
 * stale.
 */
import { ACP_ADAPTERS, type AcpTool, type AgentTool, type PermissionMode } from '@yaac/shared/types'
import { PI_DEFAULT_PROVIDER, piProviderInfo } from '@yaac/shared/tool-providers'
import { envJsonAssignment } from '#lib/shell'
import { opencodePermissionRules } from './opencode'
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
   * Where the model is chosen. `argv`/`env` settle it before the agent starts;
   * `protocol` sends `session/set_model` once the handshake has a session,
   * which is the only route for an adapter that reads its model from the
   * tool's own settings.
   */
  modelVia: 'argv' | 'env' | 'protocol'
  /**
   * Whether `session/load` re-emits the conversation as `session/update`
   * notifications. When it does not, the record acpd keeps is the only copy
   * of the history, so the record must survive the restart (`--append`)
   * instead of being truncated by the new agent life.
   */
  replaysOnLoad: boolean
  /**
   * Whether a `session/request_permission` still reaches the user under the
   * `bypass` posture. True for an adapter whose asks are not permission
   * prompts at all: pi has no permission system, and what it asks are its
   * extensions' own questions ("which of these?"), which auto-answering would
   * answer *for* the user rather than spare them.
   */
  forwardAsksUnderBypass: boolean
  /** The adapter version this profile was verified against, as
   *  `dockerfiles/Dockerfile.tools` pins it. */
  verifiedAgainst: string
}

/** The model an ACP conversation should run, for the profiles that need one
 *  named. pi is the case that makes this more than `spec.model`: its provider
 *  decides which api-key env var the egress proxy swaps, so a pi conversation
 *  with no explicit override still has to name that provider's default model
 *  rather than inherit whatever pi's own settings hold. */
export function acpLaunchModel(spec: AgentLaunchSpec): string | undefined {
  if (spec.tool !== 'pi') return spec.model
  return spec.model ?? piProviderInfo(spec.piProvider ?? PI_DEFAULT_PROVIDER).defaultModel
}

const PROFILES: Record<AcpTool, AcpAdapterProfile> = {
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
    replaysOnLoad: true,
    forwardAsksUnderBypass: false,
    verifiedAgainst: '0.65.0',
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
    replaysOnLoad: true,
    forwardAsksUnderBypass: false,
    verifiedAgainst: '1.8.0',
  },

  /**
   * opencode is its own adapter — `opencode acp` — so there is no second
   * package to install and no version that can drift from the CLI's.
   *
   * Its ACP "modes" are opencode's AGENTS, not postures, so only `plan` is one
   * (the same built-in agent `--agent plan` selects for the TUI). Every other
   * posture is `OPENCODE_PERMISSION`, read from the environment per process by
   * the same code the TUI uses — which is why this shares the TUI's table
   * rather than restating it. `plan` deliberately carries no rules: opencode
   * merges the environment's over the agent's own, so stating any would
   * replace plan's `edit: deny` rather than reinforce it.
   *
   * Alone among the four it does NOT replay on load: `session/load` returns
   * the session's models and modes and emits nothing else, so a reconnect
   * would show an empty conversation if the record had been truncated under it.
   */
  opencode: {
    argv: () => [ACP_ADAPTERS.opencode.binary, 'acp'],
    env: (spec) => {
      const rules = opencodePermissionRules(spec.permissionMode)
      return [
        ...(rules !== undefined ? [envJsonAssignment('OPENCODE_PERMISSION', rules)] : []),
        ...(spec.model !== undefined
          ? [envJsonAssignment('OPENCODE_CONFIG_CONTENT', { model: spec.model })]
          : []),
      ]
    },
    modeIds: { plan: 'plan' },
    modelVia: 'env',
    replaysOnLoad: false,
    forwardAsksUnderBypass: false,
    verifiedAgainst: '1.0.142',
  },

  /**
   * pi-acp drives `pi --mode rpc`, so the pi CLI has to be beside it, and it
   * takes neither flags nor configuration environment: the model is a session
   * config option set after the handshake.
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
    modelVia: 'protocol',
    replaysOnLoad: true,
    forwardAsksUnderBypass: true,
    verifiedAgainst: '0.0.33',
  },
}

/**
 * The adapter profile for a tool, or undefined for one that has no ACP adapter
 * — which is what create checks to refuse `--mode acp` before anything is
 * provisioned, rather than as a window that exits on startup.
 */
export function acpAdapterFor(tool: AgentTool): AcpAdapterProfile | undefined {
  return PROFILES[tool as AcpTool] as AcpAdapterProfile | undefined
}

/** Test-only: the table itself, to check it against the shared adapter list
 *  and the versions the image installs. */
export const _ACP_PROFILES = PROFILES
