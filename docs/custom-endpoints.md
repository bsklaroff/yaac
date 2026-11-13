# Custom endpoints

A custom endpoint is a self-hosted OpenAI-compatible server (vLLM, Ollama,
llama.cpp, llama-swap, LiteLLM…) that opencode, pi and omp can use in place
of a hosted provider. Each user keeps their own, by name, in Settings →
Credentials → Custom endpoints, or with `yaac auth endpoint`.

## The model

A `custom_endpoints` row holds its owner, a name (unique per owner), the
base URL, the key (sealed; empty when the server takes none) and the model
list. A model is an id, an optional display name, and optionally its
reasoning levels with a default:

```json
[
  { "id": "gpt-oss-120b", "name": "gpt-oss 120B",
    "efforts": { "levels": ["low", "medium", "high"], "default": "medium" } },
  { "id": "gemma-3" }
]
```

The levels are in the endpoint's own words, those of the OpenAI
`reasoning_effort` parameter they are sent as: `none minimal low medium high
xhigh max` (`ENDPOINT_EFFORTS`). Each id launches as `custom/<id>`, so it
must pass the create form's model check.

## Attaching an endpoint to a tool

An endpoint serves any number of the api-key tools, and a tool uses at most
one, as a git credential serves several projects and a project uses one.
Attaching one *is* signing the tool in with the `custom` provider, which
replaces whatever provider it had: the sign-in (`tool_credentials`) names the
endpoint by id and holds no key of its own. So attach and detach are the
ordinary sign-in and sign-out routes (`PUT /auth/:tool` with an
`endpointId`, `POST /auth/clear`), and the webapp's tool toggles on an
endpoint and the provider picker on a tool's row cannot disagree.

Adding an endpoint *beside* a tool's own provider (pi on OpenRouter and a
local server at once) is not supported: it would need a provider id and key
variable per endpoint.

The sign-in is resolved against its endpoint in one place, `loadToolAuthEntry`
(`#domain/auth`): the entry carries the endpoint and its key, so the create
path, the model catalog and `yaac-mama models` read it like any sign-in. A
sign-in naming an endpoint that is gone or not its owner's reads as signed
out. The runtime push fills each custom sign-in's URL and key in the same
way, so the egress proxy swaps the key in on the endpoint's host as for a
generated provider's `apiHost` (docs/workspace-egress.md).

Changing an endpoint's host drops its stored key unless the change gives a
new one, so a mistyped or moved URL is never sent the old server's key.

Deleting an endpoint is never refused: it signs out the tools that used it,
so a leaked key can be removed at once. A delete or an edit fails with
`RUNTIME_UNAVAILABLE` if the egress proxy cannot be told, as a git
credential's does.

## Fetching the models

The list is fetched from `GET <baseUrl>/models` (the OpenAI list shape,
`{ "data": [...] }`) when an endpoint is added, and on request after that.
It never refreshes on its own, so what workspaces launch with changes only
when the user saves.

The server makes the request, with the endpoint's key as a bearer token,
a 10-second timeout and a 2 MiB cap. It is the server's network view that
counts. Under containerless that is the workspaces'. Under k8s the server
pod reaches only public addresses (docs/server-in-cluster.md "The server's
own egress"), so a private, LAN, tailnet or in-cluster endpoint needs a
NetworkPolicy opening that selects `app: yaac-server`, or its models entered
by hand. Until then the dial is dropped, and the fetch fails with a timeout
that says so. Errors are specific ("HTTP 401", "connection refused") so the
user can fix the URL.

A self-hosted endpoint is usually on a private address, so under k8s a
workspace's tool reaches it only once the project allows it:
docs/workspace-egress.md "Opening an internal destination" and "A model
server on a tailnet" say how (an allowlist entry, a NetworkPolicy opening,
and CoreDNS for a MagicDNS name).

Each entry becomes a model unless it is an embedding or reranking model
(llama-swap's `capabilities.embeddings` / `reranker`) or an id yaac cannot
launch; those are listed as skipped. A name comes from `name`.

No server reports reasoning levels on `/models` by any standard. Codex's
model catalog fields are the closest thing to one, so those are read:
`supported_reasoning_levels`, an array of `{ "effort": … }` objects (Codex's
shape) or plain strings, and `default_reasoning_level`, else `medium` if
listed, else the least level. They are read off the entry, or else off
`meta.llamaswap`, where llama-swap passes through a model's free-form
`metadata`. So a llama-swap operator advertises levels like this:

```yaml
models:
  gpt-oss-120b:
    metadata:
      supported_reasoning_levels: [low, medium, high]
      default_reasoning_level: medium
```

A model whose server reports no levels this way is listed without them, and
the user adds them in the JSON.

## Editing by hand, and re-fetching

The list is edited as JSON: in the endpoint's editor in Settings, checked
against the shared schema on every keystroke with each problem located by
path, or with `yaac auth endpoint edit`, which opens it in `$VISUAL` /
`$EDITOR` under a comment header and reopens a file that does not parse
with its errors added, as `kubectl edit` does. `yaac auth endpoint models`
prints the list in the form `edit --models-file` reads, so it can be
scripted.

A re-fetch never replaces a list that may have been edited by hand. It
compares the endpoint's answer with the list by id
(`diffEndpointModels` in `@yaac/shared/endpoint-models`): new models,
changed ones (a different name or levels) and gone ones. New and changed
start selected, gone ones not, since a model the endpoint no longer lists
may have been added on purpose. Applying the selection edits the JSON, not
the server, so the result is reviewed and then saved like any edit. `yaac
auth endpoint refresh` prints the same diff and applies what `--apply`
names, or opens the merged list in the editor with `--edit`.

An endpoint's editor opens with a banner naming the tools it serves. Saving
rewrites those tools' config in every one of the owner's projects at once;
agents already running keep the list they started with until restarted.

## Reasoning levels in each tool

The endpoint's levels become each tool's own (`endpointEfforts` in
`@yaac/shared/tool-providers`), which is what the settings pill's effort levels, `--effort`
and the launch use (docs/effort-levels.md):

| Tool | Levels offered | Config written (`ensureToolApiKeyConfig`) |
|---|---|---|
| opencode | `default`, then the endpoint's words; defaults to the endpoint's default | a `variants` entry per level, each sending that `reasoningEffort` |
| pi | `none` becomes `off`, the rest as named | `reasoning: true` and a `thinkingLevelMap` from each pi level to the endpoint's word, every level the model lacks mapped to `null` (pi would otherwise send its provider default for it) |
| omp | `off`, then the rest | `reasoning: true` and `thinking: { mode: effort, efforts, defaultLevel }` |

A model without levels offers no effort levels in the settings pill and launches with none (pi's
`reasoning: false`). The config shapes were checked against pi 1.4.0, omp
18.18.3 and opencode 2.1.4 (opencode's `/api/model` lists exactly the
variants written).
