# AskUserQuestion in `acp` mode

## Goal

Give a claude chat (`acp`) conversation the `AskUserQuestion` tool its TUI
already has. The agent asks one to four multiple-choice questions, the turn
blocks, the user answers in a form docked above the composer, and the answer
goes back into the turn.

The model has no such tool in `acp` today because claude's adapter
(`@agentclientprotocol/claude-agent-acp`, pinned as `ACP_ADAPTERS.claude`,
0.103.0) launches the CLI with `--disallowedTools=AskUserQuestion` unless the
client advertises `clientCapabilities.elicitation.form`
(`dist/v1/acp-agent.js`, `elicitationSupport` / `disallowedTools`), and
`clientCapabilities()` in `runtime/agents/acp-protocol.ts` advertises none.

## What the adapter does once `elicitation.form` is declared

Everything below was read from the adapter's `dist/elicitation.js` and
`dist/v1/acp-agent.js`, and from the ACP SDK it bundles (2.5.0,
`dist/v1/schema/types.gen.d.ts`).

**Three features turn on together.** The capability is one switch:

1. **AskUserQuestion.** The tool is no longer disallowed. The SDK routes it
   through `canUseTool`, which (`toolName === "AskUserQuestion"`) first
   emits the tool call (`ensureToolCallEmitted`), then calls
   `answerAskUserQuestion`.
2. **MCP form elicitations.** `onElicitation: handleMcpElicitation` is
   attached, so an MCP server's form request becomes an `elicitation/create`
   with no `toolCallId`. Without the capability the SDK declines them itself.
3. **The refusal-fallback consent dialog.** `onUserDialog` is attached with
   `supportedDialogKinds: ["refusal_fallback_prompt"]`, so when a model
   refuses and a fallback model exists the CLI asks "<model> declined this
   request. Retry with <fallback>?" as a form with one single-select field
   (`refusalFallbackToCreateRequest`). Without it the turn ends with the
   refusal.

`elicitation.url` is separate. It enables URL-mode MCP elicitations, the
`session/complete_elicitation` notification and MCP OAuth sign-in
(`reportMcpServerStartupFailures`, `oauthAvailable`). AskUserQuestion does
not need it.

**The request** (`askUserQuestionsToCreateRequest`):

```jsonc
{ "mode": "form", "sessionId": "...", "toolCallId": "<tool_use id>",
  "message": "<the question, or 'Please answer the following questions.'>",
  "requestedSchema": { "type": "object", "properties": {
    "question_0":        { "type": "string", "title": "<header>", "description": "<question; only when several>",
                           "oneOf": [{ "const": "<label>", "title": "<label>", "description": "<option text>",
                                       "_meta": { "_claude/askUserQuestionOption": { "preview": "..." } } }] },
    "question_0_custom": { "type": "string", "title": "Other", "description": "Type your own answer, or add a note ..." },
    "question_1":        { "type": "array", "title": "...", "description": "...", "items": { "anyOf": [ ... ] } },
    "question_1_custom": { "type": "string", "title": "Other", "description": "Type your own answer to add ..." } } } }
```

Nothing is `required`. An option's `const` is its label, since the label is
what the tool records. `_meta` on the `_custom` field is sent only to a
JetBrains AIR client, which claude is not told yaac is.

**The response** is ACP's `CreateElicitationResponse`:
`{ action: "accept", content?: { [key]: string | number | boolean | string[] } }`,
`{ action: "decline" }` or `{ action: "cancel" }`.
`applyAskElicitationResponse` folds it into the tool's input:

- *accept*: a single-select pick becomes `answers[question]`. Text in the
  `_custom` field is the answer when nothing was picked, and is attached as
  `annotations[question].notes` when something was. A multi-select's picks
  plus its custom text are comma-joined the CLI's way (`joinMultiSelectAnswer`
  JSON-quotes an item containing `", "`). A blank question gets no answer.
- *decline*: empty answers, so the model is told the user skipped. The
  `unanswered` annotations are added only if the CLI reported
  `ask_user_question_unanswered_v1`.
- *cancel*, or any unknown action: `throw new Error("Tool use aborted")`.
- A JSON-RPC error reply: the tool is denied with "Could not present the
  question to the user." (an MCP elicitation becomes `cancel`, the dialog
  `cancelled`).

**Withdrawal.** Every elicitation is sent with the callback's abort signal
plus the session's (`untilSessionClosed`), using `stopWaitingOnCancel`. When
it aborts (the turn is interrupted, the session closes), the SDK sends
`$/cancel_request { requestId }` and stops waiting. `elicitUnlessWithdrawn`
then treats the request as withdrawn, and a late reply is ignored.

**Steering.** While any permission request or elicitation is open
(`withPendingUserInput`), `_session/steering` delivers at priority `later`:
the message is queued in the SDK until the question settles, rather than
interrupting it. The steer reply is still `injected` straight away.

**Scope.** The request carries `sessionId` (the subagent's child session for
a native subagent, which yaac does not enable for claude) and the
AskUserQuestion `toolCallId`. The request-scoped variant (`requestId`
instead of `sessionId`) is never sent by this adapter.

## Decisions

- **Claude only, through its adapter profile.** codex-acp 2.6.0 also reads
  `elicitation.form`. It then sends `request_user_input` as form elicitations,
  turns async questions into non-blocking elicitations whose answers are
  steered in, and moves some MCP tool approvals from permission requests to
  elicitations (`ElicitationReporter`, `isMcpToolCallApproval`). Each of
  those needs its own look, so the declaration is a per-profile opt-in, not
  a change for every tool.
- **Form only; no `url`.** URL elicitations are MCP OAuth. The sign-in
  redirects to a loopback callback inside the workspace, which a browser
  cannot reach from a k8s pod. That needs a design of its own (open
  question 2).
- **One generic form renderer for every form elicitation**, with no
  AskUserQuestion-only path. The form covers ACP's property set (`string`
  with or without `oneOf`/`enum`, `number`, `integer`, `boolean`, `array` of
  `anyOf`/`enum` items). That renders the question form, the refusal dialog
  (one single-select field) and ordinary MCP forms, so all three features
  the capability turns on work. A request yaac cannot render (URL mode, a
  custom mode, a property type outside the set) is answered at once with
  JSON-RPC error `-32602`, which the adapter turns into a denial or cancel
  the user never sees, rather than a broken form.
- **AskUserQuestion's "Other" box is paired with its question** when its key
  is `<choiceKey>_custom`, the adapter's convention (`questionCustomFieldKey`).
  The pairing is a presentation hint added during parsing. If the adapter
  renames the key, the box renders as its own field, which still works.
- **Elicitations are never answered by the posture.** `bypass` auto-answers
  permission asks because they are consent prompts that isolation makes
  moot. A question asks for information only the user has, and claude's TUI
  asks it under every mode. The refusal dialog is consent to switch models,
  which bypass does not cover either.
- **The answer goes over the chat socket, not an HTTP route.** It travels
  like a permission answer: an `AcpClientMessage` on `/api/acp/attach`,
  which only a `control` pane may send (`attachAcp` drops it from
  `/acp/observe` readers). WebSocket routes are registered by
  `registerWebSocketRoutes` (in `main/server-run.ts`), not on the
  `buildApp` app that `assertMatrixCoversEveryRoute` enumerates. So there
  is no new route-matrix row. Both drivers get the feature unchanged, since
  everything here is in `#runtime/agents` above the driver seam, and
  containerless runs ACP under acpd the same way. If a CLI answer path is
  ever wanted (`yaac-mama answer`), that is an HTTP route and gets its row
  then.
- **A message sent while a question is open does not answer it.** That
  includes the pane's composer and `yaac-mama send`, both of which reach
  `AcpConversation.prompt` → `steer`. The adapter holds the steer until the
  question settles, so the message reaches claude after the answer. This
  matches permission asks. Making a send skip the question would mean yaac
  answering for the user (open question 1).

## Backend

### Protocol (`runtime/agents/acp-protocol.ts`)

- `ACP.elicitationCreate = 'elicitation/create'` and
  `ACP.cancelRequest = '$/cancel_request'`.
- `clientCapabilities(meta, { formElicitation })` adds
  `elicitation: { form: {} }` when asked. This is a top-level capability,
  not `_meta`, so it cannot ride `capabilitiesMeta`.
- `parseElicitationRequest(params)` → `{ toolCallId?, message, fields }` or
  undefined when unrenderable. It normalizes the schema into the shared
  `AcpFormField[]` below, in property order: titles, descriptions,
  `required`, `default`, bounds and `format` are kept, and the
  `_claude/askUserQuestionOption` preview is lifted onto its option. It is
  the only code that reads the ACP schema. The live client and the record
  projection both call it, so a pane and the parked request never disagree
  about what was asked.
- `elicitationReply(action, content?)` and `parseElicitationOutcome(result)`,
  the counterparts of `permissionReply` / `parsePermissionOutcome`.

### Wire types (`@yaac/shared/acp`)

```ts
interface AcpFormOption { value: string; label: string; description?: string; preview?: string }
type AcpFormField = { key: string; title?: string; description?: string; required?: true } & (
  | { kind: 'choice'; multi: boolean; options: AcpFormOption[]; other?: string /* the paired text field's key */ }
  | { kind: 'text'; format?: 'email' | 'uri' | 'date' | 'date-time'; minLength?: number; maxLength?: number; default?: string }
  | { kind: 'number'; integer: boolean; minimum?: number; maximum?: number; default?: number }
  | { kind: 'boolean'; default?: boolean })
type AcpFormValue = string | number | boolean | string[]
```

Events, beside `permission-request` / `permission-resolved`:

- `{ type: 'elicitation-request'; seq; thread?; requestId; toolCallId?; message; fields }`
- `{ type: 'elicitation-resolved'; seq; requestId; action: 'accept' | 'decline' | 'cancel' | 'withdrawn'; content? }`

Pane → server: `{ type: 'elicitation'; requestId; action: 'accept' | 'decline'; content? }`.
Cancel is not offered as an answer. Stop already cancels the turn, and the
server answers `cancel` then (below).

The status needs no new wire type. A question makes the conversation
`asking`, which `listedStatus` already sends as `waiting` + `asking: true`.
The sidebar, Home ("Waiting for your answer"), the chime and the dock badge
all follow it.

### The conversation (`runtime/agents/acp-client.ts`)

Questions reuse the permission-ask machinery rather than adding a second
copy. That machinery is the pending map, the answered set, the asks
recovered from the record, the held answers, the cancel-all and the
reconnect `respondTo`. It becomes kind-aware:

- `pendingPermissions` / `recoveredPermissions` become
  `pendingAsks` / `recoveredAsks`, each entry tagged `'permission' | 'elicitation'`.
  `isAwaitingPermission` becomes `isAwaitingUser`, which `status` already
  maps to `asking`.
- `onRequest` gains an `elicitation/create` branch. If
  `parseElicitationRequest` fails, it throws `JsonRpcCallError(-32602)`.
  Otherwise it parks the request with no timeout and does not wait for the
  posture recovery, which a question does not depend on.
- `answerElicitation(requestId, action, content)` checks the shape (a known
  action, `content` an object of `AcpFormValue`s) and then shares
  `settleAsk` with `answerPermission`. It does not check the content against
  the schema: the adapter tolerates any content, and an MCP server
  validates its own.
- `cancelPendingAsks` (Stop, agent exit, close) answers each ask by its
  kind: `{ outcome: { outcome: 'cancelled' } }` or `{ action: 'cancel' }`.
  As today, `close()` lets those replies land after `peer.close()`, so a
  detach never answers for the user, and the next connection recovers the
  ask from the record.
- **`$/cancel_request` is new handling, for both kinds.** yaac ignores it
  today (`acp-jsonrpc.ts` has no case for it), so a permission ask that
  claude withdraws leaves its card docked and the conversation `asking`
  until the turn ends. `onNotification` drops the named ask from
  `pendingAsks` / `recoveredAsks` (it settles the parked promise with a
  `-32800` error, which the SDK ignores), marks it answered and
  republishes status.
- `AcpSessionProfile.formElicitation?: true`, set on claude's profile in
  `acp-adapters.ts`, and passed to `clientCapabilities` in the handshake.
  It is not sent on a reattach, since `initialize` runs once per agent
  process. A conversation that started before the upgrade keeps running
  without the tool until its agent restarts. That is an ordinary restart,
  not something that needs a compatibility shim.

### The record (`runtime/agents/acp-log.ts`, `AcpProjection`)

acpd records both directions, so questions come back after a reconnect the
way permission asks do:

- An `elicitation/create` line projects to `elicitation-request`
  (`AcpProjection.openElicitation`). Its thread is `threadOf(params)`, else
  the thread of its tool call (`toolThreads`), as `openPermission` does. A
  request yaac refused (its reply is an `error`) projects to nothing.
- A reply line settles it (`closeElicitation`).
- A `$/cancel_request` line for an open ask closes it: `elicitation-resolved`
  with `withdrawn`, or `permission-resolved` with `cancelled`.
- `Pager`'s standing set carries an open question onto a new page, beside
  open permission asks.
- `recover()` returns `pendingAsks: Array<{ id: string | number; kind }>`
  (replacing `pendingPermissions`). An `elicitation/create` with no reply
  and no `$/cancel_request` is pending. An `_acpd/exit` clears them. A
  reattached conversation can then answer a question asked before the
  server restarted, against the agent's own request id.

### The bridge (`runtime/agents/acp-bridge.ts`)

`attachAcp` routes `{ type: 'elicitation' }` to
`conversation.answerElicitation` for a control pane only, and echoes
nothing. The recorded reply comes back through the tail as
`elicitation-resolved`, so the pane cannot get ahead of the agent.

### Lifecycle cases

| Case | What happens |
|---|---|
| Pane closes / reconnects | The tail replays the request. The standing set keeps it on the latest page. The dock reappears. |
| Two panes | Both dock it. The first answer wins, and later ones are dropped (`answered` set). |
| Server restart, or the relay drops (acpd holds the agent) | The request stays open at the agent. `recover()` finds it unanswered, and an answer goes out via `respondTo` with the verbatim id. An answer that comes before recovery is held (`deferredAnswers`). |
| Stop | `cancel()` answers `{ action: 'cancel' }` → "Tool use aborted". The turn ends `cancelled`. |
| Adapter withdraws (abort, session close) | `$/cancel_request` → the ask is dropped live and closed as `withdrawn` in the record. |
| Agent exits / restarts | `_acpd/exit` releases the ask, and the new life's record starts empty. The tool call ends interrupted. |
| Message sent while open | It is steered. claude's adapter holds it until the question settles, so it is delivered after the answer. The dock says so. |
| Workspace stopped while open | Like a permission ask: the transcript shows it unanswered and nothing can answer it. |

### TUI mode

Out of scope. A TUI claude blocked on AskUserQuestion shows "✳" in its
title (`classifyClaudeTitle`) and reads `waiting`, not `asking`, the same as
its permission dialogs.

## Frontend

### Catalog (`ui/`, docs/frontend-components.md)

The fence keeps raw inputs inside `ui/`, so the form's parts go into the
catalog first:

- **`YChoiceList`** (in `ui/YChat.tsx`): option rows with a keycap number,
  a label, an optional description and an optional preview. It has two
  modes. `single` uses base-ui's RadioGroup; `multi` uses `YCheckbox` rows.
  An `other` slot puts a text input as the last row, which focuses on
  click. A focused option's `preview` shows below the list in a sunken mono
  box (the previews are mockups and snippets).
- **`YAsk` uses it.** Its numbered `options` (pick answers at once) are
  rendered by `YChoiceList` in a one-click mode, so there is one option-row
  implementation. `YAsk` gains a `scroll` cap (a max height with overflow),
  because a four-question form must not push the composer off a phone
  screen.
- The fields that aren't choices use existing catalog parts: `YInput`,
  `YNumberInput`, `YSwitch`, `YField` for title and description.
- On the catalog page's Chat section: "YAsk · questions" (two questions, one
  multi-select, with Other), "YAsk · question with preview", and "YAsk ·
  refusal fallback". `test-playwright-scripts/catalog-screens.js` is the
  visual check.

### Docking (`components/AcpTranscript.tsx`, `WorkspaceChat.tsx`)

- `groupEvents` adds a `question` group from `elicitation-request`,
  completed by `elicitation-resolved`. When its `toolCallId` matches an
  AskUserQuestion tool row, the group absorbs that row, the way a
  permission group takes `inView` from its tool call. A subagent's question
  shows in the main thread, as its permission asks do.
- `PendingAsks` docks open `question` groups beside permission asks, as a
  `DockedQuestion`: a `YAsk` whose title is the request's `message`, with
  one `YField` per field. Choice fields render as `YChoiceList`, with the
  paired `other` field folded in as its Other row.
- **Answering.** The actions are **Submit** (`accept` with the filled
  fields; disabled until every `required` field has a value) and **Skip**
  (`decline`, so claude is told the user skipped). A single question with a
  single select and nothing typed keeps the one-click path: picking an
  option submits. Buttons disable on send and re-enable if the send fails.
  The card leaves when `elicitation-resolved` arrives, the same contract as
  `DockedAsk`.
- **Keyboard.** Digits 1–9 pick the matching option of the focused question
  (submitting in the one-click case). Arrows move within a radio group and
  Space toggles a checkbox, as base-ui provides. Tab moves between
  questions. Enter in an Other box and Ctrl/Cmd+Enter anywhere in the form
  submit. Escape does nothing, so a stray key never skips a question. When
  a question docks, focus moves to its first option only if the composer is
  empty, so it never takes over half-typed text.
- **The send path.** `useConversationView` gains `answerElicitation` beside
  `answerPermission`. It is absent for a read-only viewer, whose transcript
  says who it is waiting on (`waitingOn`), as for permission asks.
- A hint under the form: "A message you send now reaches Claude after you
  answer or skip."

### In the transcript

- **Open:** the one-line marker permission asks use ("<title>: waiting for
  your answer below").
- **Answered:** a `QuestionRow` with each question's header and text, and
  the answer under it. Picked options are marked, then Other text, then
  "(skipped)" for a blank one. "Skipped" is shown for `decline`, "Stopped"
  for `cancel`, and "Withdrawn" for `withdrawn`. For AskUserQuestion it
  replaces the tool row and folds the tool's result text away, since the
  answer is shown. The refusal dialog and MCP forms render the same way as
  standalone rows.
- **Condensed view:** an answered question counts as a key message, like a
  decided permission ask.

## History and replay

`claude-acp-replay.ts` runs the adapter's own `toAcpNotifications` over
claude's transcript. claude's JSONL keeps the AskUserQuestion `tool_use` and
its `tool_result`, but no elicitation. A restored life, and a TUI
conversation's `/acp/observe`, therefore shows a plain tool row: the title
is the question (`AskUserQuestionReporter`; "Asking for your input" when
there are several), and the output is claude's result text. The live pane
shows the `QuestionRow`. That difference gets an entry under claude in
`docs/acp-history-differences.md`, in the same change. The entry says the
options and which were picked are not shown, only claude's result text, and
that a skipped or withdrawn question has no marker. The refusal dialog and
MCP forms leave no trace in claude's transcript beyond what followed (the
retry, the tool result), so the entry covers them too.

Closing the gap would need the replay to build `elicitation-*` events from
the transcript's structured `toolUseResult` (`questions`, `answers`,
`annotations`). That is a second translation beside the adapter's, which
the replay module exists to avoid (open question 4).

## Tests

**Server, `packages/server/test/runtime/agents/`** (`#runtime/agents` is
sealed, so each `describe` is a barrel function defined in the module the
file covers). Mock at the process boundary: wire lines in and out, as the
existing fakes do.

- `drivers.test.ts`, `agentDriver` (it owns `AcpConversation` through
  `connect`). These cases share one fake claude adapter:
  - `initialize` carries `elicitation.form` for claude and not for codex.
  - An `elicitation/create` parks the request. The status becomes `asking`,
    an answer goes out as the wire reply with `content`, and the status
    returns to `running`.
  - Under `bypass` a question is still parked, not answered.
  - Stop answers `{ action: 'cancel' }`.
  - `$/cancel_request` retires both a question and a permission ask.
  - URL mode and an unknown property type get `-32602`.
  - On a reattach, a recorded open question is recovered and answered
    across the reconnect with the verbatim numeric id. A held answer
    applies once recovery names the question.

  These cases drive `parseElicitationRequest`, `recover()` and
  `clientCapabilities`, which are internal, incidentally. Use the request
  `askUserQuestionsToCreateRequest` produces for two questions (one
  multi-select, one with a preview) as the fixture, copied from the pinned
  adapter.
- `acp-log.test.ts`, under `readAcpPage` / `replayAcpLog`:
  - Request and reply lines project to `elicitation-request` /
    `elicitation-resolved`, with the Other pairing and the preview.
  - A refused request projects to nothing.
  - `$/cancel_request` closes both kinds.
  - An open question stands onto the next page.
- `acp-bridge.test.ts`, under `attachAcp`: `elicitation` reaches the
  conversation from a control pane and is dropped for an observer.
- Coverage (`pnpm vitest run --project unit:server --coverage`) confirms
  that the new branches in `acp-protocol.ts` and `acp-log.ts` are reached.

**Frontend, `packages/frontend/test/`:**

- `acp.test.ts`: `groupEvents` builds the `question` group, absorbs the
  AskUserQuestion tool row, and settles on each action.
- `workspace-chat.test.tsx`, against a fake stream:
  - The dock renders a multi-question form.
  - The one-click pick sends `accept`.
  - Multi-select plus Other sends string arrays and text.
  - Skip sends `decline`, and Submit waits for required fields.
  - Digit keys pick, and Escape does nothing.
  - A read-only viewer sees the waiting line.
  - The transcript shows the answered row and the withdrawn marker.

**End to end: `test/e2e-containerless/workspace-suite.test.ts`**, in its
`acp` describe. That tier runs in a containerless dev workspace (it needs
only `socat`, `CAN_RUN_ACP`). The fake claude adapter (`fakeAcpAdapter`)
learns one prompt, "ask a question": it sends an `elicitation/create` with
the AskUserQuestion shape, then on the reply writes the answer as a
`session/update` and ends the turn. The case:

- asserts `initialize` in the record carries `elicitation.form`
- sees the session listed `asking`
- attaches `/api/acp/attach` and finds the `elicitation-request`
- closes and re-attaches mid-question and finds it still docked
- answers, and sees `elicitation-resolved`, the agent's echo of `content`
  and the status leave `asking`

It reuses the file's shared server and one workspace, per the fixture
rules. Nothing here is driver-specific, so no k8s tier adds a case.

**Real adapter, by hand:** `test-playwright-scripts/ask-user-question.js`
drives a real claude `acp` workspace. It prompts for a two-question ask,
answers through the dock, and checks the transcript. It is also how to
check the open items in the next section that no fake can answer.

## Steps

1. Shared wire types (`AcpFormField`, the two events, the client message),
   plus the protocol helpers and constants in `acp-protocol.ts`.
2. `acp-client.ts`: the kind-aware asks, `elicitation/create`,
   `$/cancel_request`, `answerElicitation`, the `formElicitation` profile
   field and the capability. Unit cases in `drivers.test.ts`.
3. `acp-log.ts`: projection, standing, `$/cancel_request`, `pendingAsks` in
   recovery. Cases in `acp-log.test.ts`.
4. `acp-bridge.ts`: the client message. Case in `acp-bridge.test.ts`.
5. `ui/`: `YChoiceList`, `YAsk` on top of it, catalog entries, a catalog
   screenshot pass.
6. `AcpTranscript.tsx` / `ConversationView.tsx` / `WorkspaceChat.tsx`: the
   question group, `DockedQuestion`, `QuestionRow`, `answerElicitation`.
   Frontend tests.
7. The e2e-containerless case and the fake adapter's question prompt.
8. Docs, in the same change:
   - `docs/permission-modes.md`: its `acp` asks section covers questions
     and says posture never answers them.
   - `docs/agent-modes.md`: the record's asks; claude's steer waiting on a
     question, not only a permission ask.
   - `docs/acp-history-differences.md`: the claude entry.
   - `docs/frontend-components.md`: `YChoiceList`.
   - Delete this plan.
9. A pass by hand with the real adapter: the Playwright script, plus the
   checks in open question 5.

## Open questions

1. **Should a composer send skip the question?** In claude's TUI the
   question dialog holds the keyboard and Escape skips it. This plan leaves
   questions to the dock, and a message waits behind the question. Making
   "send" do decline-then-steer would be quicker for a user who wants to
   redirect, but it answers on their behalf. `yaac-mama send` must never do
   it either way.
2. **URL elicitation and MCP OAuth.** Worth a separate plan: where the
   OAuth callback lands under each driver, and `session/complete_elicitation`.
3. **codex.** Turning the capability on for codex brings its non-blocking
   `request_user_input_async` questions and moves MCP approvals onto
   elicitation. It is worth doing once this renderer exists, as its own
   change, checked against codex-acp's `docs/async-questions.md`.
4. **Restored questions.** Accept the documented gap, or have
   `claude-acp-replay.ts` build `elicitation-*` events from the transcript's
   `toolUseResult`?
5. **To verify with the real adapter before shipping:**
   - That AskUserQuestion still reaches `canUseTool` under `bypass` and
     `auto`. The adapter's comment says Claude Code applies bypass before
     `canUseTool`, and that tools requiring user interaction stay
     bypass-immune.
   - The exact result text claude writes for answered and skipped
     questions, which restored rows show. It is not a plain string in the
     2.1.321 binary.
   - That a steered message during a question arrives after the answer
     rather than being dropped.
