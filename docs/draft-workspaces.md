# Draft workspaces

A **draft workspace** is the contents of the create dialog, kept when the user
closed it without creating or queueing. Like a sidebar group, it is only a
record of intent: a row in `draft_workspaces`, with no checkout and no
runtime. Nothing runs from a draft on its own.

## When the dialog asks

Closing the create dialog (the ×, Escape, or a click outside) with a non-blank
prompt asks whether to **save** a draft, **discard**, or **keep editing**. With
no prompt it closes silently, since the settings are already remembered as the
project's create defaults. Editing a queued workspace never asks; it has its
own Save.

A dialog reopened on a draft asks only if something changed, and then offers
to save the changes or leave the draft as it was. If the draft was deleted
meanwhile (created from or discarded in another tab), the save makes a new
draft instead.

Other exits keep the prompt too:

- **Save draft**, beside Create, saves without asking and closes. It is
  enabled once there is a prompt (and, on a reopened draft, a change), and is
  absent when editing a queued workspace.
- Create with a missing git or agent credential sends the user to Settings,
  and saves the typed prompt as a draft first without asking.
- While a prompt is unsaved, a page reload or tab close triggers the browser's
  leave-page prompt.
- Stopping a workspace while it is still being created (the provisioning
  row's ■, the Stop button under its progress, `yaac workspace stop`, or
  `yaac-mama stop`) rolls the create back and saves its prompt as a draft,
  updating the draft it was created from if there was one. `stopWorkspace`
  marks the provisioning row stopping, and `createWorkspace` checks for that
  before each step that would start something: recording the workspace row,
  launching the runtime, and starting the agents. A failure at a checkpoint
  takes the create's ordinary rollback, which deletes the row and checkout,
  so the draft is the only thing left. A create that fails on its own
  before reaching a checkpoint (a broken image build) ends as that failure
  would, with no draft. A create already past its last
  checkpoint has a running agent, so it finishes and is then stopped like
  any running workspace, landing in stopped workspaces. Stopping a restart
  the same way leaves the workspace stopped.

## What a draft holds

Every field as the dialog showed it: prompt, title, agent, model, UI mode,
permission mode, reference branch, group, and **Start**. Reopening the draft
restores the screen.

- Model and branch are empty if the dialog had not loaded them yet; reopening
  then uses the default, as a fresh dialog does.
- Start is the id of the workspace or queued entry the create would wait on.
  If that parent is gone when the draft reopens, Start falls back to now.
- Deleting the draft's group clears the field. A name typed into the "+ New
  group" box is not saved, because that group does not exist until a create
  or queue makes it; the draft keeps the group picked before the box opened.

Creating or queueing from a draft deletes it. The request names the draft
(`draftId`) and the server deletes it only after the workspace or queue entry
exists, so a failed create keeps the draft.

## Titles

A title typed in the dialog's heading is the draft's `title`, and whatever is
created from the draft keeps it.

Without one, the title sweep (`reconcileGeneratedTitles`) handles drafts as it
does live workspaces. A prompt long enough to need summarizing gets one model
attempt, stored as the draft's `generatedTitle`. A workspace created from the
draft uses it as its title; a queue entry stores it as its own
`generatedTitle`. This is skipped if the user set a title or changed the
prompt before creating.

Changing the prompt clears the generated title. Attempts are keyed on the
draft and the prompt, so a new prompt gets its own attempt, and the write only
lands if the draft still holds the prompt it was generated from. The sweep
runs on the reconciler's resync (every minute), so a new draft is titled
within about a minute. Until then the sidebar shows the prompt's first line.
The create dialog, reopened on an untitled draft or queued entry, is headed by
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
  the dialog on it; its `…` menu can discard it.
- Removing a project deletes its drafts.
