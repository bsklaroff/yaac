# Workspace-title model evaluation

Why the server titles untitled workspaces with **Qwen2.5-0.5B-Instruct at
IQ4_XS** (a ~333 MB GGUF file), and how to re-check that choice. The model pin
is `TITLE_MODEL_URL` in the titles feature's `title-summarizer`. The llama.cpp
runner is its `llama-cpp` module.

## Decision

The reconcile step `reconcileGeneratedTitles` gives an untitled workspace (and
a draft or queued one) a title that summarizes its first message. It runs the
model through a pinned `llama-completion` binary, one short-lived process per
title.

The model is `Qwen2.5-0.5B-Instruct-IQ4_XS.gguf` from
`bartowski/Qwen2.5-0.5B-Instruct-GGUF`. Out of 14 model/quant combinations
tried on 16 test prompts, it was the smallest with zero bad titles, and the
fastest (about 1-3 s per title on an arm64 laptop CPU). If a llama.cpp upgrade
makes IQ4_XS worse, Q5_K_M (401 MB) is the safe fallback.

The model it replaced, `flan-t5-small`, failed on long or jargon-heavy
messages. A request about sidebar title width and a marquee effect became
`x row`. Qwen2.5-0.5B titles the same request `Extend Sidebar Title with Hover
Effect`.

## Why this model

**The model has to follow the instruction "write a title".** Size alone does
not help at this scale.

- `flan-t5-small` (80M params) looped (`'Standard': 'Standard':`), went vague
  (`SYN getting dropped`), or got it wrong (`scary mode toggle` for a dark-mode
  request). The larger flan-t5 models mostly copied the prompt back, often cut
  off mid-word.
- Every model under about 0.5B params (gemma-3-270m, LFM2-350M, SmolLM2-360M)
  and some at that size (Qwen3-0.6B, h2o-danube3-500m) copied the prompt,
  invented content, or answered conversationally (`Okay, I understand. I
  will…`).
- Llama-3.2-1B, the largest model tried, was worse than Qwen2.5-0.5B.
- Only the Qwen2.5 family wrote a usable title every time. The 0.5B model came
  close to the 1.5B one with a third of the parameters.

**Quantization is how to make it smaller, and the importance-matrix (imatrix)
quant is the best one.** Most of Qwen2.5-0.5B's file is its 151k-token
embedding table, so no quant gets it much below about 320 MB. IQ4_XS is
smaller than the plain Q4_K_S and Q4_K_M quants and gives better titles. Those
two sometimes ran words together or made things up (`Llama 2 Worktree Naming
Optimization`). IQ4_XS matched full-precision quality.

## Results

"Bad" counts titles out of 16 that looped, copied the prompt, were vague or
wrong, or added chat filler. Sizes are the Hugging Face download size.

| model | params | quant | size | bad | notes |
|---|---|---|---|---|---|
| flan-t5-small | 80M | Q8_0 | 114 MB | ~7-8 | previous model; loops, vague, wrong |
| flan-t5-base | 250M | Q8_0 | 305 MB | ~7 | copies or truncates the prompt |
| flan-t5-large | 780M | Q8_0 | 865 MB | ~6 | copies the prompt, or too terse; slow |
| SmolLM2-360M | 360M | Q8_0 / Q5_K_M | 369 / 277 MB | ~4-5 | typos, stray quotes |
| gemma-3-270m-it | 270M | Q8_0 / Q4_K_M | 278 / 241 MB | many | copies the prompt, code fences, chat filler |
| LFM2-350M | 350M | Q8_0 / Q4_K_M | 362 / 219 MB | ~half | stray capitals, `Title:` prefixes |
| h2o-danube3-500m-chat | 500M | Q5_K_M / Q4_K_M | 351 / 303 MB | many | chat filler, invented content |
| Qwen3-0.6B | 600M | Q4_K_M | 378 MB | many | copies the prompt, leaks `<think>`, slow (14-25 s) |
| Llama-3.2-1B | 1B | Q4_K_M | 785 MB | ~5 | vague and erratic |
| Qwen2.5-1.5B | 1.5B | Q4_K_M | 608 MB | 0 | best titles, but twice the size |
| Qwen2.5-0.5B | 500M | Q8_0 | 506 MB | ~0-2 | clean and specific |
| Qwen2.5-0.5B | 500M | Q5_K_M | 401 MB | 0 | same as Q8_0 |
| Qwen2.5-0.5B | 500M | Q4_K_M | 379 MB | ~2-3 | occasional run-together words or made-up content |
| Qwen2.5-0.5B | 500M | Q4_K_S | 368 MB | ~2 | same problems as Q4_K_M |
| Qwen2.5-0.5B | 500M | Q3_K_XL | 352 MB | 0 | clean, but larger and slower than IQ4_XS |
| **Qwen2.5-0.5B** | 500M | **IQ4_XS** | **333 MB** | **0** | **shipped**: smallest and fastest clean option |

The test prompts were realistic first messages: short, medium, long,
jargon-heavy, and bug reports. They included three real messages users had
reported bad titles for.

## How the server runs it

- The prompt uses the model's own chat template: `--jinja -st -sys <system> -p
  <user> --temp 0` (greedy decoding). The system prompt and the user-turn
  wrapper are in `title-summarizer` (`TITLE_SYSTEM_PROMPT`, `buildInput`).
- Output is capped at 32 tokens (`MAX_NEW_TOKENS`), enough for a descriptive
  title without truncation.
- `postProcess` strips wrapping quotes and a trailing period. The output is
  otherwise used as-is.
- `sharesVocabulary` rejects a title that shares no word of 4+ letters with the
  prompt, which catches an off-topic title. Qwen's titles reuse prompt words,
  so this rarely triggers.
- The llama.cpp release binaries need the system OpenMP library
  (`libgomp.so.1`), which the release archive does not include. `ensureLlamaCpp`
  runs the binary once to check it loads. If the library is missing on Linux,
  it downloads `libgomp1` from the distro mirror into its own cache, without
  root.

## Re-checking title quality

Re-check whenever you change the pinned llama.cpp tag (`LLAMA_CPP_TAG`) or the
model or quant. Upstream CI does not test imatrix quants, and they have broken
silently before.

1. Get the binary (`ensureLlamaCpp`) and the model (`ensureGgufModel`, which
   saves it under the server-local `models` directory). The model download
   needs outbound access to `huggingface.co` and `*.hf.co` (the download
   redirects to the `us.aws.cdn.hf.co` CDN). Neither host is in
   `DEFAULT_ALLOWED_HOSTS`, so a server whose egress goes through that
   allowlist needs both added first.
2. Run the same command the server runs. Set `LD_LIBRARY_PATH` (or
   `DYLD_LIBRARY_PATH` on macOS) to the binary's directory, since the release's
   shared libraries sit beside it:

   ```sh
   llama-completion -m <model>.gguf --jinja -st \
     -sys "You write concise, specific titles for a developer tool's session list." \
     -p "Write a short, specific title (3 to 6 words) … Reply with ONLY the title …

   <first message>" \
     -n 32 --temp 0 --no-display-prompt --simple-io
   ```

3. Judge the output after stripping the `[end of text]` marker and wrapping
   quotes. That is what the sidebar shows.
