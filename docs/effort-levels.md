# Effort levels

Effort is how hard a workspace's model thinks. It is a create setting beside
model and permission mode: the **New workspace** dialog's Effort row (right
below Model), `yaac workspace create --effort`, and `yaac-mama create | queue
| edit-queued --effort`. It is remembered per (project, agent) like the
others, carried by drafts, queued entries and spares, passed at every launch
in both agent modes, and followed when the agent changes it. The chat pane
shows it beside the permission posture and can switch it. Nothing else
shows it: not the sidebar, and not a running `tui` workspace, whose agent
shows its own.

## Vocabulary

Each tool names its levels its own way, and which levels exist depends on
the model, so an effort is a string in the tool's own words (like a model
id), not a shared enum. `EFFORT_RE` (one lowercase word) bounds its shape,
since it is embedded bare in launch commands.

| Tool | Values | Passed as (`tui` / `acp`) |
|---|---|---|
| claude | `low medium high xhigh max` | `--effort` / the `effort` option |
| codex | `none minimal low medium high xhigh max ultra` | `-c model_reasoning_effort=` / the `reasoning_effort` option |
| opencode | `default none minimal low medium high xhigh max thinking` | the agents' `variant` (beside their `model`) in `OPENCODE_CONFIG_CONTENT` / the `effort` option |
| pi | `off minimal low medium high xhigh max` | `--thinking` / the `thought_level` option |

opencode calls its levels variants. `default` is a real choice there: no
variant, so the provider's own default applies.

## Per-model levels and defaults

`pnpm gen:providers` bakes each model's levels and default into
`tool-providers.generated.ts` (`EFFORTS`, keyed like the model catalogs). A
model without an entry has no effort setting: it launches with none and the
dialog shows "—". Each tool's own catalog is the source, since models.dev
lists what a vendor's API accepts, which is not what each CLI offers:

- **claude**: the model table built into the pinned binary. No public source
  has Claude Code's own levels or defaults: the Models API reports per-level
  support but no default, the effort docs give the API's defaults (which
  Claude Code overrides, e.g. `xhigh` for opus-4-7), and the SDK's
  `initialize` covers only the picker's aliases. The generator matches each
  entry's `first_party` id to its `capabilities` (`effort`, `xhigh_effort`,
  `max_effort`) and `default_effort`, which is `high` where an entry names
  none, as in claude. The same table limits the claude catalog
  (`CLAUDE_MODELS`): a models.dev model the pinned claude does not know is
  left out until claude is bumped. claude can still move a default at
  runtime through a server-side flag; the pinned value wins at launch.
- **codex**: `codex debug models --bundled`, which differs from models.dev
  (`ultra`, no `none` for current models). An openai model codex does not
  bundle takes models.dev's levels and `medium`, codex's own assumption for
  an unknown model.
- **pi**: pi-ai's `getSupportedThinkingLevels`, with `DEFAULT_THINKING_LEVEL`
  clamped to the model as the default. Models without reasoning get none.
- **opencode**: asked of opencode itself. A private `opencode serve` with
  every provider given a placeholder key lists each model's computed
  variants on `/api/model`; no key-less call does. It answers before it has
  loaded models.dev, at first with only its built-in provider, so it is
  polled until two answers agree and at least half the providers models.dev
  gives reasoning options have variants. Levels lead with `default`, which
  is also the default.

The generator stops without writing when a source cannot be trusted: a
pinned CLI is not the installed one, claude's table no longer parses (no
entries, an entry the parser cannot read, an unknown effort capability, a
`default_effort` somewhere other than right after the capabilities, a
default outside its levels), the claude catalog loses
`FALLBACK_MODELS.claude`, opencode covers too few providers, or a tool yields
no data at all. It only prints a line for what an ordinary
regeneration produces: claude models dropped as unknown to the pinned claude,
and openai models codex does not bundle. A unit test pins a few rows, so a
regeneration that quietly loses a source fails CI.

The table stays on the server; the create dialog gets each model's levels on
its `ModelOption`, so it and the server resolve from the same data.

## Why every launch names a level

Every tool saves an in-session effort change into its home: claude's
`/effort` writes `effortLevel` to its settings, codex's `/model` writes
`model_reasoning_effort` to `config.toml`, and pi saves its default and
per-model thinking levels. A project's workspaces share those homes, so a
launch that names nothing would run at whatever another workspace last
picked. The launch values outrank those files (checked live for claude's
`--effort` against 2.1.286 and pi's `--thinking` against 0.99.2).

opencode is the exception both ways. Its TUI saves its per-model variant in
its state directory (`model.json`), which is not in a shared tool home (a
pod's own under k8s, the workspace's private `$HOME` under containerless),
so no other workspace reaches it. But within one workspace that saved pick
outranks the launch's agent `variant` (checked against 2.0.21): a restart
after a `/variants` pick runs at the pick, which is also the level the row
followed.

## Resolution

`resolveToolCreateDefaults` and `resolveCreate` pick an effort after the
model, most specific first:

1. what the request named, refused if the model has levels and lacks it, or
   if it is a catalog model with none; a model outside the catalog takes it
   as is, like the model itself;
2. what the project remembers for the agent, if the model has it (one level
   name means the same across a tool's models);
3. the model's default;
4. none, for a model with no levels.

Only a level the request named is remembered. A model change in the dialog
or an `edit-queued` keeps a picked level the new model has and re-resolves
one it lacks. `yaac-mama` resolves the same way, with no ceiling (effort is
not a restraint) and no inheritance from the caller, whose level may not
exist on the child's model; a named level the model lacks is refused before
the detached create starts. `yaac-mama models` lists each model's levels and
stars its default.

A restart relaunches at the workspace row's effort, checked against the model
the conversation last reported, so a level that model lacks becomes its
default, as does a row with none (one created before effort existed). A spare warmed at another effort is respawned at the claimed one.

## Storage

A nullable `effort` column on `project_tool_defaults`, `workspaces`,
`queued_workspaces` and `draft_workspaces`. Null means no effort, which is
what a model without levels launches with.

## Under `acp`

Every pinned adapter offers effort as the session config option with the ACP
category `thought_level`. A new or loaded conversation is put at the row's
effort with `session/set_config_option`, read before the session reports its
own. A level the session does not offer is reported in the pane and
survived, like a model it would not take. The option's current value and
choices are read from every message carrying session state (handshake
replies, `set_config_option` replies, `config_option_update`), which also
covers an adapter re-seeding effort after a model switch. A reattach runs no
handshake, so it reads the last option back from acpd's record.

The pane gets an `effort` frame (current level, the adapter's levels and
names for the current model) and answers with `{ type: 'effort', effort }`,
which the bridge accepts only for an offered level. The composer's menu is
hidden when the adapter has no effort option.

## Under `tui`

Each tool's reporter sets the pane option `@yaac-effort`, read through the
same filtered subscription as `@yaac-model` and `@yaac-permission-mode`
(docs/workspace-storage.md):

- **claude**: hook payloads carry `effort.level`; `yaac-agent-report` reads
  it on `UserPromptSubmit` and `Stop`, so an `/effort` is seen at the next
  prompt or turn end.
- **codex**: the rollout's `turn_context.effort` (`reasoning_effort` in a
  settings change), read with the posture in the same pass and under the
  same current-life rule.
- **opencode**: the plugin reports the model's `variant` (`default` when it
  names none) with the model.
- **pi**: the extension reports `getThinkingLevel()` with the model and each
  `thinking_level_select`.

Anything in the workspace can set a pane option, so a reported level that
is not one word, or not one the agent's model has, is dropped (`default` is
kept: claude's ACP adapter offers it). The registry records a change as
`effort-changed` on the workspace row, which a restart relaunches at.
