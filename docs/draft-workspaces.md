# Draft workspaces

A **draft workspace** is the contents of the new-workspace pane, kept when
the user left it without creating or queueing. Like a sidebar group, it is
only a record of intent: a row in `draft_workspaces`, with no checkout and
no runtime. Nothing runs from a draft on its own.

## The new-workspace pane

The webapp's main pane starts a new workspace whenever no workspace is
selected (the sidebar's +, Alt+N, a project with none): the chat composer
for the prompt, its permission mode and effort beside it as in a chat, and
the other settings where the conversation would be (`NewWorkspacePane`).
Its header bar is a workspace's: the view toggle, and New Shell, Files and
Changes, which start the workspace now and open that pane once it is up.
Send needs a prompt, so an Enter in an empty box starts nothing; a
workspace starts without one only from those buttons or from "Start
without a prompt", in whichever UI is picked.

There is at most one form, kept in the browser's localStorage
(`yaac.newworkspace.v1`), so a reload brings back what was typed. A prompt
too long to keep there (over 64 KB) holds the browser's leave-page prompt
instead. The form is dropped when the user leaves the pane: by selecting a
workspace, switching project or user, opening the desktop app's server
list, or reopening the pane on a draft, a queued entry or a Start parent.
The + and Alt+N leave a queued edit or a reopened draft for a blank form,
but keep a plain one. Leaving with a non-blank
prompt first asks whether to **save** a draft, **discard**, or **keep
editing** (the store's `navigate` holds the navigation until the answer).
With no prompt it leaves silently, since the settings are already
remembered as the project's create defaults. Editing a queued workspace
never asks; it has its own Save. Opening Settings (for a missing
credential, say) is not leaving, so the form waits there.

A pane reopened on a draft asks only if something changed, and then offers
to save the changes or leave the draft as it was. If the draft was deleted
meanwhile (created from or discarded in another tab), the save makes a new
draft instead.

Other exits keep the prompt too:

- **Save draft**, below the settings, saves without asking and clears the
  form. It is enabled once there is a prompt (and, on a reopened draft, a
  change), and is absent when editing a queued workspace.
- Stopping a workspace while it is still being created (the provisioning
  row's ■, the Stop button in its pane, `yaac workspace stop`, or
  `yaac-mama stop`) rolls the create back and saves its prompt as a draft,
  updating the draft it was created from if there was one. `stopWorkspace`
  marks the provisioning row stopping, and `createWorkspace` checks for that
  before each step that would start something: recording the workspace row,
  launching the runtime, and starting the agents. A failure at a checkpoint
  takes the create's ordinary rollback, which deletes the row and checkout,
  so the draft is the only thing left. A create already past its last
  checkpoint has a running agent, so it finishes and is then stopped like
  any running workspace, landing in stopped workspaces. Stopping a restart
  the same way leaves the workspace stopped.
- A create from the webapp that fails once it is under way (a broken image
  build, a missing branch, a runtime that never comes up) takes the same
  rollback and saves its prompt as a draft the same way, so the draft is
  where a retry starts. The error says so, and the failed provisioning row
  shows the prompt beside it. Only the webapp asks for this
  (`draftOnFailure`): a failed `yaac workspace create` or `yaac-mama create`
  keeps no draft, since retrying it could only add another. Neither does a
  request refused before the create starts (an unknown group, a permission
  mode the tool lacks), which the caller still holds, nor an agent that dies
  after the create has returned, whose workspace exists and is reaped like
  any other. A queued launch never makes a draft: its entry goes back on
  the queue, which already holds the prompt.

## What a draft holds

Every field as the pane showed it: prompt, title, agent, model, effort, UI
mode, permission mode, reference branch, group, and **Start**. Reopening the draft
restores the screen.

- Model and branch are empty if the pane had not loaded them yet; reopening
  then uses the default, as a fresh form does.
- Start is the id of the workspace or queued entry the create would wait on.
  If that parent is gone when the draft reopens, Start falls back to now.
- Deleting the draft's group clears the field. A name typed into the "+ New
  group" box is not saved, because that group does not exist until a create
  or queue makes it; the draft keeps the group picked before the box opened.

Creating or queueing from a draft deletes it. The request names the draft
(`draftId`), which claims it (`claimDraft`): a second request naming a draft
already claimed is refused with `CONFLICT`, and one naming a draft that is
gone with `NOT_FOUND`, so two tabs or a retry cannot make two workspaces from
one draft. While the request runs the snapshot leaves the draft out, and the
server deletes it only after the workspace or queue entry exists, so a failed
create shows the draft again. The claim is held in memory, so a server
restart mid-create shows the draft again too.

## Titles

A title typed in the pane's heading is the draft's `title`, and whatever is
created from the draft keeps it. The new workspace's provisioning row is
headed by that title, or by the generated one below.

Without one, the title sweep (`reconcileGeneratedTitles`) handles drafts as it
does live workspaces. A prompt long enough to need summarizing gets one model
attempt, stored as the draft's `generatedTitle`. A workspace created from the
draft keeps it as its own generated title, shown until the workspace's agent
gives one (docs/workspace-titles.md); a queue entry stores it as its own
`generatedTitle`. This is skipped if the user set a title or changed the
prompt before creating.

Changing the prompt clears the generated title. Attempts are keyed on the
draft and the prompt, so a new prompt gets its own attempt, and the write only
lands if the draft still holds the prompt it was generated from. The sweep
runs on the reconciler's resync (every minute), so a new draft is titled
within about a minute. Until then the sidebar shows the prompt's first line.
The new-workspace pane, reopened on an untitled draft or queued entry, is headed by
its generated title until the prompt is changed.

## Surfaces

- **Routes.** `/workspace/draft/save` inserts when given no `id`. With an `id`
  it replaces that draft's fields; a draft that is gone or belongs to another
  project answers `NOT_FOUND` instead of being re-created.
  `/workspace/draft/discard` deletes one. `/workspace/create` and
  `/workspace/queue/create` take `draftId`.
- **Snapshot.** `draftWorkspaces`, for every project, oldest first.
- **Webapp.** A collapsible **Drafts** section at the top of the sidebar,
  newest first, hidden when the project has none. Clicking a draft reopens
  the new-workspace pane on it. Its `…` menu can **Run now**, which creates from the draft
  straight away with its saved settings (ignoring Start), or discard it.
- Removing a project deletes its drafts.
