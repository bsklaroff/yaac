/**
 * Patches pi-acp (the pinned release, see `ACP_ADAPTERS.pi`).
 *
 *   node pi-acp.js <pi-acp>/dist/index.js
 *
 * Run by `dockerfiles/Dockerfile.tools` and by the containerless driver's
 * install, right after npm installs pi-acp. The edits are made by anchored
 * string replacement; an anchor that is missing or not unique fails the
 * install, so a pi-acp bump cannot silently drop the patch. Bump the
 * patch's `revision` in `@yaac/shared/tool-install` whenever this file
 * changes.
 *
 * Three changes, each deletable on its own once a pi-acp release makes it
 * unnecessary:
 *
 * 1. Steering. pi-acp gains the `_session/steering` extension claude's and
 *    codex's adapters implement, so a message sent mid-turn joins the running
 *    turn as Enter does in pi's TUI (docs/agent-modes.md, "Sending
 *    mid-turn"). The shape follows svkozak/pi-acp#115 (unmerged): advertise
 *    `_meta.steering.supported`, answer `injected` by sending pi's `steer`
 *    RPC while a turn runs, and `promptRequired` when idle if the client
 *    opted in. Two fixes on top of it:
 *
 *    - A turn stops taking steers when pi reports `agent_settled`, not when
 *      pi-acp later resolves the prompt, which it does only after fetching
 *      usage stats.
 *    - pi awaits its extensions between its last queue check and emitting
 *      `agent_settled`, so a steer landing there is accepted but never
 *      delivered. On settle, `clear_queue` recovers any such message and the
 *      same turn continues with it, so the steer still answers `injected`
 *      truthfully and the turn's `session/prompt` reply comes after it.
 *
 *    Goes once a pi-acp release implements `_session/steering`, along with
 *    pi's `steers: true` dependency on it.
 *
 * 2. Bash output as appends (`bashOutputDelta` below). Goes once pi-acp's
 *    own `terminal_output` stays an append past pi's tail window.
 *
 * 3. Turns for extension commands and the runs extensions start. pi runs
 *    a prompt naming an extension's slash command without starting a run:
 *    it answers the `prompt` RPC with disposition `handled` and never
 *    reports `agent_settled`, the event pi-acp ends a turn on. So a turn
 *    ends on `handled` unless pi already reported `agent_start` for it, in
 *    which case that run's `agent_settled` ends it. A command can also start
 *    a run after pi answers (`sendUserMessage`, or any async hook before the
 *    run), and an extension can start one at any time. pi gives no notice
 *    of such a run before its `agent_start`, so pi-acp adopts it then as a
 *    turn of its own, with no `session/prompt` to answer: it reports the
 *    run as running, prompts queue behind it, and its `agent_settled` ends
 *    it rather than some other turn. A prompt sent between `handled` and a
 *    late run's `agent_start` still reaches pi, where it races that run.
 *    Goes once pi-acp reads the disposition and owns the runs it did not
 *    start.
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Marks a patched file, so a second run is a no-op. */
const MARKER = '/* yaac: pi-acp patch */'

/**
 * What a bash call's `terminal_output` carries: the text that follows
 * `previous` in `next`, two successive snapshots of its output. yaac appends
 * each one to the call's output (`AcpProjection`), so it must be only what is
 * new. A snapshot is the whole output until it passes pi's tail window
 * (2000 lines or 50KB); from then on each one is the latest window, which
 * starts later than the one before and drops the output's trailing newline.
 * pi-acp's own version sends such a window whole. This one compares both
 * snapshots without a trailing newline, so a line's newline is sent with the
 * text after it, finds the longest end of `previous` that `next` starts
 * with, and returns the rest of `next`. A window with no such overlap
 * follows more output than the window holds, so the lines between are lost;
 * it starts on a line of its own. Output that repeats one line can overlap
 * more than it really did, so a few new lines may go unshown; a resent
 * window would duplicate thousands.
 */
function bashOutputDelta(previous, next) {
  const trim = (text) => text.endsWith("\n") ? text.slice(0, -1) : text;
  const [before, after] = [trim(previous), trim(next)];
  let overlap = 0;
  for (let at = before.indexOf(after[0]); after !== "" && at !== -1; at = before.indexOf(after[0], at + 1)) {
    if (after.startsWith(before.slice(at))) {
      overlap = before.length - at;
      break;
    }
  }
  return overlap === 0 && before !== "" && after !== "" ? "\n" + after : after.slice(overlap);
}

/** Each edit: an exact anchor in pi-acp's bundled dist, and its replacement. */
const EDITS = [
  {
    name: 'pi RPC prompt returns its disposition',
    anchor: `    if (!res.success) throw new Error(\`pi prompt failed: \${res.error ?? JSON.stringify(res.data)}\`);
`,
    insert: 'after',
    text: `    return res.data?.disposition;
`,
  },
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
    name: 'session run and steering state',
    anchor: `  // Current in-flight turn (if any). Additional prompts are queued.
  pendingTurn = null;
`,
    insert: 'after',
    text: `  // Whether pi is in a run: from agent_start to agent_settled.
  piRunning = false;
  // Whether the running turn still takes steers: false from agent_settled.
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
    name: 'handled turn ends, failed turn closes steering',
    anchor: `    this.proc.prompt(t.message, t.images).catch((err) => {
`,
    insert: 'replace',
    text: `    const turn = this.pendingTurn;
    this.proc.prompt(t.message, t.images).then((disposition) => {
      if (disposition === "handled" && !turn.runSeen) void this.endTurn(turn);
    }, (err) => {
      this.steerable = false;
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
  async endTurn(turn = this.pendingTurn) {
    if (!turn || turn !== this.pendingTurn || turn.ending) return;
    turn.ending = true;
    this.steerable = false;
    if (!(await this.continueWithStrandedSteers())) await this.settleTurn();
  }
  adoptRun() {
    this.pendingTurn = { resolve() {}, reject() {}, runSeen: true };
    this.emit({
      sessionUpdate: "session_info_update",
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    });
  }
`,
  },
  {
    name: 'settle ends the turn',
    anchor: `      case "agent_settled": {
        void this.settleTurn();
`,
    insert: 'replace',
    text: `      case "agent_settled": {
        this.piRunning = false;
        void this.endTurn();
`,
  },
  {
    name: 'a run marks its turn, or is adopted as one',
    anchor: `      case "agent_start": {
        this.inAgentLoop = true;
`,
    insert: 'after',
    text: `        this.piRunning = true;
        if (this.pendingTurn) this.pendingTurn.runSeen = true;
        else this.adoptRun();
`,
  },
  {
    name: 'a run that starts while a turn ends is adopted',
    anchor: `    const next = this.turnQueue.shift();
`,
    insert: 'before',
    text: `    if (this.piRunning) return this.adoptRun();
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
  {
    name: 'bash output as appends',
    anchor: `function bashOutputDelta(previous, next) {
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}
`,
    insert: 'replace',
    text: `${bashOutputDelta}\n`,
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
