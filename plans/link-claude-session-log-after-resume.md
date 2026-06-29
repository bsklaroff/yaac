# Link Claude session log to YAAC session after `resume`

## Context

When a user runs `claude resume` (or any command that starts a *different*
Claude Code session) from inside a running YAAC session, the new Claude session
writes its JSONL at `~/.claude/projects/-workspace/{resumed-claude-id}.jsonl`
instead of `{yaac-session-id}.jsonl`. YAAC has no way to find that log, so
`finalize-attached-session` cannot read the first message, and deleted-session
scans miss the orphaned file.

The root cause is that YAAC currently identifies the Claude transcript by
pinning the Claude session id to the YAAC session id via the `--session-id`
CLI flag (`src/daemon/session-create.ts:175`, inside `buildAgentCmd`). That pin
only applies to the *initial* launch; nested `claude resume`, `/clear`,
`/compact`, or `claude` invocations pick their own id and produce an orphaned
JSONL. (Note `buildAgentCmd` already branches to `--resume ${sessionId}` for
YAAC's *own* resume path; the case that breaks is a user invoking
`claude resume`/`/clear`/`/compact` *inside* the session, which never touches
that flag.)

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
`<claudeDir>/settings.json` with `"matcher": "*"` to match all four sources in
a single entry. **Confirm the schema before implementing:** Claude Code
registers hooks inside `settings.json` under a `hooks.SessionStart[]` array
(`matcher` + `hooks[{type,command}]`), whereas Codex uses a *separate*
`hooks.json` file (see `ensureCodexHooksJson`,
`src/lib/session/codex-hooks.ts:27`). The per-entry shape is the same; the
containing file and top-level key differ. Verify against the docs above that
Claude reads `SessionStart` hooks from `settings.json` (not a standalone
`hooks.json`) before mirroring the merge logic.

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
`ensureCodexHooksJson` (`src/lib/session/codex-hooks.ts:27`): read-or-init the
file, ensure `hooks.SessionStart` exists, push our entry only if absent (idempotent),
write back. The difference is the target file (`settings.json`, which already
exists and is seeded by `seedClaudeSettings` at
`src/daemon/session-create.ts:228`) rather than a dedicated `hooks.json`, so
the merge must preserve the existing `settings.json` keys
(e.g. `skipDangerousModePermissionPrompt`) rather than starting fresh.

### 2. Write the hook script + wire it up unconditionally
`src/daemon/session-create.ts`:
- Generalize the existing Codex hook-script authoring block
  (`src/daemon/session-create.ts:996-1023`, currently gated on
  `tool === 'codex'`) so the hook script is also written for Claude sessions.
  The hook script shape is identical for Claude and Codex — both receive JSON
  on stdin with a `transcript_path` field, extract it (the current script uses
  a `sed` capture), compute a relative path via `python3 os.path.relpath`, and
  `ln -sf` it into `.yaac-transcripts/$YAAC_SESSION_ID.jsonl`. Preserve that
  exact shape; only parameterize `LINK_DIR`.
- Install the hook script into `<claudeDir>/.yaac-hook.sh` *and*
  `<codexDir>/.yaac-hook.sh` (they have different mount points in the
  container: `/home/yaac/.claude/.yaac-hook.sh` vs
  `/home/yaac/.codex/.yaac-hook.sh`), with each script writing to its own
  `.yaac-transcripts/` dir (`LINK_DIR=/home/yaac/.claude/.yaac-transcripts`
  vs `/home/yaac/.codex/.yaac-transcripts`). Also `mkdir -p` the Claude
  transcript dir up front, the way the Codex branch does at
  `src/daemon/session-create.ts:998-999`.
- Always call `ensureClaudeSettingsJson(claudeDir)` for Claude sessions
  (alongside the existing `seedClaudeSettings` call at
  `src/daemon/session-create.ts:994`); keep the existing Codex wiring
  (`ensureCodexHooksJson`/`ensureCodexConfigToml`) gated on `tool === 'codex'`.
- Keep the `--session-id ${sessionId}` argument in `buildAgentCmd`
  (`src/daemon/session-create.ts:175`) — the hook is the canonical mapping,
  but the pin keeps the default-case filename aligned with the YAAC id.

### 3. Path helpers
`src/lib/project/paths.ts` — add `claudeTranscriptDir(slug)` and
`claudeTranscriptFile(slug, sessionId)` (symmetric with
`codexTranscriptDir`/`codexTranscriptFile` at
`src/lib/project/paths.ts:107-113`). Both return
`<claudeDir>/.yaac-transcripts/...`.

### 4. First-message reader
`src/lib/session/claude-status.ts` — redirect **only** `getSessionFirstUserMessage`
(`src/lib/session/claude-status.ts:187`), which currently hard-codes
`path.join(claudeDir(slug), 'projects', '-workspace', ${sessionId}.jsonl)`,
to `claudeTranscriptFile(slug, sessionId)` so it follows the symlink.
`getFirstUserMessage` opens by path, so the symlink resolves transparently —
no other logic changes.

**Status reader needs no change.** Claude session status is no longer derived
from the JSONL: `classifyClaudePane`/`getSessionClaudeStatus`
(`src/lib/session/claude-status.ts:60-159`) classify `running`/`waiting` from
the rendered tmux pane via `tmux capture-pane`, not the transcript. The only
JSONL hard-code remaining in this file is the first-message reader above.

### 5. Deleted-session discovery
`src/lib/session/list.ts:300-324` scans
`claudeDir(slug)/projects/-workspace/*.jsonl` and treats each filename as a
session id. After the change, JSONL filenames are Claude's internal ids, not
YAAC ids. Replace that scan with a scan of `claudeTranscriptDir(slug)` (mirror
what `src/lib/session/list.ts:326-351` already does for Codex, including the
`lstat` on the symlink for birthtime).

## Files touched (summary)

| File | Change |
|------|--------|
| `src/daemon/session-create.ts` | Generalize hook-script authoring (`:996-1023`) + `ensureClaudeSettingsJson` for Claude (keep `--session-id` at `:175`) |
| `src/lib/session/claude-hooks.ts` | **New** — mirrors `codex-hooks.ts`, targets `settings.json` |
| `src/lib/project/paths.ts` | Add `claudeTranscriptDir`/`claudeTranscriptFile` (next to `:107-113`) |
| `src/lib/session/claude-status.ts` | `getSessionFirstUserMessage` (`:187`) reads through `.yaac-transcripts/` symlink |
| `src/lib/session/list.ts` | Deleted-session scan (`:300-324`) reads `claudeTranscriptDir(slug)` |
| `test/unit/...` | New tests for `ensureClaudeSettingsJson`, updated tests for path helpers and first-message reader |
| `test/e2e/...` | Resume scenario: create session, run `claude --resume <prior>` inside, assert prompt/first-message still resolve |

## Verification

1. `pnpm lint` clean.
2. Unit test for `ensureClaudeSettingsJson` merging into a pre-existing
   `settings.json` that already has unrelated keys
   (e.g. `skipDangerousModePermissionPrompt`) and/or unrelated hooks — assert
   the existing content survives and the entry is idempotent (mirrors the
   Codex test).
3. Unit test for `getSessionFirstUserMessage` pointed at a fixture where
   `.yaac-transcripts/<id>.jsonl` is a symlink to a differently-named JSONL.
4. E2E: `yaac session create <proj>`; inside the tmux, create a prompt so a
   JSONL exists, `/exit`, then `yaac session create <proj>` and
   `claude --resume` to the prior Claude session. Confirm
   `<claudeDir>/.yaac-transcripts/<newYaacId>.jsonl` symlink exists and points
   to the resumed transcript, and the new YAAC session's first message
   resolves to the resumed conversation's first user message.

## Rollout / back-compat

Pre-existing sessions (created before this change) have no
`.yaac-transcripts/` symlink. `getSessionFirstUserMessage` in
`src/lib/session/claude-status.ts` should fall back to
`<projects/-workspace>/{sessionId}.jsonl` when the symlink is missing — this
keeps old sessions' prompts readable until they exit. The fallback should be
removed in a later release once no long-lived pre-upgrade sessions remain.

Note: because we keep `--session-id`, new sessions that never hit
resume/clear/compact will *also* have a valid `{sessionId}.jsonl`. The symlink
still wins when present, but the fallback is effectively harmless.
