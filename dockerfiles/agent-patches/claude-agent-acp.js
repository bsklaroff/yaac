/**
 * Patches claude-agent-acp (the pinned release, see `ACP_ADAPTERS.claude`).
 *
 *   node claude-agent-acp.js <claude-agent-acp>/dist
 *
 * Run by `dockerfiles/Dockerfile.tools` and by the containerless driver's
 * install, right after npm installs the adapter. A release the edits no
 * longer fit fails the install (`applyEdits`). Bump the patch's `revision`
 * in `@yaac/shared/tool-install` whenever its edits change.
 *
 * Three files of it are edited.
 *
 * `idle-compaction.js`: the adapter compacts a session shortly before its
 * one-hour prompt cache expires (`IdleCompaction`). It reads whether to from
 * claude's settings files, which a project's sessions all share, so no one
 * session can be told apart. yaac makes it a per-session option
 * (docs/sessions.md, "Agent options"), and the server sets it on the
 * session's tmux window as `@yaac-idle-compaction`. The patch makes the
 * adapter's own off switch (`disabledBy`) also ask that window option, every
 * time it is consulted, so a change takes effect at the next idle without a
 * restart. Anything but `on`, including no tmux, is off.
 *
 * Goes once the adapter takes idle compaction per session from its client.
 *
 * `auth-status-reporter.js`: the adapter tells its client which login it
 * runs on, and to learn the plan tier it runs `claude auth status --json`
 * when a session is created and again at the start of every prompt. That
 * starts the whole claude binary a second time beside the one doing the
 * work, which under gVisor costs about half a second of CPU each time and
 * lengthens `session/new`. yaac shows a login's state from its own store
 * and reads none of these reports, so the patch makes the probe answer what
 * the adapter already knows (the session's own account) without running
 * anything.
 *
 * Goes once the adapter probes only for a client that asks for the status.
 *
 * `v1/acp-agent.js`: `session/new` starts every session in the mode the
 * tool's settings give it, and a client that wants another must follow with
 * `session/set_mode`, a round trip before the first prompt. The adapter
 * already takes a starting mode when it creates a session for other reasons
 * (`creationOpts.permissionMode`, checked as `set_mode`'s is), so the patch
 * hands it the one a client names in `session/new`'s
 * `_meta.claudeCode.options.permissionMode`, where the server sends a
 * session's posture (docs/permission-modes.md).
 *
 * Goes once `session/new` takes a starting mode.
 */

import { applyEdits, patchFileFromArgv } from './apply-edits.js'

/** Each patched file of the adapter's `dist/`, with its edits: an exact
 *  anchor and what replaces it or goes beside it. */
const EDITS = {
  'idle-compaction.js': [
    {
      name: 'read the session window option',
      anchor: `export class IdleCompaction {
`,
      insert: 'before',
      text: `import { execFileSync } from "node:child_process";
/** yaac: the session's \`@yaac-idle-compaction\` window option, or "" outside tmux. */
function yaacIdleCompaction() {
    try {
        return execFileSync("tmux", [
            "-S", (process.env.TMUX ?? "").split(",")[0], "show-options", "-wqv",
            "-t", process.env.TMUX_PANE ?? "", "@yaac-idle-compaction",
        ], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    }
    catch {
        return "";
    }
}
`,
    },
    {
      name: 'off unless the session turned it on',
      anchor: `    disabledBy() {
`,
      insert: 'after',
      text: `        if (yaacIdleCompaction() !== "on")
            return "yaac session option";
`,
    },
  ],
  'auth-status-reporter.js': [
    {
      name: 'answer the probe without running claude',
      anchor: `    async runProbe() {
`,
      insert: 'after',
      text: `        return this.current;
`,
    },
  ],
  'v1/acp-agent.js': [
    {
      name: 'start the session in the mode session/new names',
      anchor: `            resume: params._meta?.claudeCode?.options?.resume,
`,
      insert: 'after',
      text: `            permissionMode: params._meta?.claudeCode?.options?.permissionMode,
`,
    },
  ],
}

/** The patched source of `file`, one of `EDITS`' names; see `applyEdits`. */
export function patchClaudeAgentAcp(source, file) {
  return applyEdits(source, 'claude-agent-acp', EDITS[file])
}

patchFileFromArgv(import.meta.url, patchClaudeAgentAcp, Object.keys(EDITS))
