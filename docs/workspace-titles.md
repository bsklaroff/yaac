# Workspace titles

What a workspace is called, first match wins:

1. **The user's title** (`workspaces.title`): typed in the create dialog's
   heading, or a rename from the sidebar, the header, `yaac workspace rename`
   or `yaac-mama rename`. Clearing it shows what follows. This column is
   always taken as the user's, so a title the local model wrote there on an
   older install stays until it is cleared.
2. **The agent's own title** for the conversation that labels the workspace
   (`conversations.title`, picked by `conversationTitle` in `#db`): the
   conversation `openingPrompt` reads, else the first conversation, in window
   order, that has one.
3. **A generated title** (`workspaces.generatedTitle`), from yaac's local
   title model (docs/workspace-title-model-eval.md), or carried over from the
   draft or queued entry the workspace was created from.
4. The opening prompt, then "New workspace".

The listings resolve the wire `title` from 1 to 3; clients fall back to the
prompt. Drafts and queued entries have no agent yet, so they show their own
title, else their generated one, else the prompt's first line.

## Generated titles

The local model runs only where no agent title will come
(`reconcileGeneratedTitles`): for drafts and queued entries, and for a live
workspace whose opening conversation runs a tool that titles nothing
(`agentTitlesItself`, so pi), and that has no user or agent title yet. A
workspace created from a draft or queued entry keeps that one's generated
title, which heads its provisioning row and shows until its agent gives one.
`YAAC_AUTO_TITLES=0` turns generation off.

## Where each agent keeps its title

Each agent titles its conversations with a small model from the provider it
already runs on, and stores the title where yaac reads it the same way under
`tui` and `acp` (`getConversationTitle` in `#runtime/agents`):

| Tool | Where | When it is written |
|---|---|---|
| claude | its transcript: `ai-title` records (the title claude generates, under either mode) and `custom-title` records (a `/rename`). A `custom-title` wins. | Re-appended every few entries, so only the transcript's last 256 KB is read. An `acp` conversation records no transcript path; its transcript is found by id. |
| codex | `session_index.jsonl` in the project's codex home: `{id, thread_name}` lines, the newest for the thread winning. A cleared name (an empty one) is not followed: the last name read stays. | Once the first message is in (the TUI) or after the first turn (codex-acp), and on a rename. |
| opencode | its database, read with `opencode api session.get` inside the workspace. | Once, soon after the opening message. Until then the title is `New session - <timestamp>`, which is ignored. |
| pi | nowhere | pi titles nothing, so a pi workspace gets a generated title. |

The ACP adapters also send titles as `session_info_update`, which yaac does
not read: codex-acp sends the raw opening message as a placeholder before
its generated title, and opencode's ACP server sends none. The stores above
are the one source that covers every tool in both modes.

## When titles are read

The conversation sweep (`reconcileConversations`) reads each live
conversation's title (`captureTitle` in `#domain/workspaces`) and records it
with the conversation's other observed facts (`conversations-discovered`), so the
title follows the agent's: a rename inside the tool replaces it. A
conversation is read again every 30 seconds while its transcript or ACP
record is changing, and every 5 minutes otherwise, since codex names a thread
a few seconds after its turn's last write. opencode's lookup starts a server
in the workspace, so it stops once the session is titled (the row's title
counts, so a server restart does not look again), and an untitled session
is looked up at intervals doubling from 2 to 30 minutes. A read that finds
nothing keeps the last title, so a claude title that scrolls out of the part
of the transcript that is read is not lost.

Only live conversations are read. A stopped workspace keeps the titles last
recorded, so one stopped between its agent writing a title and the next read
(most likely codex, idle after its turn) shows its generated title or prompt
instead. The stopped list's search matches user, agent and generated titles,
opening messages and tool names.
