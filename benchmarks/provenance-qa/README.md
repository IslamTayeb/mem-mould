# Provenance QA Benchmarks

These benchmarks test mem-mould as a low-fidelity memory and provenance layer for prior agent work. They are not coding solve-rate benchmarks.

## Run

```sh
MEM_MOULD_E2E_MODEL="openai/gpt-5.5" bun run benchmark:provenance-qa -- --prepare-only
MEM_MOULD_E2E_MODEL="openai/gpt-5.5" bun run benchmark:provenance-qa
```

Useful options:

```sh
bun run benchmark:provenance-qa -- --conditions memmould-map-zoom,subagent-map-zoom
bun run benchmark:provenance-qa -- --prompt-timeout-minutes 10
bun run benchmark:provenance-qa -- --analyze-run benchmarks/provenance-qa/runs/<run>
bun run benchmark:provenance-qa -- --out benchmarks/provenance-qa/runs/manual
```

## Blog Artifact Matrix

`benchmark:provenance-blog` expands the provenance QA idea into a six-fixture, blog-oriented matrix with static `analysis.json`, `analysis.md`, `analysis.csv`, `evidence.md`, and SVG chart artifacts.

```sh
MEM_MOULD_E2E_MODEL="openai/gpt-5.5" bun run benchmark:provenance-blog -- --prepare-only
MEM_MOULD_E2E_MODEL="openai/gpt-5.5" bun run benchmark:provenance-blog -- --conditions searchable-transcript,memmould-map-zoom --fixtures auth-queue-rationale
MEM_MOULD_E2E_MODEL="openai/gpt-5.5" MEM_MOULD_E2E_CHILD_MODEL="openai/gpt-5.4-mini" bun run benchmark:provenance-blog -- --conditions subagent-searchable-transcript,subagent-map-zoom
```

Blog fixtures cover basic rationale lookup, correction chains, false provenance, related-work reuse, sub-agent synthesis, and a `/blame`-style line-to-rationale task. The `/blame` condition only runs for fixtures with an explicit blame target.

## Conditions

- `full-transcript`: the answer prompt receives the whole synthetic prior transcript bundle. This is the expensive upper-bound baseline.
- `keyword-snippets`: the answer prompt receives naive keyword snippets with distractors. This is the cheap retrieval baseline.
- `searchable-transcript`: prior transcripts are stored on disk under `memory/transcripts/`; the answering agent must use `glob`, `grep`, and `read` to find evidence.
- `subagent-searchable-transcript`: the parent delegates to a sub-agent, and the child uses `glob`, `grep`, and `read` over transcript files.
- `memmould-map-zoom`: prior sessions are real OpenCode sessions with mem-mould enabled. The answering agent must use `session_lookup`, `session_detail`, and `message_detail`.
- `subagent-map-zoom`: the parent agent must delegate the provenance lookup to a sub-agent, then answer from the child result.
- `memmould-blame-lookup`: the answer starts from `blame_lookup`, then zooms through the mapped session and message evidence. This is a prototype demo path, not a product-proven claim.

## Scoring

The harness requires answer correctness, provenance correctness, and condition tool-policy correctness.

Answer correctness requires all expected rationale facts:

- per-tenant queueing.
- same-tenant duplicate refreshes coalesce/deduplicate.
- different tenants remain parallel.
- the global mutex was rejected.

Provenance correctness requires citation of the relevant session and a supporting message ID. For mem-mould conditions these are real OpenCode session/message IDs.

Tool-policy correctness requires each condition to use the intended path. For example, `memmould-map-zoom` must use `session_lookup -> session_detail -> message_detail` and must not read transcript files; `subagent-map-zoom` must delegate to the dedicated mem-mould sub-agent and the child must use the same session tools. Searchable transcript conditions must use file search/read tools and must not use mem-mould session tools.

The analyzer also records:

- forbidden distractor terms in the final answer.
- context-tool, task-tool, and `message_detail` call counts.
- `glob`/`grep` search calls, `read` calls, transcript files read, and irrelevant transcript reads.
- provider input, cache-read, output, reasoning, and cache-hit share.

## Current Blog Artifacts

- Final GPT-5.5 full matrix: `benchmarks/provenance-qa/runs/gpt55-blog-full-matrix-final`.
- GPT-5.5 parent + GPT-5.4 mini child sub-agent comparison: `benchmarks/provenance-qa/runs/gpt55-parent-gpt54mini-child-subagents`.
- `openai/gpt-5.5-mini` was not available in the tested OpenAI/OpenCode model list; `openai/gpt-5.4-mini` was the available mini baseline.
- Cost is not directly measured for these OpenAI subscription-auth runs; OpenCode reported `cost: 0`, so analysis should use token/cache metrics unless a separate pricing estimator is added.

## Interpretation

Fair claim if mem-mould conditions pass:

> mem-mould can guide an agent or sub-agent to recover a prior rationale through low-fidelity session maps and selective message zoom.

Avoid claiming:

> mem-mould improves general coding-agent solve rate.
