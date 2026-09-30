// Public interface of the sealed titles folder (`#domain/titles`): the
// reconcile step that gives untitled workspaces, drafts and queued entries a
// model-generated title. The summarizer and the pinned llama.cpp runtime are
// internal.
//
// Title normalization is a plain string utility, so it lives in
// `@yaac/shared/titles`.

export { reconcileGeneratedTitles } from './title-generation'
