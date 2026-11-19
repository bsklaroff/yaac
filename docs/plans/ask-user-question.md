# Agent questions in `acp` mode

## Goal

Let a chat (`acp`) conversation's agent ask the user structured questions,
the way the tools' TUIs do. Examples are claude's `AskUserQuestion`, codex's
`request_user_input`, opencode's `question` and omp's `ask`. The turn blocks,
the user answers in a form docked above the composer, and the answer goes
back into the turn.

ACP carries these as **form elicitations**. The agent sends
`elicitation/create` with a JSON Schema form, and the client replies
`accept` (with `content`), `decline` or `cancel`. An adapter only sends them
to a client that declares `clientCapabilities.elicitation.form`.
`clientCapabilities()` in `runtime/agents/acp-protocol.ts` declares none, so
today the tools either hide their question tool or answer it empty.

## What the declaration turns on, per tool

Each entry below was read from the pinned adapter and then run against it:
a scripted ACP client declaring `elicitation.form`, with real models (see
"Verified against the real adapters").

**claude** (`claude-agent-acp` 0.103.0, CLI 2.1.321). Without the
capability the CLI is launched with `--disallowedTools=AskUserQuestion`
(`dist/v1/acp-agent.js`, `elicitationSupport`). With it, three things turn
on together:

1. `AskUserQuestion`, routed through `canUseTool` → `answerAskUserQuestion`
   (`dist/elicitation.js`).
2. MCP form elicitations (`onElicitation`), which the SDK otherwise
   declines.
3. The refusal-fallback consent dialog ("<model> declined this request.
   Retry with <fallback>?", `refusalFallbackToCreateRequest`). Without it
   the turn ends on the refusal.

**codex** (codex-acp 2.6.0, CLI 0.166.0). Two things turn on:

1. `request_user_input` (`buildUserInputRequest`). It reaches the user
   instead of returning empty answers.
2. MCP form elicitations that have fields; without the capability they are
   cancelled. MCP tool approvals are message-only forms and stay permission
   requests (`isMessageOnlyForm`).

codex 0.166 offers `request_user_input` only in its Plan collaboration mode,
or with the under-development feature `default_mode_request_user_input`.
Both work (verified). yaac exposes neither, so the plan turns the flag on
(see Decisions). codex's "async questions" (non-blocking forms whose answers
are steered in) need `send_message_to_user_async`, which is off, so they
are out of scope.

**opencode** (2.2.6). Its `question` tool is already offered to the model
under ACP. Without the capability, every question is cancelled and the
model is told "The question couldn't be shown to the user in this client.
Continue without an answer…". With it, opencode renders the question, and
any other form its tools raise, as an elicitation. Forms with sensitive
fields (the API-key/credential pattern), external links or conditional
fields are still cancelled on opencode's side.

**omp** (18.18.6). The capability sets omp's `interactivePrompts`. That
creates its `ask` tool (whose input is an HTML form), and gives tools and
extensions a UI context over elicitations: `select`, `confirm`, `input`,
`editor`, forms, and a usage-fallback confirmer.

**pi** (pi-acp). It has no elicitation code and no question tool. Its
extensions' questions already arrive as permission asks
(docs/permission-modes.md), so nothing changes.

**The forms have one shape.** All four use ACP's property set:

- `string`, with or without `oneOf` / `enum`
- `number` / `integer`
- `boolean`
- `array` of `anyOf` items

Where a question has an "Other" box, it is a text field right after the
choice field, keyed as the choice key plus an underscore suffix:

| Tool | Choice key | "Other" key |
|---|---|---|
| claude | `question_0` | `question_0_custom` |
| codex | `database` | `database_note` |
| opencode | `q0` | `q0_custom` |
| omp | `database` | `database_other` (and `q0__other` from its ask dialog) |

The `title` / `description` split differs. claude and opencode put the
header in `title` and the question in `description`; codex and omp do the
reverse. The renderer shows both, so the difference does not matter.

**What the answer means also differs per tool.** For claude, text in a
single-select's box beside a pick becomes a note on that pick, and with no
pick it is the answer. For opencode and omp the text replaces the pick. For
codex it is appended as a note (`user_note: …`). Each box's own title and
description (claude: "Type your own answer, or add a note…"; opencode:
"Type your own answer"; omp: "Your own answer instead") tell the user which
applies, so the form shows them verbatim rather than relabelling.

**Scope and withdrawal.** Requests are session-scoped. claude and opencode
add the `toolCallId` of a tool call they have streamed. codex names a
`toolCallId` it never streams. omp sends none. When an adapter stops waiting
(Stop, a closed session, codex's `autoResolutionMs` running out) it sends
`$/cancel_request { requestId }` and ignores any later reply.

## Decisions

- **Declare `elicitation: { form: {} }` for every adapter**, in
  `clientCapabilities()`. Four adapters gain a working question tool, and
  pi ignores the capability, so there is no per-profile opt-in to maintain.
- **No `url` elicitation, and so no MCP OAuth sign-in.** These stay out of
  scope.
- **Turn on codex's question tool** with
  `features.default_mode_request_user_input = true` in the `acp` launch's
  `CODEX_CONFIG` (`acp-adapters.ts`; the TUI's posture flags are
  untouched). codex lists the flag as under development, so the pin bump
  checklist in `AGENT_CLIS` gains "check this flag still exists". The
  alternative, mapping yaac's `plan` posture onto codex's Plan collaboration
  mode, changes what `plan` means for codex and is a larger change.
- **One generic form renderer, with no per-tool code.**
  `parseElicitationRequest` normalizes any request into fields:
  - `choice`: `oneOf`, `enum`, or an `array` of `anyOf` / `enum` items
  - `text`: with `format`, `pattern`, length bounds, `default`
  - `number` / `integer`
  - `boolean`

  It pairs an "Other" box with its question by the key rule above. The one
  adapter-specific read is codex's `_meta.codex.isSecret`, which masks a
  field. A request it cannot normalize (a mode other than `form`, a
  property type outside the set) is answered with JSON-RPC error `-32602`.
  Each adapter then denies or cancels on its own side, and the user never
  sees a broken form.
- **Posture never answers an elicitation.** `bypass` auto-answers
  permission asks because they are consent prompts that isolation makes
  moot. A question asks for information only the user has. claude asks
  `AskUserQuestion` under every mode, `bypassPermissions` included
  (verified), and yaac forwards it the same way.
- **A message sent while a question is open never answers or skips it.**
  This covers the composer and `yaac-mama send` alike; the dock says so.
- **The answer goes over the chat socket, not an HTTP route.** It is an
  `AcpClientMessage` on `/api/acp/attach`, like a permission answer, which
  `attachAcp` drops from `/acp/observe` readers. WebSocket routes are
  registered by `registerWebSocketRoutes` (`main/server-run.ts`), outside
  the `buildApp` app that `assertMatrixCoversEveryRoute` enumerates. So
  there is no route-matrix row. Everything here is in `#runtime/agents`
  above the driver seam, so both drivers get it unchanged.
- **The transcript card is built from the elicitation request and reply.**
  This works for every tool. For a restored life, the claude and codex
  replays emit the same two lines from the tool's own history ("History and
  replay"), so a restored question renders like a live one.

## Backend

### Protocol (`runtime/agents/acp-protocol.ts`)

- `ACP.elicitationCreate`, `ACP.cancelRequest`. `clientCapabilities()` gains
  `elicitation: { form: {} }`.
- `parseElicitationRequest(params)` → `{ toolCallId?, message, fields }` or
  undefined, as above. The live client and the record projection both call
  it, so the parked request and the pane never disagree about what was
  asked.
- `elicitationReply(action, content?)` and `parseElicitationOutcome(result)`,
  beside `permissionReply` / `parsePermissionOutcome`.

### Wire types (`@yaac/shared/acp`)

```ts
interface AcpFormOption { value: string; label: string; description?: string; preview?: string }
type AcpFormField = { key: string; title?: string; description?: string; required?: true } & (
  | { kind: 'choice'; multi: boolean; options: AcpFormOption[]; other?: string /* paired text field */; default?: string | string[] }
  | { kind: 'text'; secret?: true; format?: string; pattern?: string; minLength?: number; maxLength?: number; default?: string }
  | { kind: 'number'; integer: boolean; minimum?: number; maximum?: number; default?: number }
  | { kind: 'boolean'; default?: boolean })
type AcpFormValue = string | number | boolean | string[]
```

`preview` is claude's `_meta["_claude/askUserQuestionOption"].preview`.

Events, beside `permission-request` / `permission-resolved`:

- `elicitation-request { seq; thread?; requestId; toolCallId?; message; fields }`
- `elicitation-resolved { seq; requestId; action: 'accept' | 'decline' | 'cancel' | 'withdrawn'; content? }`

Pane → server: `{ type: 'elicitation'; requestId; action: 'accept' | 'decline'; content? }`.
Stop is how a user cancels, and the server answers `cancel` then.

The status needs no new wire type. A question makes the conversation
`asking`, which `listedStatus` sends as `waiting` + `asking: true`. The
sidebar, Home ("Waiting for your answer"), the chime and the dock badge
follow it.

### The conversation (`runtime/agents/acp-client.ts`)

Questions reuse the permission-ask machinery rather than copying it. That
machinery is the pending map, the answered set, recovered asks, held
answers, cancel-all and `respondTo` across a reconnect. It becomes
kind-aware:

- `pendingPermissions` / `recoveredPermissions` become
  `pendingAsks` / `recoveredAsks`, with entries tagged
  `'permission' | 'elicitation'`. `isAwaitingPermission` becomes
  `isAwaitingUser`, which `status` maps to `asking`.
- `onRequest` gains `elicitation/create`. It answers `-32602` if
  `parseElicitationRequest` fails; otherwise it parks the request with no
  timeout. It does not wait for the posture recovery, which a question does
  not depend on.
- `answerElicitation(requestId, action, content)` checks the shape (a known
  action; `content` an object of `AcpFormValue`s) and shares `settleAsk`
  with `answerPermission`. It does not check the content against the
  schema: every adapter tolerates or validates content itself.
- `cancelPendingAsks` (Stop, agent exit, close) answers each ask by kind:
  `{ outcome: { outcome: 'cancelled' } }` or `{ action: 'cancel' }`.
  `close()` keeps its rule that those replies land after `peer.close()`, so
  a detach never answers for the user.
- **`$/cancel_request` is new handling, for both kinds.** yaac ignores it
  today (`acp-jsonrpc.ts` has no case for it), so an ask an adapter
  withdraws stays docked and `asking` until the turn ends. claude does send
  it on Stop (verified). The conversation drops the named ask, settles its
  parked promise with a `-32800` error the adapter ignores, marks it
  answered and republishes status.
- **A turn's end retires an elicitation still open.** An adapter that
  stopped waiting without `$/cancel_request` would otherwise leave the
  conversation `asking` with nothing to release it. omp does this when the
  user sets its `ask.timeout`. The conversation answers such a question
  `cancel` when the turn ends (the `session/prompt` reply, or the adapter's
  idle report).
- The capability goes out in the handshake only. A running agent picks it
  up at its next restart, which needs no compatibility shim.

### The record (`runtime/agents/acp-log.ts`, `AcpProjection`)

acpd records both directions, so questions survive reconnects the way
permission asks do:

- An `elicitation/create` line → `elicitation-request`
  (`openElicitation`). Its thread is `threadOf(params)`, else its tool
  call's (`toolThreads`). A request yaac refused (its reply is an `error`)
  projects to nothing.
- A reply line → `elicitation-resolved` (`closeElicitation`).
- `$/cancel_request` for an open ask → `elicitation-resolved` with
  `withdrawn`, or `permission-resolved` with `cancelled`.
- `Pager`'s standing set carries an open question onto a new page.
- `recover()` returns `pendingAsks: Array<{ id: string | number; kind }>`,
  replacing `pendingPermissions`. A request with no reply and no
  `$/cancel_request` is pending, and `_acpd/exit` clears them. A question
  asked before a server restart can then be answered against the agent's
  own request id.

### The bridge (`runtime/agents/acp-bridge.ts`)

`attachAcp` routes `{ type: 'elicitation' }` to `answerElicitation` for a
control pane only, and echoes nothing. The recorded reply comes back through
the tail.

### Lifecycle

| Case | What happens |
|---|---|
| Pane closes / reconnects | The tail replays the request, and the standing set keeps it on the latest page. |
| Two panes | Both dock it. The first answer wins, and later ones are dropped. |
| Server restart / relay drop (acpd holds the agent) | `recover()` finds it unanswered. The answer goes via `respondTo` with the verbatim id, and an early answer is held (`deferredAnswers`). |
| Stop | yaac answers `cancel`. claude also sends `$/cancel_request`, fails the tool ("The user doesn't want to proceed with this tool use…") and ends the turn `cancelled` (verified). |
| Adapter withdraws | `$/cancel_request` → dropped live, and `withdrawn` in the record. |
| Agent exits / restarts | `_acpd/exit` releases it, and the new life's record starts empty. |
| Message sent while open | Steered. claude holds a steer until the question settles: the steer is answered `injected` at once and reaches the model after the answer (verified). opencode queues the message behind the turn, as for every mid-turn message. For codex and omp, see open question 2. |
| Workspace stopped while open | The transcript shows it unanswered. |

### TUI mode

Out of scope. A TUI claude blocked on a question shows "✳" and reads
`waiting` (`classifyClaudeTitle`), the same as its permission dialogs.

## Frontend

### Catalog (`ui/`, docs/frontend-components.md)

The fence keeps raw inputs inside `ui/`, so the form's parts are added to
the catalog first:

- **`YChoiceList`** (in `ui/YChat.tsx`): option rows with a keycap number,
  a label and an optional description. It is single-select over base-ui's
  RadioGroup, or multi-select over `YCheckbox`. It has an `other` slot (a
  text input as the last row) and shows a focused option's `preview` in a
  sunken mono box below.
- **`YAsk` renders its numbered `options` through `YChoiceList`** in a
  one-click mode, so there is one option-row implementation. It gains a
  max height with overflow, so a four-question form does not push the
  composer off a phone screen.
- Other field kinds use existing parts: `YInput` (masked for `secret`),
  `YNumberInput`, `YSwitch`, `YField`.
- On the catalog page: "YAsk · questions" (two questions, one
  multi-select, with Other), "YAsk · question with preview", and "YAsk ·
  confirm" (omp's single boolean). `test-playwright-scripts/catalog-screens.js`
  is the visual check.

### Docking (`components/AcpTranscript.tsx`, `ConversationView.tsx`, `WorkspaceChat.tsx`)

- `groupEvents` adds a `question` group from `elicitation-request`,
  completed by `elicitation-resolved`. When its `toolCallId` matches a tool
  row (claude's AskUserQuestion, opencode's question), the group absorbs
  that row, as a permission group takes `inView` from its call. A
  subagent's question shows in the main thread.
- `PendingAsks` docks open questions beside permission asks as
  `DockedQuestion`: a `YAsk` titled with `message`, one `YField` per field
  (title and description verbatim), and each `other` box folded into its
  choice's `YChoiceList`.
- **Answering:** **Submit** (`accept`; disabled until every `required` field
  has a value) and **Skip** (`decline`). A form of one single-select field
  and nothing typed keeps the one-click path: picking submits. Buttons
  disable on send and re-enable if the send fails. The card leaves when
  `elicitation-resolved` arrives.
- **Keyboard:**
  - Digits 1–9 pick in the focused question (and submit in the one-click
    case).
  - Arrows move within a radio group and Space toggles a checkbox.
  - Tab moves between fields.
  - Enter in a text field and Ctrl/Cmd+Enter anywhere submit.
  - Escape does nothing, so a stray key never skips a question.
  - A docking question takes focus only if the composer is empty.
- `useConversationView` gains `answerElicitation`. It is absent for a
  read-only viewer, who sees whom it waits on (`waitingOn`).
- A hint under the form: "A message you send now waits until you answer or
  skip."

### In the transcript

- **Open:** the one-line marker permission asks use.
- **Settled:** a `QuestionRow` showing each field's title, description and
  answer (picked options, then the box's text, masked if `secret`, else
  "(no answer)"), or "Skipped", "Stopped" or "Withdrawn". It folds away the
  absorbed tool row's result text, which repeats the answer. In condensed
  view it counts as a key message.

## History and replay

A restored life (and a `tui` conversation's `/acp/observe`) is rebuilt from
the tool's own history by the `*-acp-replay` translators. None of those
histories keeps the elicitation, but claude's and codex's keep enough to
rebuild it.

**claude** (`claude-acp-replay.ts`). The transcript entry holding an
AskUserQuestion `tool_result` has a structured `toolUseResult`:
`{ questions, answers, annotations }` for an answered or declined question,
and the string `"User rejected tool use"` for a stopped one (verified). The
SDK's parsed messages drop the field, but `ClaudeTranscriptReplay` keeps
every raw entry by uuid (`byUuid`). When `translate` meets that entry, it
writes two lines before the adapter's notifications for the message:

- The request: the adapter's own `askUserQuestionsToCreateRequest(questions,
  sessionId, toolUseId)`. The replay already loads adapter internals
  (`adapterModule`), so `elicitation` joins `ADAPTER_INTERNALS` and the form
  cannot drift from the live one.
- The reply, which inverts `applyAskElicitationResponse`:
  - A single-select answer equal to an option label is the pick.
    Otherwise it is the `_custom` text, and a `notes` annotation becomes
    the `_custom` text beside the pick.
  - A multi-select answer is split by the CLI's quoting rule (the inverse
    of `joinMultiSelectAnswer`): labels are picks, and the rest is the
    `_custom` text.
  - `unanswered: "dismissed"` on every question → `decline`.
  - `"User rejected tool use"` → `cancel`.

The replay uses a synthetic request id (`ask:<toolUseId>`), which a reply
pairs with but `recover()` never sees.

**codex** (`codex-acp-replay.ts`). The rollout keeps the
`request_user_input` `function_call` (questions with `id`, `header`,
`question`, `options`) and its `function_call_output`
(`{"answers":{"<id>":{"answers":["SQLite","user_note: …"]}}}`). Live,
codex-acp streams no tool call for it, so without synthesis a restored
question would not show at all. The replay already synthesizes what
codex-acp sends live. It adds the request (the schema `buildUserInputSchema`
builds for an AIR client: question as title, header as description, an
`<id>_note` field, all required) and the reply (the first answer not
prefixed `user_note: ` is the pick, and the prefixed one is the note).

**opencode and omp** keep their tool call and its result text ("User has
answered your questions: …", "User answers: {…}"), which a restored life
shows as a tool row. Rebuilding their forms is left out. Those two gaps,
and the refusal dialog and MCP forms (which no history keeps), get entries
in `docs/acp-history-differences.md` in the same change.

## Tests

**Server, `packages/server/test/runtime/agents/`.** `#runtime/agents` is
sealed, so each `describe` is a barrel function defined in the covered
module. Mock at the wire. Fixtures are the real requests captured from each
adapter during verification:

- claude: the two-question request
- codex: the AIR-form request
- opencode: the `q0` / `q0_custom` request
- omp: the `database` / `database_other` request and a `confirm`

`drivers.test.ts`, `agentDriver` (it owns `AcpConversation` via `connect`):

- `initialize` declares `elicitation.form`.
- A request parks, the status goes `asking`, and an answer goes out as the
  reply with `content`.
- `bypass` still parks.
- Stop answers `cancel`.
- `$/cancel_request` retires a question and a permission ask.
- A turn's end retires a question still open.
- Non-form modes and an unknown property type get `-32602`.
- A reattach recovers a recorded question and answers it with the verbatim
  numeric id, and a held answer applies once recovery names it.

These cases drive `parseElicitationRequest`, the pairing rule, `recover()`
and `clientCapabilities` incidentally.

`acp-log.test.ts`, under `readAcpPage` / `replayAcpLog`:

- Request and reply lines project, with `other` pairing for all four key
  styles.
- A refused request projects to nothing.
- `$/cancel_request` closes both kinds.
- An open question stands onto the next page.

`acp-bridge.test.ts`, under `attachAcp`: control panes only.

`claude-acp-replay.test.ts`, under `claudeTranscriptAsAcp`: transcripts of
an answered (picks, notes, a quoted multi-select item), a declined and a
stopped question project to the events the live record does.

`codex-acp-replay.test.ts`, under `codexTranscriptAsAcp`: a rollout with a
`request_user_input` call projects to a settled question.

**Frontend, `packages/frontend/test/`:**

- `acp.test.ts`: the `question` group, absorbing a tool row, each outcome.
- `workspace-chat.test.tsx`:
  - The dock renders a multi-question form.
  - One-click submit sends `accept`.
  - Multi-select plus Other.
  - Skip sends `decline`, and required fields gate Submit.
  - A masked secret field.
  - Digit keys pick, and Escape does nothing.
  - A read-only viewer sees the waiting line.
  - Settled and withdrawn rows.

**End to end: `test/e2e-containerless/workspace-suite.test.ts`**, in its
`acp` describe. That tier runs in a containerless dev workspace (it needs
`socat`). The fake adapter (`fakeAcpAdapter`) learns an "ask a question"
prompt: it sends the captured claude request and, on the reply, echoes the
content as a `session/update` and ends the turn. The case:

- asserts `initialize` in the record declares the capability
- sees the session `asking`
- attaches `/api/acp/attach` and finds `elicitation-request`
- re-attaches mid-question and finds it still docked
- answers, and sees `elicitation-resolved`, the echo, and `asking` cleared

It reuses the file's shared server and one workspace. No k8s tier adds a
case, since nothing is driver-specific.

**Real adapters:** rerun the scripted client from "Verified against the
real adapters" at each adapter pin bump. The bump checklists in `AGENT_CLIS`
and `ACP_ADAPTERS` gain that step. Each tool's adapter internals can move
the key styles, the codex flag, or claude's `toolUseResult` shape.

## Verified against the real adapters

A scripted ACP client declared `elicitation.form`, prompted each agent to
ask two questions (one single-select, one multi-select), and answered over
the wire. Results:

- **claude 0.103.0 / 2.1.321, Sonnet 5.5.**
  - The question reached the client under `auto`, `default` (Manual) and
    `bypassPermissions`.
  - accept, accept with only Other text, and decline all folded back as
    the adapter's code says.
  - Result texts:
    - answered: `The user answered: "Q"="A" notes: …, … Read the answers
      carefully — …`
    - in one run instead: `Your questions have been answered: "Q"="A", … You
      can now continue with these answers in mind.`
    - declined: `The user did not answer the questions.`

    The answered wording varies between runs, so nothing may parse it.
  - A steer while the question was open was answered `injected` at once
    and reached the model only after the answer.
  - Stop made the adapter send `$/cancel_request { requestId }`; the tool
    failed and the turn ended `cancelled`.
  - The transcript kept `toolUseResult` as described above.
- **codex 2.6.0 / 0.166.0**, declared as AIR as yaac does. Both routes
  asked and folded the answers back: `collaboration_mode: plan` and
  `features.default_mode_request_user_input`. The rollout kept the call and
  output as described above.
- **opencode 2.2.6** (via OpenRouter): the question was elicited with
  `toolCallId`, and the result was folded back.
- **omp 18.18.6**: the `ask` tool's HTML form was elicited without a
  `toolCallId`, and folded back.
- **pi-acp**: no question tool, and no elicitation.

## Steps

1. Shared wire types, plus protocol helpers and constants in
   `acp-protocol.ts`.
2. `acp-client.ts`: kind-aware asks, `elicitation/create`,
   `$/cancel_request`, retiring at a turn's end, `answerElicitation`, the
   capability. Cases in `drivers.test.ts`.
3. `acp-log.ts`: projection, standing, `$/cancel_request`, `pendingAsks`.
   Cases in `acp-log.test.ts`.
4. `acp-bridge.ts`: the client message, with its case.
5. `acp-adapters.ts`: codex's `default_mode_request_user_input` flag, and
   the bump-checklist notes.
6. Replays: `claude-acp-replay.ts` (with `elicitation` in
   `ADAPTER_INTERNALS`) and `codex-acp-replay.ts`, with their cases.
7. `ui/`: `YChoiceList`, `YAsk` on top of it, catalog entries, a screenshot
   pass.
8. `AcpTranscript.tsx` / `ConversationView.tsx` / `WorkspaceChat.tsx`: the
   question group, `DockedQuestion`, `QuestionRow`, `answerElicitation`.
   Frontend tests.
9. The e2e-containerless case.
10. Docs, in the same change:
    - `docs/permission-modes.md`: asks and questions; posture never answers
      a question.
    - `docs/agent-modes.md`: the record's asks; claude holds a steer for a
      question as for a permission ask.
    - `docs/acp-history-differences.md`: the opencode, omp, refusal-dialog
      and MCP-form entries.
    - `docs/frontend-components.md`: `YChoiceList`.
    - Delete this plan.
11. A pass with each real adapter through the built chat pane: a
    Playwright script in `test-playwright-scripts/` against a containerless
    workspace per tool.

## Open questions

1. **codex's flag.** Is relying on `default_mode_request_user_input` (under
   development) acceptable, or should yaac's `plan` posture map onto
   codex's Plan collaboration mode instead, where the tool is stable?
2. **Steering into a blocked codex or omp turn.** claude holds a steer
   until the question settles (verified). codex delivers a steer at its
   turn's next model call and omp at its next tool batch, and both are
   blocked on the question. That suggests the same outcome, but it was not
   run.
3. **omp's extra prompts.** Its `confirm`, `select`, `input` and `editor`
   calls and its usage-fallback confirmer become docked forms too. They
   render through the generic form; is that wanted for all of them, or
   should some (the usage fallback) be answered by yaac?
