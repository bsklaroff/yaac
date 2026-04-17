# Link Claude session log to YAAC session after `resume`

## Context

When a user runs `claude resume` (or any command that starts a *different*
Claude Code session) from inside a running YAAC session, the new Claude session
writes its JSONL at `~/.claude/projects/-workspace/{resumed-claude-id}.jsonl`
instead of `{yaac-session-id}.jsonl`. YAAC has no way to find that log, so
`yaac session list` shows stale/wrong `status` and `prompt` for the session,
`finalize-attached-session` cannot read the first message, and deleted-session
scans miss the orphaned file.

The root cause is that YAAC currently identifies the Claude transcript by
pinning the Claude session id to the YAAC session id via the `--session-id`
CLI flag (`src/commands/session-create.ts:43`). That pin only applies to the
*initial* launch; nested `claude resume`, `/clear`, `/compact`, or `claude`
invocations pick their own id and produce an orphaned JSONL.

Codex already solved the analogous problem with a `SessionStart` hook that
symlinks the current transcript into `.yaac-transcripts/{sessionId}.jsonl`.
We should unify Claude onto the same pattern.

## Approach

Add a Claude Code `SessionStart` hook (exactly mirroring the existing Codex
hook) that maintains a stable symlink
`<claudeDir>/.yaac-transcripts/{yaacSessionId}.jsonl` pointing at whichever
JSONL Claude is currently writing. All YAAC readers resolve the transcript
through this symlink, so the on-disk Claude session id becomes an
implementation detail.

Claude Code's `SessionStart` hook fires on `startup`, `resume`, `clear`, and
`compact` (verified via
<https://code.claude.com/docs/en/hooks.md>). The payload on stdin includes
`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `source`, and
`model`. For `/clear` and `/compact` Claude keeps writing to the same file,
so the hook update is a no-op; for `resume` (i.e. loading a *different* past
conversation, which is the case that breaks YAAC today) the
`transcript_path` points at that conversation's JSONL, and updating the
symlink repoints YAAC at it automatically.

Hook registration uses the standard `hooks` section of
`~/.claude/settings.json` with `"matcher": "*"` to match all four sources in
a single entry (same shape Codex already uses in `hooks.json`).

**Keep the `--session-id` pin.** On the initial launch it makes
`projects/-workspace/{yaacId}.jsonl` and the symlink
`.yaac-transcripts/{yaacId}.jsonl` share the same id, which keeps file layout
easy to read by hand and preserves the current one-to-one mapping in the
common (no-resume) case. The hook is the mechanism; the pin is a convenience
that happens to agree with the hook in the default case.

## Changes

### 1. Install a Claude SessionStart hook (new file)
`src/lib/session/claude-hooks.ts` — mirror of `src/lib/session/codex-hooks.ts`.
Exports `ensureClaudeSettingsJson(claudePath)` that merges a `SessionStart`
hook entry into `<claudePath>/settings.json` pointing at
`/home/yaac/.claude/.yaac-hook.sh`. The merge logic is identical in shape to
`ensureCodexHooksJson` (`src/lib/session/codex-hooks.ts:27`), since Claude
Code's settings.json `hooks` section uses the same
`matcher` + `hooks[{type,command}]` schema as Codex's `hooks.json`.

### 2. Write the hook script + wire it up unconditionally
`src/commands/session-create.ts`:
- Move the existing hook-script authoring out of the `tool === 'codex'` branch
  (lines 475–502) into an unconditional block. The hook script shape is
  identical for Claude and Codex — both receive JSON on stdin with a
  `transcript_path` field, and both need a symlink keyed by `YAAC_SESSION_ID`.
- Install the hook script into `<claudeDir>/.yaac-hook.sh` *and*
  `<codexDir>/.yaac-hook.sh` (they have different mount points in the
  container: `/home/yaac/.claude/.yaac-hook.sh` vs
  `/home/yaac/.codex/.yaac-hook.sh`), with each script writing to its own
  `.yaac-transcripts/` dir.
- Always call `ensureClaudeSettingsJson(claudeDir)`; keep the existing Codex
  wiring gated on `tool === 'codex'` (since only Codex sessions use it).
- Keep the `--session-id ${sessionId}` argument in `buildAgentCmd`
  (`src/commands/session-create.ts:43`) — the hook is the canonical mapping,
  but the pin keeps the default-case filename aligned with the YAAC id.

### 3. Path helpers
`src/lib/project/paths.ts` — add `claudeTranscriptDir(slug)` and
`claudeTranscriptFile(slug, sessionId)` (symmetric with
`codexTranscriptDir`/`codexTranscriptFile` at lines 66–72). Both return
`<claudeDir>/.yaac-transcripts/...`.

### 4. Status & first-message readers
`src/lib/session/claude-status.ts` lines 238–241 and 268–271 currently
hard-code `path.join(claudeDir(slug), 'projects', '-workspace',
${sessionId}.jsonl)`. Replace both with `claudeTranscriptFile(slug, sessionId)`
so they follow the symlink. `getClaudeStatus`/`getFirstUserMessage` open by
path, so the symlink resolves transparently — no other logic changes.

### 5. Deleted-session discovery
`src/commands/session-list.ts` lines 193–213 scan
`~/.yaac/projects/{slug}/claude/projects/-workspace/*.jsonl` and treat each
filename as a session id. After the change, JSONL filenames are Claude's
internal ids, not YAAC ids. Replace that scan with a scan of
`claudeTranscriptDir(slug)` (matches what lines 214–233 already do for Codex).

## Files touched (summary)

| File | Change |
|------|--------|
| `src/commands/session-create.ts` | Install Claude hook + settings.json unconditionally (keep `--session-id`) |
| `src/lib/session/claude-hooks.ts` | **New** — mirrors `codex-hooks.ts` |
| `src/lib/project/paths.ts` | Add `claudeTranscriptDir`/`claudeTranscriptFile` |
| `src/lib/session/claude-status.ts` | Read through `.yaac-transcripts/` symlink |
| `src/commands/session-list.ts` | Deleted-session scan reads `.yaac-transcripts/` |
| `test/unit/...` | New tests for `ensureClaudeSettingsJson`, updated tests for path helpers and status readers |
| `test/e2e/...` | Resume scenario: create session, run `claude --resume <prior>` inside, assert status/prompt still resolve |

## Verification

1. `pnpm lint` clean.
2. Unit test for `ensureClaudeSettingsJson` merging with a pre-existing
   settings.json that has unrelated hooks (mirrors the Codex test).
3. Unit tests for status/first-message readers pointed at a fixture where
   `.yaac-transcripts/<id>.jsonl` is a symlink to a differently-named JSONL.
4. E2E: `yaac session create <proj>`; inside the tmux, create a prompt so a
   JSONL exists, `/exit`, then `yaac session create <proj>` and
   `claude --resume` to the prior Claude session. Confirm
   `<claudeDir>/.yaac-transcripts/<newYaacId>.jsonl` symlink exists and points
   to the resumed transcript, and `yaac session list` shows the correct
   `prompt` and `waiting` status for the new YAAC session.

## Rollout / back-compat

Pre-existing sessions (created before this change) have no
`.yaac-transcripts/` symlink. The status + first-message readers in
`src/lib/session/claude-status.ts` should fall back to
`<projects/-workspace>/{sessionId}.jsonl` when the symlink is missing — this
keeps old sessions observable in `yaac session list` until they exit. The
fallback should be removed in a later release once no long-lived pre-upgrade
sessions remain.

Note: because we keep `--session-id`, new sessions that never hit
resume/clear/compact will *also* have a valid `{sessionId}.jsonl`. The symlink
still wins when present, but the fallback is effectively harmless.
