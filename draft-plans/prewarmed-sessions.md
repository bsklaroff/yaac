# Plan: Prewarmed Sessions

## Context

Creating a new yaac session is slow (git fetch, image build, worktree creation, container startup). We want the session monitor to keep a fresh, invisible container ready so that when `session stream` needs a new session, it can claim the prewarmed one instantly instead of creating from scratch.

Prewarmed sessions are completely invisible: they don't show up in `session list`, can't be attached/shelled/deleted via normal commands, and `session stream` only claims them (not cycles through them). The monitor validates freshness each cycle and updates a timestamp; `session stream` only claims a prewarmed session if it was validated within the last 10 seconds.

## Data Model

Store prewarmed session state in `~/.yaac/prewarmed.json`:
```json
{
  "project-slug": {
    "sessionId": "uuid",
    "containerName": "yaac-slug-uuid",
    "fingerprint": "abc123...",
    "freshAt": 1713020000000
  }
}
```

This is a single file mapping project slugs to prewarmed session info. Using a file (not container labels) because:
- Podman labels are immutable after creation — can't remove `prewarmed` label when claiming
- "Claiming" = just delete the entry from the JSON, and the session instantly becomes a normal visible session
- Easy to check `freshAt` timestamp

## Changes

### 1. Add `getRemoteHeadCommit()` to `src/lib/git.ts`

```typescript
export async function getRemoteHeadCommit(repoPath: string): Promise<string> {
  const defaultBranch = await getDefaultBranch(repoPath)
  return (await simpleGit(repoPath).revparse([`origin/${defaultBranch}`])).trim()
}
```

### 2. Refactor `sessionCreate` in `src/commands/session-create.ts`

- Add to `SessionCreateOptions`: `noAttach?: boolean`, `extraLabels?: Record<string, string>`
- Change return type to `Promise<string | undefined>` (returns sessionId on success, undefined on error)
- Merge `options.extraLabels` into container `Labels` at line ~171
- When `noAttach` is true and no git user config: fail with error instead of interactive prompt
- Guard tmux attach (lines 269-275) with `if (!options.noAttach)`
- Guard post-attach cleanup (lines 278-281) with `if (!options.noAttach)`
- Return `sessionId`

### 3. Create `src/lib/prewarm.ts` (new file)

**Data helpers:**
- `getPrewarmedData(): Promise<Record<string, PrewarmedInfo>>` — reads `~/.yaac/prewarmed.json`, returns `{}` if missing
- `getPrewarmedSessionIds(): Promise<Set<string>>` — returns set of all prewarmed session IDs (used for filtering)
- `getPrewarmedSession(projectSlug): Promise<PrewarmedInfo | undefined>` — returns info for one project
- `setPrewarmedSession(projectSlug, info): Promise<void>` — updates the JSON file
- `clearPrewarmedSession(projectSlug): Promise<void>` — removes entry (used when "claiming")

**Fingerprinting:**
- `computeFreshnessFingerprint(projectSlug, config): Promise<string>` — calls `ensureImage()` to get image tag + `getRemoteHeadCommit()` to get git state, returns SHA-256 hash of both (16 hex chars)

**Main cycle function:**
- `ensurePrewarmedSession(projectSlug): Promise<void>` — called by monitor each cycle:
  1. Fetch origin
  2. Resolve config, compute fingerprint
  3. Check existing prewarmed session:
     - If fingerprint matches + container running + tmux alive: just update `freshAt` timestamp
     - If stale/dead: clean up old session via `cleanupSession()`, remove from prewarmed.json
  4. If no fresh prewarmed session: create one via `sessionCreate(slug, { noAttach: true })`, write to prewarmed.json

**Claim function:**
- `claimPrewarmedSession(projectSlug): Promise<{containerName, sessionId} | undefined>` — used by session stream:
  1. Read prewarmed.json entry for project
  2. Check `Date.now() - freshAt < 10_000` (fresh within 10 seconds)
  3. Verify container is still running + tmux alive
  4. If valid: clear entry from prewarmed.json, return session info
  5. Otherwise: return undefined

### 4. Filter prewarmed sessions from all listing/resolution

**`src/lib/container-resolve.ts`:**
- Import `getPrewarmedSessionIds` from prewarm
- In `resolveContainer()` and `resolveContainerAnyState()`: load prewarmed IDs, modify `findMatch` to skip containers whose `yaac.session-id` is in the set
- Approach: pass `excludeSessionIds: Set<string>` to `findMatch`, add check at top of the find callback

**`src/commands/session-list.ts`:**
- Import `getPrewarmedSessionIds` from prewarm
- Load prewarmed IDs at start of `sessionList()`
- Skip containers whose sessionId is in the prewarmed set (in the iteration loop at line ~38)

**`src/commands/session-stream.ts` (`getWaitingSessions`):**
- Import `getPrewarmedSessionIds` from prewarm
- Load prewarmed IDs at start
- Skip containers whose sessionId is in the prewarmed set (in the for loop at line ~37)

### 5. Modify `sessionStream` to claim prewarmed sessions

In `src/commands/session-stream.ts`, at lines 106-114 where it currently creates a new session when none are available:

```typescript
// Before creating a new session, try to claim a prewarmed one
if (project) {
  const claimed = await claimPrewarmedSession(project)
  if (claimed) {
    console.log(`Attaching to prewarmed session ${claimed.sessionId.slice(0, 8)}...`)
    try {
      execSync(`podman exec -it ${claimed.containerName} tmux attach-session -t yaac`, {
        stdio: 'inherit',
      })
    } catch { /* container/tmux killed */ }
    visited.add(claimed.sessionId)
    lastVisited = claimed.sessionId
    if (!isTmuxSessionAlive(claimed.containerName)) {
      cleanupSessionDetached({
        containerName: claimed.containerName,
        projectSlug: project,
        sessionId: claimed.sessionId,
      })
    }
    continue
  }
  // Fall through to create new session if no prewarmed available
  console.log(`No waiting sessions. Creating a new session for "${project}"...`)
  await sessionCreate(project, {})
  continue
}
```

### 6. Modify session monitor in `src/commands/session-monitor.ts`

- Import `ensurePrewarmedSession`
- After `sessionList()` call, if projectSlug provided:
  ```typescript
  try {
    await ensurePrewarmedSession(projectSlug)
  } catch (err) {
    console.error(`Prewarm: ${err instanceof Error ? err.message : err}`)
  }
  ```

### 7. Wire CLI option in `src/index.ts`

Add `--no-prewarm` to session monitor command. Pass to monitor options.

## Files Modified

| File | Change |
|------|--------|
| `src/lib/git.ts` | Add `getRemoteHeadCommit()` |
| `src/commands/session-create.ts` | Add `noAttach`, `extraLabels` options; return sessionId |
| `src/lib/prewarm.ts` | **New file** — prewarmed session management |
| `src/lib/container-resolve.ts` | Filter prewarmed sessions from `findMatch` |
| `src/commands/session-list.ts` | Filter prewarmed sessions from display |
| `src/commands/session-stream.ts` | Filter prewarmed from `getWaitingSessions`; claim prewarmed in `sessionStream` |
| `src/commands/session-monitor.ts` | Call `ensurePrewarmedSession` each cycle |
| `src/index.ts` | Add `--no-prewarm` CLI option |

## Tests

| Test File | What to Test |
|-----------|-------------|
| `test/unit/prewarm.test.ts` (new) | Fingerprint computation, freshness check, claim logic, stale cleanup |
| `test/unit/git.test.ts` (update) | `getRemoteHeadCommit` |
| `test/unit/session-stream.test.ts` (update) | Prewarmed sessions excluded from `getWaitingSessions`; claiming in `sessionStream` |
| `test/unit/session-list.test.ts` (update if exists) | Prewarmed sessions excluded from list |
| `test/unit/container-resolve.test.ts` (update if exists) | Prewarmed sessions excluded from resolution |
| `test/unit/session-monitor.test.ts` (update) | `ensurePrewarmedSession` called each cycle |

## Verification

1. `pnpm lint` — type checking + eslint
2. `pnpm vitest run` — all unit tests pass
3. Manual: `yaac session monitor <project>` creates a prewarmed container (visible in `podman ps` but not in `yaac session list`)
4. Manual: `yaac session stream <project>` claims the prewarmed session instantly when no other sessions are available
5. Manual: `yaac session attach <prewarmed-id>` rejects with "not found"
