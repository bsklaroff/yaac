/**
 * Patches pi-acp (the pinned release, see `ACP_ADAPTERS.pi`) to support the
 * `_session/steering` extension claude's and codex's adapters implement, so
 * a message sent mid-turn joins the running turn as Enter does in pi's TUI
 * (docs/agent-modes.md, "Sending mid-turn").
 *
 *   node pi-acp.js <pi-acp>/dist/index.js
 *
 * Run by `dockerfiles/Dockerfile.tools` and by the containerless driver's
 * install, right after npm installs pi-acp. The edit is made by anchored
 * string replacement; an anchor that is missing or not unique fails the
 * install, so a pi-acp bump cannot silently drop the patch.
 *
 * The shape follows svkozak/pi-acp#115 (unmerged): advertise
 * `_meta.steering.supported`, answer `injected` by sending pi's `steer` RPC
 * while a turn runs, and `promptRequired` when idle if the client opted in.
 * Two fixes on top of it:
 *
 *  - A turn stops taking steers when pi reports `agent_settled`, not when
 *    pi-acp later resolves the prompt, which it does only after fetching
 *    usage stats.
 *  - pi awaits its extensions between its last queue check and emitting
 *    `agent_settled`, so a steer landing there is accepted but never
 *    delivered. On settle, `clear_queue` recovers any such message and the
 *    same turn continues with it, so the steer still answers `injected`
 *    truthfully and the turn's `session/prompt` reply comes after it.
 *
 * Delete this file, its callers, and pi's `steers: true` dependency on it
 * once a pi-acp release implements `_session/steering`.
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Marks a patched file, so a second run is a no-op. */
const MARKER = '/* yaac: _session/steering patch */'

/** Each edit: an exact anchor in pi-acp's bundled dist, and its replacement. */
const EDITS = [
  {
    name: 'pi RPC steer and clear_queue',
    anchor: `  async abort() {
    const res = await this.request({ type: "abort" });
    if (!res.success) throw new Error(\`pi abort failed: \${res.error ?? JSON.stringify(res.data)}\`);
  }
`,
    insert: 'after',
    text: `  async steer(message, images = []) {
    const res = await this.request({ type: "steer", message, images });
    if (!res.success) throw new Error(\`pi steer failed: \${res.error ?? JSON.stringify(res.data)}\`);
  }
  async clearQueue() {
    const res = await this.request({ type: "clear_queue" });
    if (!res.success) throw new Error(\`pi clear_queue failed: \${res.error ?? JSON.stringify(res.data)}\`);
    return res.data;
  }
`,
  },
  {
    name: 'session steering state',
    anchor: `  // Current in-flight turn (if any). Additional prompts are queued.
  pendingTurn = null;
`,
    insert: 'after',
    text: `  // Whether the running turn still takes steers: false from agent_settled.
  steerable = false;
  // Steers sent during the running turn, for recovering undelivered ones.
  steeredThisTurn = [];
`,
  },
  {
    name: 'turn start opens steering',
    anchor: `    this.pendingTurn = { resolve: t.resolve, reject: t.reject };
`,
    insert: 'after',
    text: `    this.steerable = true;
    this.steeredThisTurn = [];
`,
  },
  {
    name: 'failed turn closes steering',
    anchor: `    this.proc.prompt(t.message, t.images).catch((err) => {
`,
    insert: 'after',
    text: `      this.steerable = false;
`,
  },
  {
    name: 'steer and recovery methods',
    anchor: `  handlePiEvent(ev) {
`,
    insert: 'before',
    text: `  async steer(message, images) {
    if (!this.pendingTurn || !this.steerable) return false;
    this.steeredThisTurn.push({ message, images });
    await this.proc.steer(message, images);
    return true;
  }
  async continueWithStrandedSteers() {
    const sent = this.steeredThisTurn;
    this.steeredThisTurn = [];
    if (sent.length === 0 || !this.pendingTurn) return false;
    let stranded;
    try {
      stranded = (await this.proc.clearQueue())?.steering ?? [];
    } catch {
      return false;
    }
    if (stranded.length === 0 || this.cancelRequested) return false;
    const images = sent.filter((s) => stranded.includes(s.message)).flatMap((s) => s.images);
    this.startTurn({ message: stranded.join("\\n\\n"), images, ...this.pendingTurn });
    return true;
  }
`,
  },
  {
    name: 'settle closes steering and recovers stranded steers',
    anchor: `      case "agent_settled": {
        void this.settleTurn();
`,
    insert: 'replace',
    text: `      case "agent_settled": {
        this.steerable = false;
        void this.continueWithStrandedSteers().then((continued) => continued || this.settleTurn());
`,
  },
  {
    name: '_session/steering request',
    anchor: `  async initialize(params) {
    const supportedVersion = 1;
`,
    insert: 'before',
    text: `  async extMethod(method, params) {
    if (method !== "_session/steering") throw RequestError3.methodNotFound(method);
    const sessionId = params?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      throw RequestError3.invalidParams(void 0, "_session/steering requires a sessionId");
    }
    const prompt = Array.isArray(params.prompt) ? params.prompt : [];
    const session = await this.restoreSession(sessionId);
    const { message, images } = promptToPiMessage(prompt);
    if (await session.steer(message, images)) return { outcome: "injected" };
    if (params._meta?.steering?.idleBehavior === "promptRequired") {
      return { outcome: "promptRequired", reason: "noRunningTurn" };
    }
    this.prompt({ sessionId, prompt }).catch(() => {});
    return { outcome: "startedNewTurn" };
  }
`,
  },
  {
    name: 'advertise steering',
    anchor: `      protocolVersion: requested === supportedVersion ? requested : supportedVersion,
`,
    insert: 'after',
    text: `      _meta: { steering: { supported: true } },
`,
  },
]

/** The patched source. Throws naming the first edit whose anchor is missing
 *  or appears more than once. */
export function patchPiAcp(source) {
  if (source.includes(MARKER)) return source
  let out = source
  for (const { name, anchor, insert, text } of EDITS) {
    const at = out.indexOf(anchor)
    if (at === -1 || out.indexOf(anchor, at + 1) !== -1) {
      throw new Error(`pi-acp patch: the anchor for "${name}" is ${at === -1 ? 'missing' : 'not unique'}`)
    }
    const replacement = insert === 'after' ? anchor + text : insert === 'before' ? text + anchor : text
    out = out.slice(0, at) + replacement + out.slice(at + anchor.length)
  }
  // After the shebang, which must stay the first line.
  const nl = out.indexOf('\n') + 1
  return `${out.slice(0, nl)}${MARKER}\n${out.slice(nl)}`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2]
  if (file === undefined) {
    console.error('usage: node pi-acp.js <pi-acp>/dist/index.js')
    process.exit(2)
  }
  try {
    fs.writeFileSync(file, patchPiAcp(fs.readFileSync(file, 'utf8')))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
