/**
 * Patches claude-agent-acp (the pinned release, see `ACP_ADAPTERS.claude`).
 *
 *   node claude-agent-acp.js <claude-agent-acp>/dist/idle-compaction.js
 *
 * Run by `dockerfiles/Dockerfile.tools` and by the containerless driver's
 * install, right after npm installs the adapter. A release the edits no
 * longer fit fails the install (`applyEdits`). Bump the patch's `revision`
 * in `@yaac/shared/tool-install` whenever its edits change.
 *
 * The adapter compacts a session shortly before its one-hour prompt cache
 * expires (`IdleCompaction`). It reads whether to from claude's settings
 * files, which a project's sessions all share, so no one session can be
 * told apart. yaac makes it a per-session option (docs/sessions.md, "Agent
 * options"), and the server sets it on the session's tmux window as
 * `@yaac-idle-compaction`. The patch makes the adapter's own off switch
 * (`disabledBy`) also ask that window option, every time it is consulted,
 * so a change takes effect at the next idle without a restart. Anything but
 * `on`, including no tmux, is off.
 *
 * Goes once the adapter takes idle compaction per session from its client.
 */

import { applyEdits, patchFileFromArgv } from './apply-edits.js'

/** Each edit: an exact anchor in the adapter's dist, and its replacement. */
const EDITS = [
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
]

/** The patched source; see `applyEdits`. */
export function patchClaudeAgentAcp(source) {
  return applyEdits(source, 'claude-agent-acp', EDITS)
}

patchFileFromArgv(import.meta.url, patchClaudeAgentAcp)
