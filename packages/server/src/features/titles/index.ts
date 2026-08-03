// The public interface of the titles feature. Everything outside this
// directory imports `#features/titles`; the SEALED_FOLDERS lint rule stops
// src from reaching past this file. Modules in here import each other by
// relative path, which is why they are unaffected by that rule.
//
// One entry point: the reconcile step that gives untitled sessions a
// model-generated title. Everything behind it — the summarizer and the
// pinned llama.cpp runtime — is internal and covered through it.
//
// Title *normalization* is not part of this interface: it is a pure string
// utility the session store and the rename route need without any of the
// model machinery, so it lives in `@yaac/shared/titles`.

export { reconcileGeneratedTitles } from './title-generation'
