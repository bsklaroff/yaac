# Worktree-title model evaluation

> **Status: shipped.** Current-state reference for how the local worktree-title
> model was chosen. Cross-referenced from the titles feature's `title-summarizer`
> (the model pin) and `llama-cpp` (the llama.cpp runner).

## TL;DR

Untitled worktrees get a model-generated title summarizing their first message
(see the titles feature's `reconcileGeneratedTitles`). The original model, **`flan-t5-small`
(Q8_0)**, produced uninformative or degenerate titles on longer or jargon-heavy
first messages — e.g. a detailed request about sidebar title width + a marquee
effect became just **`x row`**.

After benchmarking **14 model/quant combinations** over a 16-prompt set, the
shipped model is now:

> **Qwen2.5-0.5B-Instruct, IQ4_XS GGUF (~333 MB)**, run via `llama-completion`.

That same marquee request now titles as **`Extend Sidebar Title with Hover
Effect`**.

Two findings drove the choice:

1. **Instruction-following, not size, is what matters at this scale.** The
   Qwen2.5 family reliably wrote a *title*; flan-t5 echoed or looped, and every
   model below ~0.5B params (gemma-3-270m, LFM2-350M, Qwen3-0.6B,
   h2o-danube3-500m) echoed the prompt, hallucinated, or added chat preamble.
   A *larger* model (Llama-3.2-1B) was actually worse than Qwen2.5-0.5B.
2. **Quantization is the size lever, and the imatrix quant wins.** For
   Qwen2.5-0.5B the file is dominated by its 151k-token embedding table, so
   lower quants only save so much. `IQ4_XS` (importance-matrix, 333 MB) held
   full-precision quality with **zero defects** on the test set while being the
   smallest *and* fastest — beating the same-size plain `Q4_K_S`/`Q4_K_M`,
   which mashed words and hallucinated (`Llama 2 Worktree Naming Optimization`).

## Why this changed

`flan-t5-small` is an 80M encoder-decoder. On short prompts it compresses fine,
but on long or specialized first messages it degenerated (`'Standard':
'Standard':`, `Speaking': 'Speaking':`), went vague (`SYN getting dropped`), or
produced something wrong (`scary mode toggle` for a dark-mode request). The
larger flan-t5 variants (base/large) stopped degenerating but mostly **echoed
the prompt verbatim**, often truncated mid-word — they don't really summarize.

Decoder-only instruction-tuned models follow "write a title" far better, so the
evaluation focused on finding the smallest one that stays reliable.

## Method

- **Prompts:** 16 realistic worktree first-messages spanning short / medium /
  long / obscure-jargon / bug-report shapes, including the three real
  user-reported bad-title cases. The set lives in the evaluation harness (see
  *Reproducing* below).
- **Runner:** `llama.cpp` release **`b9940`**, `llama-completion` binary — the
  same pinned runtime the server uses. Its binaries link against the system
  OpenMP runtime (`libgomp.so.1`), which the release archive does *not* bundle;
  a host without it extracts the archive fine and then fails to load every
  binary in it. `ensureLlamaCpp` smoke-checks the extracted runtime for exactly
  this reason and fetches `libgomp1` into its own cache (rootless, from the
  distro mirror) when it is the thing missing.
  - Decoder-only chat models: the model's own chat template via
    `--jinja -st -sys <system> -p <user> --temp 0 --no-display-prompt
    --simple-io` (greedy). This is exactly what `runChatCompletion` does.
  - `flan-t5` (encoder-decoder): the legacy `Write a very short title for this
    task: <text>` template (its instruction-following is too weak for the
    chat-style ask).
- **Prompt template (decoder models):** system = *"You write concise, specific
  titles for a developer tool's worktree list."*; user = *"Write a short,
  specific title (3 to 6 words) … Reply with ONLY the title …"* + the first
  message.
- **Post-processing:** strip the `[end of text]` marker, any leaked chat/think
  special tokens, wrapping quotes, and a trailing period — matching the shipped
  `postProcess`. Output is judged as-is (first line), i.e. "is this usable out
  of the box", not after model-specific cleanup.
- **Scoring:** per model, count the titles that are degenerate, a verbatim
  echo, vague/uninformative, wrong, or chat-preamble — out of 16.
- **Hardware:** local arm64 CPU. Timings are indicative (relative), not
  absolute; the sweep used 6 threads, the server uses llama.cpp defaults.

## Results

Sizes are the Hugging Face download size for that quant. "Defects" is
degenerate/echo/vague/wrong/preamble out of 16 prompts (lower is better).

### Round 1 — model family sweep

| model | params | quant | size | defects | verdict |
|---|---|---|---|---|---|
| `flan-t5-small` | 80M | Q8_0 | 114 MB | ~7–8 | **baseline** — degenerate loops / vague / wrong |
| `flan-t5-base` | 250M | Q8_0 | 305 MB | ~7 | echoes or truncates the prompt |
| `flan-t5-large` | 780M | Q8_0 | 865 MB | ~6 | echoes, or too terse; slow |
| `SmolLM2-360M` | 360M | Q8_0 | 369 MB | ~4 | summarizes but noisy (typos, quote artifacts) |
| `Llama-3.2-1B` | 1B | Q4_K_M | 785 MB | ~5 | erratic / vague despite being largest |
| `Qwen2.5-0.5B` | 500M | Q8_0 | 506 MB | ~0–2 | clean, specific — strong |
| `Qwen2.5-1.5B` | 1.5B | Q4_K_M | 608 MB | 0 | best overall; nails multi-part asks |

Takeaway: the Qwen2.5 family is the only one that consistently writes a title.
`Qwen2.5-0.5B` nearly matches its 1.5B sibling at a third the size.

### Round 2 — go smaller than Qwen2.5-0.5B

| model | params | quant | size | defects | verdict |
|---|---|---|---|---|---|
| `Qwen2.5-0.5B` | 500M | Q5_K_M | 401 MB | 0 | == Q8 quality, ~100 MB smaller |
| `Qwen2.5-0.5B` | 500M | Q4_K_M | 379 MB | ~2–3 | occasional hallucination / mashed words |
| `Qwen3-0.6B` | 600M | Q4_K_M | 378 MB | many | echoes; leaks `<think>`; slow (14–25 s) |
| `gemma-3-270m-it` | 270M | Q8_0 | 278 MB | many | echoes whole prompt; emits code fences / `[]` |
| `gemma-3-270m-it` | 270M | Q4_K_M | 241 MB | many | worse — `Okay, I understand. I will…` |
| `LFM2-350M` | 350M | Q8_0 | 362 MB | ~half | noisy caps / `Title:` leakage |
| `LFM2-350M` | 350M | Q4_K_M | 219 MB | ~half | noisy slug/caps artifacts |

Takeaway: **nothing below ~0.5B params holds the task.** The only lever left is
quantizing Qwen2.5-0.5B itself, and `Q5_K_M` does that cleanly.

### Round 3 — push the size down further

| model | params | quant | size | defects | verdict |
|---|---|---|---|---|---|
| `Qwen2.5-0.5B` | 500M | Q5_K_M | 401 MB | 0 | reference (round-2 pick) |
| `Qwen2.5-0.5B` | 500M | **IQ4_XS** | **333 MB** | **0** | **chosen** — smallest & fastest at full quality |
| `Qwen2.5-0.5B` | 500M | Q3_K_XL | 352 MB | 0 | clean (Q8 embeddings) but larger/slower than IQ4_XS |
| `Qwen2.5-0.5B` | 500M | Q4_K_S | 368 MB | ~2 | same glitches as Q4_K_M |
| `h2o-danube3-500m-chat` | 500M | Q5_K_M | 351 MB | many | preamble + hallucination (`The Ultimate Guide to…`) |
| `h2o-danube3-500m-chat` | 500M | Q4_K_M | 303 MB | many | unusable — chat preamble, echoes |
| `SmolLM2-360M` | 360M | Q5_K_M | 277 MB | ~4–5 | still noisy (same as Q8) |

`h2o-danube3-500m` was the interesting bet — a 500M model with a small 32k
vocab, so ~50 MB smaller than Qwen at the same quant — but its
instruction-following is too weak (it answers conversationally instead of
emitting a title).

### The quantization ladder (Qwen2.5-0.5B-Instruct)

| quant | size | quality |
|---|---|---|
| Q8_0 | 506 MB | full |
| Q6_K | 482 MB | full |
| Q5_K_M | 401 MB | full (0 defects) |
| Q4_K_M | 379 MB | occasional glitch |
| Q4_K_S | 368 MB | occasional glitch |
| Q3_K_XL | 352 MB | full (Q8 embeddings) |
| **IQ4_XS** | **333 MB** | **full (0 defects)** ← shipped |

The imatrix quant (`IQ4_XS`) is the sweet spot: it is smaller than the plain
`Q4_K_S`/`Q4_K_M` yet cleaner, because the importance matrix preserves the
weights that matter. Going below ~330 MB (Q2/Q3 plain) starts to degrade, and
the embedding table sets a hard floor around 320 MB regardless of quant.

## Decision

**Qwen2.5-0.5B-Instruct IQ4_XS**, from
`bartowski/Qwen2.5-0.5B-Instruct-GGUF`. It was the smallest configuration with
zero defects across the test set, ~34% smaller than the Q8 the model was first
picked at, and the fastest to run (~1–3 s/title on the test box). Q5_K_M
(401 MB) is a fine conservative fallback if IQ4_XS ever regresses on a
llama.cpp bump.

Wiring this in flipped the server from a T5 encoder-decoder (`runCompletion`,
raw `-p` template) to a decoder chat model (`runChatCompletion`, the model's
chat template) and bumped `MAX_NEW_TOKENS` 16 → 32 so descriptive titles aren't
truncated. A `sharesVocabulary` hallucination guard remains as a safety net,
though it is effectively a no-op for Qwen (its titles reuse prompt words).

## Reproducing / re-verifying

Re-verify title quality whenever bumping the pinned llama.cpp tag or swapping
the model/quant — imatrix and encoder-decoder support are not CI-protected
upstream and have regressed silently before.

1. Fetch the binary the server uses (`ensureLlamaCpp`) and the model
   (`ensureGgufModel` → `<dataDir>/models`). The model download needs egress to
   `huggingface.co` **and** `us.aws.cdn.hf.co` (the xet CDN the LFS blob
   redirects to; allow `*.hf.co`). Neither is in `DEFAULT_ALLOWED_HOSTS`, so a
   nested/locked-down server must have them allowed first.
2. Run a title with the shipped invocation:

   ```sh
   llama-completion -m <model>.gguf --jinja -st \
     -sys "You write concise, specific titles for a developer tool's worktree list." \
     -p "Write a short, specific title (3 to 6 words) … Reply with ONLY the title …

   <first message>" \
     -n 32 --temp 0 --no-display-prompt --simple-io
   ```

3. Judge the output as-is (after stripping the `[end of text]` marker and
   wrapping quotes) — that is what the sidebar shows.

The exact GGUF files, the verbatim prompts, and the full per-model
outputs from all three rounds are below.

## Models tested (exact GGUF files)

Every file was fetched from `https://huggingface.co/<repo>/resolve/main/<file>`.


**Round 1 — family sweep**

| key | repo | file |
|---|---|---|
| `flan-t5-small` | `Felladrin/gguf-flan-t5-small` | `flan-t5-small.Q8_0.gguf` |
| `flan-t5-base` | `Felladrin/gguf-flan-t5-base` | `flan-t5-base.Q8_0.gguf` |
| `flan-t5-large` | `Felladrin/gguf-flan-t5-large` | `flan-t5-large.Q8_0.gguf` |
| `smollm2-360m` | `bartowski/SmolLM2-360M-Instruct-GGUF` | `SmolLM2-360M-Instruct-Q8_0.gguf` |
| `qwen2.5-0.5b` | `bartowski/Qwen2.5-0.5B-Instruct-GGUF` | `Qwen2.5-0.5B-Instruct-Q8_0.gguf` |
| `llama3.2-1b` | `bartowski/Llama-3.2-1B-Instruct-GGUF` | `Llama-3.2-1B-Instruct-Q4_K_M.gguf` |
| `qwen2.5-1.5b` | `bartowski/Qwen2.5-1.5B-Instruct-GGUF` | `Qwen2.5-1.5B-Instruct-Q4_K_M.gguf` |


**Round 2 — smaller / quantized**

| key | repo | file |
|---|---|---|
| `qwen2.5-0.5b-Q8` | `bartowski/Qwen2.5-0.5B-Instruct-GGUF` | `Qwen2.5-0.5B-Instruct-Q8_0.gguf` |
| `qwen2.5-0.5b-Q5KM` | `bartowski/Qwen2.5-0.5B-Instruct-GGUF` | `Qwen2.5-0.5B-Instruct-Q5_K_M.gguf` |
| `qwen2.5-0.5b-Q4KM` | `bartowski/Qwen2.5-0.5B-Instruct-GGUF` | `Qwen2.5-0.5B-Instruct-Q4_K_M.gguf` |
| `qwen3-0.6b-Q4KM` | `unsloth/Qwen3-0.6B-GGUF` | `Qwen3-0.6B-Q4_K_M.gguf (system + user suffixed "/no_think")` |
| `gemma3-270m-Q8` | `unsloth/gemma-3-270m-it-GGUF` | `gemma-3-270m-it-Q8_0.gguf (no system role)` |
| `gemma3-270m-Q4KM` | `unsloth/gemma-3-270m-it-GGUF` | `gemma-3-270m-it-Q4_K_M.gguf (no system role)` |
| `lfm2-350m-Q8` | `LiquidAI/LFM2-350M-GGUF` | `LFM2-350M-Q8_0.gguf` |
| `lfm2-350m-Q4KM` | `LiquidAI/LFM2-350M-GGUF` | `LFM2-350M-Q4_K_M.gguf` |


**Round 3 — size reduction**

| key | repo | file |
|---|---|---|
| `qwen2.5-0.5b-Q5KM` | `bartowski/Qwen2.5-0.5B-Instruct-GGUF` | `Qwen2.5-0.5B-Instruct-Q5_K_M.gguf` |
| `qwen2.5-0.5b-Q4KS` | `bartowski/Qwen2.5-0.5B-Instruct-GGUF` | `Qwen2.5-0.5B-Instruct-Q4_K_S.gguf` |
| `qwen2.5-0.5b-IQ4XS` | `bartowski/Qwen2.5-0.5B-Instruct-GGUF` | `Qwen2.5-0.5B-Instruct-IQ4_XS.gguf` |
| `qwen2.5-0.5b-Q3KXL` | `bartowski/Qwen2.5-0.5B-Instruct-GGUF` | `Qwen2.5-0.5B-Instruct-Q3_K_XL.gguf` |
| `danube3-500m-Q5KM` | `bartowski/h2o-danube3-500m-chat-GGUF` | `h2o-danube3-500m-chat-Q5_K_M.gguf (no system role)` |
| `danube3-500m-Q4KM` | `bartowski/h2o-danube3-500m-chat-GGUF` | `h2o-danube3-500m-chat-Q4_K_M.gguf (no system role)` |
| `smollm2-360m-Q5KM` | `bartowski/SmolLM2-360M-Instruct-GGUF` | `SmolLM2-360M-Instruct-Q5_K_M.gguf` |


## Appendix — full prompts and per-model outputs

Each block is the verbatim first message fed to the models, then every
model's full (uncondensed) title output, with wall-clock time (6 threads on
the test box). Prompts are shared across all three rounds.


### Round 1

#### `real-marquee` — long/real _(current model returned 'x row')_

Prompt:
```text
can we make the worktree title extend the full width of the sidebar, unless the row is hovered over and then the x can take precedence (currently it always leaves room for the x). also, when hovered, can we do a marquee effect to view the entire title as it scrolls by
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `flan-t5-small` | 1142 | x row |
| `flan-t5-base` | 3265 | Can we make the worktree title extend the full width of the sidebar? |
| `flan-t5-large` | 11258 | Can we make the worktree title extend the full width of the sidebar? |
| `smollm2-360m` | 9254 | Sidebar Width and Hovered Hover Effects |
| `qwen2.5-0.5b` | 3055 | Extend Sidebar Title |
| `llama3.2-1b` | 5270 | Sidebar Title Extends on Hover |
| `qwen2.5-1.5b` | 4052 | Sidebar Worktree Titles: Full Width Hover Marquee |

#### `real-larger-models` — long/real _(this very request)_

Prompt:
```text
can we try some slightly larger models for row naming via llama.cpp, then choose one that consistently picks better names for worktrees than the current model? in particular, we want longer prompts, or more obscure prompts, to not produce relatively uninformative or irrelevant titles
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `flan-t5-small` | 4827 | ''Case naming'': ''C |
| `flan-t5-base` | 818 | Row Name Models |
| `flan-t5-large` | 3360 | llama.cpp: row naming |
| `smollm2-360m` | 13119 | Can we try some slightly larger models for row naming via llama.cpp, then choose one that consistently picks better |
| `qwen2.5-0.5b` | 2259 | Experimenting with Larger Models for Worktree Naming |
| `llama3.2-1b` | 3761 | Llama Model Expansion |
| `qwen2.5-1.5b` | 3517 | Model Evaluation: Larger Inputs for Better Worktree Titles |

#### `real-usage-popover` — long/real _(user-reported bad title)_

Prompt:
```text
can you build a usage readout / detail popover into yaac. Let's start with just global usage towards our plan limits, if we are on a subscription plan and that is queryable somehow
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `flan-t5-small` | 4509 | Yaac: a yaac 's |
| `flan-t5-base` | 3346 | Yaac usage readout / detail popover |
| `flan-t5-large` | 4352 | Can you build a usage readout / detail popover into YA |
| `smollm2-360m` | 6475 | Usage Readout / Plan Limits Popover |
| `qwen2.5-0.5b` | 2934 | Yaac Usage Readout |
| `llama3.2-1b` | 3959 | Can Build Usage Readout Detail Popover |
| `qwen2.5-1.5b` | 4286 | Yaac Global Usage Readout & Plan Limits Query |

#### `long-egress-carveout` — long/obscure

Prompt:
```text
the blanket 5000/8443 session-egress allow rule is too broad; scope it to the session's own per-project registry and vcluster apiserver instead, and lean on Cilium's union-of-allows so we don't regress the nested case. verify with the host-side registry and vcluster e2e rather than nested.
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `flan-t5-small` | 986 | 5000/8443 session-egress allow rule is too broad |
| `flan-t5-base` | 1739 | Cilium vcluster e2e: a re |
| `flan-t5-large` | 3040 | 5000/8443 session-egress allow rule |
| `smollm2-360m` | 9851 | "5000/8443 Worktree Exfiltration Rule Re-Exposed: A Case for Simpl |
| `qwen2.5-0.5b` | 3390 | Cilium worktree rule optimization |
| `llama3.2-1b` | 4459 | Worktree Egress Allow Scope |
| `qwen2.5-1.5b` | 4363 | Refine Worktree Egress Rule Scope |

#### `long-title-summarizer` — long/obscure

Prompt:
```text
auto-generate worktree titles for untitled worktrees by shelling out to a pinned llama.cpp completion binary running a small quantized flan-t5 gguf in a background-loop step, persisting through setSessionTitle so a user rename always overrides, with a vocabulary guard that drops hallucinated off-topic titles
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `flan-t5-small` | 1417 | Untitled worktrees pinned to llama.cpp |
| `flan-t5-base` | 841 | Auto-generate worktree titles for untitled worktrees |
| `flan-t5-large` | 6950 | llama.cpp worktree title generator |
| `smollm2-360m` | 2268 | Worktree Titles for Untitled Worktrees |
| `qwen2.5-0.5b` | 7748 | Quantized Flan-T5 Completion by Background Loop |
| `llama3.2-1b` | 5038 | Auto-generate worktree titles for pinned llama binaries |
| `qwen2.5-1.5b` | 5831 | Auto-generate Worktree Titles for Untitled Worktrees |

#### `obscure-cilium-tproxy` — obscure/jargon

Prompt:
```text
the worktree pod's tproxy'd 443 egress SYN is getting dropped because src_valid_mark isn't set on the node; add the rp_filter/route_localnet node fixups in cluster-setup and assert the datapath in cluster-check
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `flan-t5-small` | 2269 | SYN getting dropped |
| `flan-t5-base` | 1216 | tproxy's 443 egress SYN is getting |
| `flan-t5-large` | 5466 | Fixing 443 egress SYN drop |
| `smollm2-360m` | 2721 | "Worktree Pod's Tproxy'd 443 EGPIN is Dropped: Add RpFilter/Rout |
| `qwen2.5-0.5b` | 4609 | Cluster setup fixes for dropped egress SYN on worktree pod |
| `llama3.2-1b` | 3313 | cluster-setup rp_filter_fixup cluster-check datapath |
| `qwen2.5-1.5b` | 7284 | Tproxy 443 Egress SYN Drop Fix in Cluster Setup |

#### `obscure-vcluster-hostpath` — obscure/jargon

Prompt:
```text
nested vcluster pods that need a node hostPath mount hang Pending for 60s then fail — the runNodeWritePod deadline is being swallowed by the pod guard denying node-hostPath pods; surface the server-log ms and kubectl events
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `flan-t5-small` | 3511 | vcluster pods fail to mount node-hostPath |
| `flan-t5-base` | 4463 | nested vcluster pods that need a node host |
| `flan-t5-large` | 6362 | nested vcluster pods that need a node host |
| `smollm2-360m` | 1056 | Node Host Path Mount Failure |
| `qwen2.5-0.5b` | 4008 | Nested VCluster Pods Hanging Pending for 60s |
| `llama3.2-1b` | 4003 | Pod Node HostPath Mount Issue |
| `qwen2.5-1.5b` | 5385 | Node-hostPath Pod Hangs Due to Deadline Swallowing |

#### `bug-xterm-scroll` — bug

Prompt:
```text
webapp terminals are alt-buffer tmux clients so scroll pinning is a no-op and the attach dance leaves the viewport at the wrong row; fix the attachArgs so a reattach lands at the bottom
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `flan-t5-small` | 3403 | tmux terminals reattach |
| `flan-t5-base` | 3781 | Webapp Terminals are alt-buffer tmux clients so scroll |
| `flan-t5-large` | 3164 | tmux client |
| `smollm2-360m` | 1543 | WebApp Terminals: Alt-Buffer TMux Clients and Scroll Pinning Issues |
| `qwen2.5-0.5b` | 2197 | Webapp Terminal Fix: Scroll Pinning Issue |
| `llama3.2-1b` | 3994 | Webapp Terminal Attach Issue |
| `qwen2.5-1.5b` | 3313 | Webapp Terminals: Adjust AttachArgs for Proper Pinning |

#### `feature-marquee-simple` — medium

Prompt:
```text
add a hover marquee to the sidebar worktree rows so long titles scroll into view
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `flan-t5-small` | 5983 | Speaking': 'Speaking': |
| `flan-t5-base` | 2267 | Hover marquee to sidebar worktree rows |
| `flan-t5-large` | 10144 | add a hover marquee to the sidebar worktree rows so long titles scroll |
| `smollm2-360m` | 1169 | Hover-Marquee Sidebar Titles |
| `qwen2.5-0.5b` | 4671 | Worktree List Hover Marquee |
| `llama3.2-1b` | 3666 | Worktree Title |
| `qwen2.5-1.5b` | 4076 | Hover Marquee Scroll Sidebar Titles |

#### `feature-dark-mode` — medium

Prompt:
```text
can you add a dark mode toggle to the settings page that persists the choice in localstorage and respects prefers-color-scheme on first load
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `flan-t5-small` | 2837 | scary mode toggle |
| `flan-t5-base` | 3914 | Can you add a dark mode toggle to the settings page that persists the |
| `flan-t5-large` | 2891 | dark mode |
| `smollm2-360m` | 1572 | Dark Mode Toggle for Local Storage |
| `qwen2.5-0.5b` | 3659 | Dark Mode Toggle for Settings Persistence |
| `llama3.2-1b` | 3380 | Customize Settings Toggle |
| `qwen2.5-1.5b` | 3128 | Dark Mode Toggle for LocalStorage Persistence |

#### `medium-flaky-test` — medium

Prompt:
```text
the worktree-create e2e test is flaky under podman — it sometimes races to build the base image inside the worker instead of using the prebuilt one; make it require the prebuilt image and fail fast
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `flan-t5-small` | 3838 | e2e test flaky under podman |
| `flan-t5-base` | 1490 | e2e test flaky |
| `flan-t5-large` | 6759 | worktree-create e2e test |
| `smollm2-360m` | 1380 | Worktree-Create E2E Test: Flaky Under Podman |
| `qwen2.5-0.5b` | 1919 | Worktree Create E2E Test Flaky Podman |
| `llama3.2-1b` | 5063 | Podman Image Build Test Fails |
| `qwen2.5-1.5b` | 5086 | Prebuilt Image Requirement for E2E Testing |

#### `short-fix-lint` — short

Prompt:
```text
fix the eslint errors in the server directory
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `flan-t5-small` | 1486 | eslint errors in the server directory |
| `flan-t5-base` | 1784 | eslint errors in the server directory |
| `flan-t5-large` | 9048 | fix the eslint errors in the server directory |
| `smollm2-360m` | 1303 | fixes eslint errors in server directory |
| `qwen2.5-0.5b` | 2233 | Fix ESLint Errors in Server Directory |
| `llama3.2-1b` | 3914 | Fix ESLint errors in server directory |
| `qwen2.5-1.5b` | 3158 | Fix ESLint Errors in Server Directory |

#### `short-rename` — short

Prompt:
```text
rename the getDataDir helper to resolveDataDir everywhere
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `flan-t5-small` | 1446 | GetDataDir Helper to resolve DataDir everywhere |
| `flan-t5-base` | 5250 | rename getDataDir helper to resolve DataDir |
| `flan-t5-large` | 1659 | getDataDir helper |
| `smollm2-360m` | 1337 | Resolve Data Directory for the getDataDir helper |
| `qwen2.5-0.5b` | 1719 | Rename getDataDir to resolveDataDir |
| `llama3.2-1b` | 4061 | resolveDataDir helper for file paths |
| `qwen2.5-1.5b` | 3470 | Rename getDataDir to resolveDataDir for consistency |

#### `medium-registry` — medium

Prompt:
```text
mirror the digest-pinned registry:2 upstream image into the local registry during global test setup so per-project registries can pull it offline
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `flan-t5-small` | 3106 | 'Standard': 'Standard': |
| `flan-t5-base` | 4444 | mirrored registries:2 upstream image |
| `flan-t5-large` | 4081 | mirror digest-pinned registry:2 upstream image into local registry during global test |
| `smollm2-360m` | 1978 | Mirror the Digest-Pinned Registry |
| `qwen2.5-0.5b` | 1612 | Mirror digest-pinned registry:2 to local registry during global test setup |
| `llama3.2-1b` | 3519 | Create a local registry mirror |
| `qwen2.5-1.5b` | 3006 | Mirror Digest-Pinned Registry:2 Image to Local Registry |

#### `obscure-oauth-chain` — obscure/jargon

Prompt:
```text
a nested server seeded with a fake api-key fixture forces x-api-key mode which can't chain through the outer oauth proxy, giving Invalid API key; seed it with oauth creds instead and restart the worktree
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `flan-t5-small` | 1838 | neted server seeded with fake API key |
| `flan-t5-base` | 6726 | a nested server seeded with a fake |
| `flan-t5-large` | 1660 | x-api-key mode |
| `smollm2-360m` | 3905 | Seeded with Fake API Key Fixture, Forces OAuth Mode, Invalid API Key |
| `qwen2.5-0.5b` | 1544 | Nested Server OAuth Mode |
| `llama3.2-1b` | 3927 | API Key Issue with OAuth Proxy |
| `qwen2.5-1.5b` | 3210 | Fix API Key Issue with Nested Server |

#### `long-remote-hosting` — long/obscure

Prompt:
```text
sketch the remote-hosting architecture where a local install is just a remote with a local server: an auth-only server runs on the user machine over an outbound websocket, Safari can't reach browser-to-loopback so we tunnel, and there's a single remote.json rather than a contexts list
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `flan-t5-small` | 828 | Remote-hosting architecture for local install |
| `flan-t5-base` | 3805 | Remote-Hosted Architecture |
| `flan-t5-large` | 7170 | Remote-hosting architecture |
| `smollm2-360m` | 2458 | Secure Local Install with Remote Hosting |
| `qwen2.5-0.5b` | 2936 | Remote-Hosted Websocket Authentication |
| `llama3.2-1b` | 3888 | Remote Host Architecture Overview |
| `qwen2.5-1.5b` | 4677 | Remote-Host Architecture: Local Server via WebSocket, Safari Tunnel, Single Remote.json |


### Round 2

#### `real-marquee` — long/real _(current model returned 'x row')_

Prompt:
```text
can we make the worktree title extend the full width of the sidebar, unless the row is hovered over and then the x can take precedence (currently it always leaves room for the x). also, when hovered, can we do a marquee effect to view the entire title as it scrolls by
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q8` | 1618 | Extend Sidebar Title |
| `qwen2.5-0.5b-Q5KM` | 2212 | Extend Sidebar Title with Hover |
| `qwen2.5-0.5b-Q4KM` | 2143 | Extend Sidebar Title |
| `qwen3-0.6b-Q4KM` | 4115 | Extend Sidebar Title with Marquee |
| `gemma3-270m-Q8` | 6674 | Can we make the worktree title extend the full width of the sidebar, unless the row is hovered over and then the x can take precedence (currently it always leaves room for the x). also, when |
| `gemma3-270m-Q4KM` | 9266 | Here are a few options: |
| `lfm2-350m-Q8` | 2895 | Can we make worktree title sidebar full width on hover? Can we add a marquee effect for scrolling view? |
| `lfm2-350m-Q4KM` | 1686 | ONLYTITLE: Sidebar Width Control & Marquee Effect |

#### `real-larger-models` — long/real _(this very request)_

Prompt:
```text
can we try some slightly larger models for row naming via llama.cpp, then choose one that consistently picks better names for worktrees than the current model? in particular, we want longer prompts, or more obscure prompts, to not produce relatively uninformative or irrelevant titles
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q8` | 1967 | Experimenting with Larger Models for Worktree Naming |
| `qwen2.5-0.5b-Q5KM` | 1415 | Experimenting with Larger Models for Worktree Naming via llama.cpp |
| `qwen2.5-0.5b-Q4KM` | 5351 | Llama 2 Worktree Naming Optimization |
| `qwen3-0.6b-Q4KM` | 5024 | Try larger row naming models with llama.cpp, prioritize consistent worktree naming over current model |
| `gemma3-270m-Q8` | 3794 | Can we try some slightly larger models for row naming via llama.cpp, then choose one that consistently picks better names for worktrees than the current model? |
| `gemma3-270m-Q4KM` | 2464 | [] |
| `lfm2-350m-Q8` | 5640 | LONG SESSION NAME TITLE: LAMBDA MODEL NAME IMPROVEMENT |
| `lfm2-350m-Q4KM` | 2345 | Larger Model Performance: Larger Worktree Names |

#### `real-usage-popover` — long/real _(user-reported bad title)_

Prompt:
```text
can you build a usage readout / detail popover into yaac. Let's start with just global usage towards our plan limits, if we are on a subscription plan and that is queryable somehow
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q8` | 1856 | Yaac Usage Readout |
| `qwen2.5-0.5b-Q5KM` | 2774 | Yaac Usage Readout / Detail Popover |
| `qwen2.5-0.5b-Q4KM` | 3918 | Yaac Usage Readout / Detail Popover |
| `qwen3-0.6b-Q4KM` | 4475 | Build usage readout / detail popover into YaAC |
| `gemma3-270m-Q8` | 5964 | Can you build a usage readout / detail popover into yaac. Let's start with just global usage towards our plan limits, if we are on a subscription plan and that is queryable somehow |
| `gemma3-270m-Q4KM` | 4489 | Okay, I understand. I will create a title for the usage readout, focusing on global usage, and then provide a brief description of the key points |
| `lfm2-350m-Q8` | 4258 | Usage Readout: Global YAC Usage Detailed Popover |
| `lfm2-350m-Q4KM` | 2913 | Usage Readout: Global Plan Limit Usage |

#### `long-egress-carveout` — long/obscure

Prompt:
```text
the blanket 5000/8443 session-egress allow rule is too broad; scope it to the session's own per-project registry and vcluster apiserver instead, and lean on Cilium's union-of-allows so we don't regress the nested case. verify with the host-side registry and vcluster e2e rather than nested.
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q8` | 2782 | Cilium worktree rule optimization |
| `qwen2.5-0.5b-Q5KM` | 3093 | Worktree List: Narrow Scope to Per-Project Registry and VCluster APIservers |
| `qwen2.5-0.5b-Q4KM` | 2593 | Cilium worktree rule optimization |
| `qwen3-0.6b-Q4KM` | 8123 | session-egress-allow-broadening |
| `gemma3-270m-Q8` | 11311 | The blanket 5000/8443 session-egress allow rule is too broad; scope it to the session's own per-project registry and vcluster apiserver |
| `gemma3-270m-Q4KM` | 1407 | **The Blanket Policy** |
| `lfm2-350m-Q8` | 2695 | ONLY BROAD SESSION-EGRISSES FOR CILIUM REGISTRY AND VCLUSTER APISERVER |
| `lfm2-350m-Q4KM` | 1636 | ONLY_BROAD_SESSION_REGISTRY |

#### `long-title-summarizer` — long/obscure

Prompt:
```text
auto-generate worktree titles for untitled worktrees by shelling out to a pinned llama.cpp completion binary running a small quantized flan-t5 gguf in a background-loop step, persisting through setSessionTitle so a user rename always overrides, with a vocabulary guard that drops hallucinated off-topic titles
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q8` | 3714 | Quantized Flan-T5 Completion by Background Loop |
| `qwen2.5-0.5b-Q5KM` | 4565 | Pinched Completion: Auto-Generate Worktree Titles |
| `qwen2.5-0.5b-Q4KM` | 3093 | PinLlamaCompletionSessionTitle |
| `qwen3-0.6b-Q4KM` | 17370 | 1. "Renaming in Progress" |
| `gemma3-270m-Q8` | 2091 | **llama-cpp-5-worktree-title** |
| `gemma3-270m-Q4KM` | 5503 | **Title:** |
| `lfm2-350m-Q8` | 2362 | auto-generate-worktree-title-1 |
| `lfm2-350m-Q4KM` | 1479 | auto-generate-session-titles-1 |

#### `obscure-cilium-tproxy` — obscure/jargon

Prompt:
```text
the worktree pod's tproxy'd 443 egress SYN is getting dropped because src_valid_mark isn't set on the node; add the rp_filter/route_localnet node fixups in cluster-setup and assert the datapath in cluster-check
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q8` | 3234 | Cluster setup fixes for dropped egress SYN on worktree pod |
| `qwen2.5-0.5b-Q5KM` | 1857 | Worktree Pod Tproxy Issues: Fixup Node Configuration |
| `qwen2.5-0.5b-Q4KM` | 3806 | Cluster setup fixups for dropping worktree pod's egress SYN |
| `qwen3-0.6b-Q4KM` | 14765 | worktree pod tproxy 443 egress SYN dropped due to src_valid_mark missing; apply rp_filter/route_localnet fixups in cluster-setup and assert datapath in |
| `gemma3-270m-Q8` | 6410 | The worktree pod's tproxy'd 443 egress SYN is getting dropped because src_valid_mark isn't set on the node; add the rp_filter/route_ |
| `gemma3-270m-Q4KM` | 4761 | **Cluster-setup-tproxy-ed-443-egress-syn-error-drop** |
| `lfm2-350m-Q8` | 2497 | Add rp_filter/route_localnet node fixes and assert datapath in cluster-check |
| `lfm2-350m-Q4KM` | 2116 | ONLY RP_FILTER/route_localnet node fixes required |

#### `obscure-vcluster-hostpath` — obscure/jargon

Prompt:
```text
nested vcluster pods that need a node hostPath mount hang Pending for 60s then fail — the runNodeWritePod deadline is being swallowed by the pod guard denying node-hostPath pods; surface the server-log ms and kubectl events
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q8` | 3357 | Nested VCluster Pods Hanging Pending for 60s |
| `qwen2.5-0.5b-Q5KM` | 3744 | Nested vCluster Pods Hanging Pending for 60s and Fail - Server-Log Events |
| `qwen2.5-0.5b-Q4KM` | 2169 | Nested VCluster Pods Hanging Pending for 60s |
| `qwen3-0.6b-Q4KM` | 13788 | nested vcluster pods that need a node hostPath mount hang pending for 60s then fail — runNodeWritePod deadline is being swallowed by pod guard |
| `gemma3-270m-Q8` | 4397 | Node-hostPath Pods |
| `gemma3-270m-Q4KM` | 2361 | **RunNodeWritePod Deadline** |
| `lfm2-350m-Q8` | 1201 | nested vcluster pods failing due to node-hostPath mount blockage |
| `lfm2-350m-Q4KM` | 3676 | nested vcluster pods mount node-hostPath fail after 60s due to pod guard |

#### `bug-xterm-scroll` — bug

Prompt:
```text
webapp terminals are alt-buffer tmux clients so scroll pinning is a no-op and the attach dance leaves the viewport at the wrong row; fix the attachArgs so a reattach lands at the bottom
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q8` | 2332 | Webapp Terminal Fix: Scroll Pinning Issue |
| `qwen2.5-0.5b-Q5KM` | 1791 | Webapp Terminals: Fix Attach Behavior |
| `qwen2.5-0.5b-Q4KM` | 3750 | Webapp Terminals: Scroll Pinning Issue |
| `qwen3-0.6b-Q4KM` | 6801 | webapp-attach-dance-fixed |
| `gemma3-270m-Q8` | 10503 | webapp terminals are alt-buffer tmux clients so scroll pinning is a no-op and the attach dance leaves the viewport at the wrong row; fix the attachArgs so a reattach lands at the bottom |
| `gemma3-270m-Q4KM` | 3283 | webapp terminals are alt-buffer tmux clients so scroll pinning is a no-op and the attach dance leaves the viewport at the wrong row; fix the attachArgs so a reattach lands at the bottom |
| `lfm2-350m-Q8` | 1385 | Webapp terminals issues with pinning and attach arguments |
| `lfm2-350m-Q4KM` | 2457 | webapp terminals issue no-op scroll pinning and attach dance |

#### `feature-marquee-simple` — medium

Prompt:
```text
add a hover marquee to the sidebar worktree rows so long titles scroll into view
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q8` | 3836 | Worktree List Hover Marquee |
| `qwen2.5-0.5b-Q5KM` | 2794 | Worktree List Hover Marquee |
| `qwen2.5-0.5b-Q4KM` | 3947 | Worktree Titles Scroll Into View |
| `qwen3-0.6b-Q4KM` | 5117 | Add hover marquee to sidebar worktree rows |
| `gemma3-270m-Q8` | 5417 | Here's a title: |
| `gemma3-270m-Q4KM` | 872 | [] |
| `lfm2-350m-Q8` | 1913 | Add hover marquee to all worktree rows for long titles to scroll |
| `lfm2-350m-Q4KM` | 1754 | Add Hover Marquee to Sidebar Worktree Rows for Long Titles |

#### `feature-dark-mode` — medium

Prompt:
```text
can you add a dark mode toggle to the settings page that persists the choice in localstorage and respects prefers-color-scheme on first load
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q8` | 2065 | Dark Mode Toggle for Settings Persistence |
| `qwen2.5-0.5b-Q5KM` | 2022 | Dark Mode Toggle with Local Storage Persistence |
| `qwen2.5-0.5b-Q4KM` | 4613 | Dark Mode Toggle Persistence |
| `qwen3-0.6b-Q4KM` | 11681 | Add dark mode toggle to settings page that persists the choice in localstorage and respects prefers-color-scheme on first load |
| `gemma3-270m-Q8` | 2342 | Dark Mode Toggle |
| `gemma3-270m-Q4KM` | 1027 | [] |
| `lfm2-350m-Q8` | 1246 | Dark Mode Toggle Implementation |
| `lfm2-350m-Q4KM` | 2183 | DarkModeToggleAddition |

#### `medium-flaky-test` — medium

Prompt:
```text
the worktree-create e2e test is flaky under podman — it sometimes races to build the base image inside the worker instead of using the prebuilt one; make it require the prebuilt image and fail fast
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q8` | 2491 | Worktree Create E2E Test Flaky Podman |
| `qwen2.5-0.5b-Q5KM` | 4309 | Worktree Create E2E Test Flaky Podman |
| `qwen2.5-0.5b-Q4KM` | 3244 | Worktree Create E2E Test Flaky under Podman |
| `qwen3-0.6b-Q4KM` | 12208 | worktree-create e2e test is flaky under podman — it sometimes races to build the base image inside the worker instead of using the prebuilt one; make it require the |
| `gemma3-270m-Q8` | 6987 | The worktree-create e2e test is flaky under podman — it sometimes races to build the base image inside the worker instead of using the prebuilt one; make it require the prebuilt image |
| `gemma3-270m-Q4KM` | 3976 | *   **Build the Image: Podman's Flawed Base Image** |
| `lfm2-350m-Q8` | 2196 | FLAKY E2E Test - Podman Test Failures Due to Base Image Race |
| `lfm2-350m-Q4KM` | 2922 | ONCEI E2E Test Flakiness Due to Podman Build Issues |

#### `short-fix-lint` — short

Prompt:
```text
fix the eslint errors in the server directory
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q8` | 2756 | Fix ESLint Errors in Server Directory |
| `qwen2.5-0.5b-Q5KM` | 2039 | Fix ESLint errors in server directory |
| `qwen2.5-0.5b-Q4KM` | 3398 | fix-eslint-server-directory |
| `qwen3-0.6b-Q4KM` | 5890 | fix server errors |
| `gemma3-270m-Q8` | 2079 | The eslint server is a critical component of the web development ecosystem |
| `gemma3-270m-Q4KM` | 1091 | The server directory is a dangerous place to store code |
| `lfm2-350m-Q8` | 1558 | Fixes for Eslint errors in server directory |
| `lfm2-350m-Q4KM` | 2135 | Fixes for Eslint Errors in Server Directory |

#### `short-rename` — short

Prompt:
```text
rename the getDataDir helper to resolveDataDir everywhere
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q8` | 2530 | Rename getDataDir to resolveDataDir |
| `qwen2.5-0.5b-Q5KM` | 3514 | Rename getDataDir to resolveDataDir |
| `qwen2.5-0.5b-Q4KM` | 3855 | Rename `getDataDir` to `resolveDataDir` everywhere |
| `qwen3-0.6b-Q4KM` | 8806 | rename the getDataDir helper to resolveDataDir everywhere |
| `gemma3-270m-Q8` | 1280 | DataDir Helper |
| `gemma3-270m-Q4KM` | 1596 | [] |
| `lfm2-350m-Q8` | 1325 | Rename getDataDir to resolveDataDir |
| `lfm2-350m-Q4KM` | 2498 | Rename helper to resolveDataDir |

#### `medium-registry` — medium

Prompt:
```text
mirror the digest-pinned registry:2 upstream image into the local registry during global test setup so per-project registries can pull it offline
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q8` | 2721 | Mirror digest-pinned registry:2 to local registry during global test setup |
| `qwen2.5-0.5b-Q5KM` | 3358 | Mirror Digest-Pinned Registry:2 Local Registry During Global Test Setup |
| `qwen2.5-0.5b-Q4KM` | 1952 | Mirror Digest-Pinned Registry:2 to Local Registry |
| `qwen3-0.6b-Q4KM` | 25486 | <think> |
| `gemma3-270m-Q8` | 3520 | **Mirror the Digest-Pinned Registry** |
| `gemma3-270m-Q4KM` | 3309 | 1.  **Global Registry Pull:** |
| `lfm2-350m-Q8` | 1090 | Mirror upstream image to local registry during global test setup |
| `lfm2-350m-Q4KM` | 1716 | Mirror upstream image to local registry during global test setup |

#### `obscure-oauth-chain` — obscure/jargon

Prompt:
```text
a nested server seeded with a fake api-key fixture forces x-api-key mode which can't chain through the outer oauth proxy, giving Invalid API key; seed it with oauth creds instead and restart the worktree
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q8` | 1645 | Nested Server OAuth Mode |
| `qwen2.5-0.5b-Q5KM` | 2996 | Nested Server OAuth Mode |
| `qwen2.5-0.5b-Q4KM` | 2102 | Nested Server Configuration |
| `qwen3-0.6b-Q4KM` | 10742 | nested_server_seed_with_oauth_credentials |
| `gemma3-270m-Q8` | 4163 | A nested server seeded with a fake API-key fixture forces x-api-key mode which can't chain through the outer OAuth proxy, giving Invalid API key; seed it with oauth creds |
| `gemma3-270m-Q4KM` | 1184 | **A Nested Server Seeded with Fake API Key** |
| `lfm2-350m-Q8` | 4836 | Nested Server Seed Invalid API Key |
| `lfm2-350m-Q4KM` | 1532 | Nested Server Seed Invalid API Key |

#### `long-remote-hosting` — long/obscure

Prompt:
```text
sketch the remote-hosting architecture where a local install is just a remote with a local server: an auth-only server runs on the user machine over an outbound websocket, Safari can't reach browser-to-loopback so we tunnel, and there's a single remote.json rather than a contexts list
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q8` | 2257 | Remote-Hosted Websocket Authentication |
| `qwen2.5-0.5b-Q5KM` | 4898 | Remote-Hosted Websocket Authentication |
| `qwen2.5-0.5b-Q4KM` | 3731 | Remote-Hosted Websocket Authentication |
| `qwen3-0.6b-Q4KM` | 7904 | remote-hosting-architecture |
| `gemma3-270m-Q8` | 9515 | ```python |
| `gemma3-270m-Q4KM` | 1596 | **Remote-Hosting Architecture** |
| `lfm2-350m-Q8` | 5505 | Remote-hosting Architecture Title: Local Server with Safari Tunnel |
| `lfm2-350m-Q4KM` | 3704 | Remote-Hosting Architecture Title: Local Auth-Daemon Tunneling |


### Round 3

#### `real-marquee` — long/real _(current model returned 'x row')_

Prompt:
```text
can we make the worktree title extend the full width of the sidebar, unless the row is hovered over and then the x can take precedence (currently it always leaves room for the x). also, when hovered, can we do a marquee effect to view the entire title as it scrolls by
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q5KM` | 1700 | Extend Sidebar Title with Hover |
| `qwen2.5-0.5b-Q4KS` | 1737 | Extend Sidebar Title |
| `qwen2.5-0.5b-IQ4XS` | 1418 | Extend Sidebar Title with Hover Effect |
| `qwen2.5-0.5b-Q3KXL` | 1126 | Extend Sidebar Title with Marquee Effect |
| `danube3-500m-Q5KM` | 2541 | Worktree Title: [Your Title] |
| `danube3-500m-Q4KM` | 2434 | The Ultimate Guide to Worktree Listing for Developers |
| `smollm2-360m-Q5KM` | 2168 | Sidebar Width and Hovered Hover Effects |

#### `real-larger-models` — long/real _(this very request)_

Prompt:
```text
can we try some slightly larger models for row naming via llama.cpp, then choose one that consistently picks better names for worktrees than the current model? in particular, we want longer prompts, or more obscure prompts, to not produce relatively uninformative or irrelevant titles
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q5KM` | 3982 | Experimenting with Larger Models for Worktree Naming via llama.cpp |
| `qwen2.5-0.5b-Q4KS` | 2596 | Llama 2 Worktree Naming Optimization |
| `qwen2.5-0.5b-IQ4XS` | 1349 | Optimize Worktree Naming with Larger Models |
| `qwen2.5-0.5b-Q3KXL` | 1675 | Experimenting with Larger Models for Worktree Naming via llama.cpp |
| `danube3-500m-Q5KM` | 1225 | Sure, here are some suggestions for longer titles that could be used for a developer tool's worktree list: |
| `danube3-500m-Q4KM` | 4653 | Sure, here are some titles for a developer tool's worktree list that are concise, specific, and capture the main point of the request: |
| `smollm2-360m-Q5KM` | 1295 | Can we try some slightly larger models for row naming via llama.cpp, then choose one that consistently picks better names for worktrees than the current model? |

#### `real-usage-popover` — long/real _(user-reported bad title)_

Prompt:
```text
can you build a usage readout / detail popover into yaac. Let's start with just global usage towards our plan limits, if we are on a subscription plan and that is queryable somehow
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q5KM` | 1623 | Yaac Usage Readout / Detail Popover |
| `qwen2.5-0.5b-Q4KS` | 2707 | Yaac Usage Readout / Detail Popover |
| `qwen2.5-0.5b-IQ4XS` | 959 | Usage Readout and Popover |
| `qwen2.5-0.5b-Q3KXL` | 1856 | Yaac Usage Readout / Detail Popover |
| `danube3-500m-Q5KM` | 1621 | Sure, here's a concise and specific title for a developer tool's worktree list: |
| `danube3-500m-Q4KM` | 1579 | Sure, here's a concise and specific title for a developer tool's worktree list: |
| `smollm2-360m-Q5KM` | 2031 | Usage Readout: Plan Limits |

#### `long-egress-carveout` — long/obscure

Prompt:
```text
the blanket 5000/8443 session-egress allow rule is too broad; scope it to the session's own per-project registry and vcluster apiserver instead, and lean on Cilium's union-of-allows so we don't regress the nested case. verify with the host-side registry and vcluster e2e rather than nested.
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q5KM` | 3268 | Worktree List: Narrow Scope to Per-Project Registry and VCluster APIservers |
| `qwen2.5-0.5b-Q4KS` | 1351 | Cilium worktree rule optimization |
| `qwen2.5-0.5b-IQ4XS` | 1610 | Cilium worktree rule optimization |
| `qwen2.5-0.5b-Q3KXL` | 1784 | Refactor session-egress allow rule to scope to per-project registry and vcluster APIs |
| `danube3-500m-Q5KM` | 2512 | The blanket 5000/8443 session-egress allow rule is too broad; scope it to the session's own per-project registry and vcluster apiserver |
| `danube3-500m-Q4KM` | 2344 | The blanket 5000/8443 session-egress allow rule is too broad; scope it to the session's own per-project registry and vcluster apiserver |
| `smollm2-360m-Q5KM` | 4455 | Worktree-egress allow rule: too broad, scope to per-project registry, and leverage Cilium's union-of-allows for better nested case |

#### `long-title-summarizer` — long/obscure

Prompt:
```text
auto-generate worktree titles for untitled worktrees by shelling out to a pinned llama.cpp completion binary running a small quantized flan-t5 gguf in a background-loop step, persisting through setSessionTitle so a user rename always overrides, with a vocabulary guard that drops hallucinated off-topic titles
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q5KM` | 3699 | Pinched Completion: Auto-Generate Worktree Titles |
| `qwen2.5-0.5b-Q4KS` | 1210 | PinLlamaCompletionSessionTitleGenerator |
| `qwen2.5-0.5b-IQ4XS` | 954 | Pin llama.cpp completion binary for worktree titles |
| `qwen2.5-0.5b-Q3KXL` | 1135 | Quantized Flan-T5 Worktree Title Generator |
| `danube3-500m-Q5KM` | 1808 | Untitled Worktree Title: A User-Friendly Way to Rename Worktrees |
| `danube3-500m-Q4KM` | 1384 | Title: 'Worktree Title' - A concise, specific title that captures the main point of this request |
| `smollm2-360m-Q5KM` | 1737 | Worktree Titles: Auto-Generating Worktree Titles for Untitled Worktrees |

#### `obscure-cilium-tproxy` — obscure/jargon

Prompt:
```text
the worktree pod's tproxy'd 443 egress SYN is getting dropped because src_valid_mark isn't set on the node; add the rp_filter/route_localnet node fixups in cluster-setup and assert the datapath in cluster-check
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q5KM` | 3868 | Worktree Pod Tproxy Issues: Fixup Node Configuration |
| `qwen2.5-0.5b-Q4KS` | 3090 | Cluster setup fixes for dropped egress SYN traffic |
| `qwen2.5-0.5b-IQ4XS` | 1230 | Worktree pod's Tproxy'd 443 Egress SYN Drops, Fixups Required |
| `qwen2.5-0.5b-Q3KXL` | 1624 | Worktree Pod Tproxy Dropped SYN: Fixup Cluster Setup and Check |
| `danube3-500m-Q5KM` | 1285 | The worktree pod's tproxy'd 443 egress SYN is getting dropped because src_valid_mark isn't set on the node; add the rp_filter |
| `danube3-500m-Q4KM` | 1719 | The worktree pod's tproxy'd 443 egress SYN is getting dropped because src_valid_mark isn't set on the node; add the rp_filter |
| `smollm2-360m-Q5KM` | 4314 | "Worktree Pod's Tproxy'd 443 Egress SYN is Dropped: Add RpFilter/RouteLocalNet Fixups in ClusterSetup and Assert Datapath in Cluster |

#### `obscure-vcluster-hostpath` — obscure/jargon

Prompt:
```text
nested vcluster pods that need a node hostPath mount hang Pending for 60s then fail — the runNodeWritePod deadline is being swallowed by the pod guard denying node-hostPath pods; surface the server-log ms and kubectl events
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q5KM` | 3518 | Nested vCluster Pods Hanging Pending for 60s and Fail - Server-Log Events |
| `qwen2.5-0.5b-Q4KS` | 2592 | Nested VCluster Pods Hanging Pending for 60s — Deadline Being Swallowed by Pod Guard |
| `qwen2.5-0.5b-IQ4XS` | 1701 | Node HostPath Mount Hang in Nested VCluster Pods — Server-Log Events and Kubectl Logs |
| `qwen2.5-0.5b-Q3KXL` | 1193 | Nested VCluster Pods Hanging Pending for 60s and Failing — Server-Log Events and Kubectl Events |
| `danube3-500m-Q5KM` | 2377 | The request is asking for a concise, specific title that captures the main point of the request. The title should be 3 to 6 words long and should include only the title without any |
| `danube3-500m-Q4KM` | 2170 | The title for this request is "Node-HostPath Mount Hang Pending for 60s" |
| `smollm2-360m-Q5KM` | 2036 | Node Host Path Mount Failure |

#### `bug-xterm-scroll` — bug

Prompt:
```text
webapp terminals are alt-buffer tmux clients so scroll pinning is a no-op and the attach dance leaves the viewport at the wrong row; fix the attachArgs so a reattach lands at the bottom
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q5KM` | 1553 | Webapp Terminals: Fix Attach Behavior |
| `qwen2.5-0.5b-Q4KS` | 3221 | Webapp Terminals: Fix Attach Behavior |
| `qwen2.5-0.5b-IQ4XS` | 1686 | Webapp terminals: Fix attach behavior for better reattachment |
| `qwen2.5-0.5b-Q3KXL` | 2381 | Webapp Terminal Fix: Scroll Pinning Issue |
| `danube3-500m-Q5KM` | 875 | alt-buffer tmux clients |
| `danube3-500m-Q4KM` | 1214 | "The Webapp Terminals are Alt-Buffer tmux clients, so scroll pinning is a no-op, and the attach dance leaves the viewport at the wrong row. Fix the attach |
| `smollm2-360m-Q5KM` | 3235 | WebAppTerminals: Fixing AttatchArgs for Alt-Buffer TMux Clients |

#### `feature-marquee-simple` — medium

Prompt:
```text
add a hover marquee to the sidebar worktree rows so long titles scroll into view
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q5KM` | 1358 | Worktree List Hover Marquee |
| `qwen2.5-0.5b-Q4KS` | 1596 | Worktree List Hover Marquee |
| `qwen2.5-0.5b-IQ4XS` | 934 | Worktree List Hover Marquee |
| `qwen2.5-0.5b-Q3KXL` | 2875 | Enhance Sidebar Worktree Rows with Hover Marquee |
| `danube3-500m-Q5KM` | 2396 | The Ultimate Guide to Mastering Node.js Development |
| `danube3-500m-Q4KM` | 1638 | The Ultimate Guide to Developing a Successful Developer Tool |
| `smollm2-360m-Q5KM` | 3612 | Hover-Marquee Sidebar Titles |

#### `feature-dark-mode` — medium

Prompt:
```text
can you add a dark mode toggle to the settings page that persists the choice in localstorage and respects prefers-color-scheme on first load
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q5KM` | 1702 | Dark Mode Toggle with Local Storage Persistence |
| `qwen2.5-0.5b-Q4KS` | 1443 | Dark Mode Toggle for Settings |
| `qwen2.5-0.5b-IQ4XS` | 854 | Dark Mode Toggle Persistence |
| `qwen2.5-0.5b-Q3KXL` | 1315 | Dark Mode Toggle Persistence |
| `danube3-500m-Q5KM` | 2384 | Sure, here's a revised version of the prompt with a dark mode toggle: |
| `danube3-500m-Q4KM` | 3062 | Sure, here's a revised version of the title that includes a toggle for dark mode: |
| `smollm2-360m-Q5KM` | 1215 | Dark Mode Toggle for Local Storage |

#### `medium-flaky-test` — medium

Prompt:
```text
the worktree-create e2e test is flaky under podman — it sometimes races to build the base image inside the worker instead of using the prebuilt one; make it require the prebuilt image and fail fast
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q5KM` | 1602 | Worktree Create E2E Test Flaky Podman |
| `qwen2.5-0.5b-Q4KS` | 1655 | Worktree Create E2E Test Flaky under Podman |
| `qwen2.5-0.5b-IQ4XS` | 954 | Worktree Create E2E Test Flaky Podman Build Race |
| `qwen2.5-0.5b-Q3KXL` | 2167 | Worktree Create E2E Test Flaky Podman Build Race |
| `danube3-500m-Q5KM` | 1491 | The worktree-create e2e test is flaky under podman because it sometimes races to build the base image inside the worker instead of using the prebuilt one |
| `danube3-500m-Q4KM` | 2918 | The worktree-create e2e test is flaky under podman because it sometimes races to build the base image inside the worker instead of using the prebuilt one. Make it require the prebuilt |
| `smollm2-360m-Q5KM` | 2838 | Worktree-Create E2E Test: Flaky Under Podman, Require Prebuilt Image, Fail Fast |

#### `short-fix-lint` — short

Prompt:
```text
fix the eslint errors in the server directory
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q5KM` | 1321 | Fix ESLint errors in server directory |
| `qwen2.5-0.5b-Q4KS` | 1158 | fix eslint errors in server directory |
| `qwen2.5-0.5b-IQ4XS` | 1073 | Fix ESLint errors in server directory |
| `qwen2.5-0.5b-Q3KXL` | 1170 | Fix ESLint errors in the server directory |
| `danube3-500m-Q5KM` | 1701 | The Importance of Regularly Updating Your Software |
| `danube3-500m-Q4KM` | 2682 | The Importance of Regularly Updating Developer Tools |
| `smollm2-360m-Q5KM` | 1656 | fix eslint errors in server directory |

#### `short-rename` — short

Prompt:
```text
rename the getDataDir helper to resolveDataDir everywhere
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q5KM` | 1548 | Rename getDataDir to resolveDataDir |
| `qwen2.5-0.5b-Q4KS` | 1707 | Rename `getDataDir` to `resolveDataDir` everywhere |
| `qwen2.5-0.5b-IQ4XS` | 1016 | Rename `getDataDir` to `resolveDataDir` everywhere |
| `qwen2.5-0.5b-Q3KXL` | 1013 | Rename getDataDir to resolveDataDir |
| `danube3-500m-Q5KM` | 2664 | The title for this request is "Resolving Data Directories." |
| `danube3-500m-Q4KM` | 1571 | The title for this request is "Resolving Data Directories." |
| `smollm2-360m-Q5KM` | 771 | ResolveDataDir |

#### `medium-registry` — medium

Prompt:
```text
mirror the digest-pinned registry:2 upstream image into the local registry during global test setup so per-project registries can pull it offline
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q5KM` | 2718 | Mirror Digest-Pinned Registry:2 Local Registry During Global Test Setup |
| `qwen2.5-0.5b-Q4KS` | 1208 | Mirror Digest-Pinned Registry:2 to Local Registry |
| `qwen2.5-0.5b-IQ4XS` | 1562 | Mirror Digest-Pinned Registry to Local Registry |
| `qwen2.5-0.5b-Q3KXL` | 995 | Mirror Digest-Pinned Registry:2 Local Registry |
| `danube3-500m-Q5KM` | 2326 | mirror the digest-pinned registry:2 upstream image into the local registry during global test setup so per-project registries can pull it offline |
| `danube3-500m-Q4KM` | 1102 | mirror the image into the local registry during global test setup so per-project registries can pull it offline |
| `smollm2-360m-Q5KM` | 1324 | Mirror the Digest-Pinned Registry:2 Upstream Image into the Local Registry During Global Test Setup |

#### `obscure-oauth-chain` — obscure/jargon

Prompt:
```text
a nested server seeded with a fake api-key fixture forces x-api-key mode which can't chain through the outer oauth proxy, giving Invalid API key; seed it with oauth creds instead and restart the worktree
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q5KM` | 1933 | Nested Server OAuth Mode |
| `qwen2.5-0.5b-Q4KS` | 1126 | Nested Server Configuration |
| `qwen2.5-0.5b-IQ4XS` | 975 | Nested Server Configuration Error |
| `qwen2.5-0.5b-Q3KXL` | 1058 | Nested Server with Fake API-Key |
| `danube3-500m-Q5KM` | 1302 | [Nested server seeded with a fake api-key fixture forces x-api-key mode which can't chain through the outer oauth proxy, giving Invalid API key; seed it |
| `danube3-500m-Q4KM` | 838 | [Insert the title here] |
| `smollm2-360m-Q5KM` | 1542 | Seeded with Fake API Key Fixture |

#### `long-remote-hosting` — long/obscure

Prompt:
```text
sketch the remote-hosting architecture where a local install is just a remote with a local server: an auth-only server runs on the user machine over an outbound websocket, Safari can't reach browser-to-loopback so we tunnel, and there's a single remote.json rather than a contexts list
```

| model (GGUF key) | ms | title output |
|---|---|---|
| `qwen2.5-0.5b-Q5KM` | 2045 | Remote-Hosted Websocket Authentication |
| `qwen2.5-0.5b-Q4KS` | 1647 | Remote-Hosted Websocket Authentication |
| `qwen2.5-0.5b-IQ4XS` | 1033 | Remote-hosting architecture with WebSocket-based authentication |
| `qwen2.5-0.5b-Q3KXL` | 1029 | Remote-Hosted Websocket Authentication |
| `danube3-500m-Q5KM` | 2427 | [Remote-hosting architecture where a local install is just a remote with a local server: an auth-only server runs on the user machine over an outbound websocket, Safari |
| `danube3-500m-Q4KM` | 2119 | "Remote-hosting architecture for a local install where a local server runs over an outbound websocket, Safari can't reach browser-to-loopback, and there's |
| `smollm2-360m-Q5KM` | 1440 | Secure Local Install with Remote-Hosting Architecture |

