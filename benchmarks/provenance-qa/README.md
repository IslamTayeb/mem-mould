# Provenance QA Benchmarks

These benchmarks test mem-mould as a low-fidelity memory and provenance layer for prior agent work. They are not coding solve-rate benchmarks.

## Run

```sh
export MEM_MOULD_E2E_MODEL="<provider>/<model>"
bun run benchmark:provenance-qa -- --prepare-only
bun run benchmark:provenance-qa
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
export MEM_MOULD_E2E_MODEL="<provider>/<model>"
bun run benchmark:provenance-blog -- --prepare-only
bun run benchmark:provenance-blog -- --conditions rlm-transcript-search,memmould-map-zoom --fixtures auth-queue-rationale
MEM_MOULD_E2E_CHILD_MODEL="<provider>/<child-model>" bun run benchmark:provenance-blog -- --conditions subagent-rlm-transcript-search,subagent-map-zoom
```

Blog fixtures cover basic rationale lookup, correction chains, false provenance, related-work reuse, sub-agent synthesis, and a `/blame`-style line-to-rationale task. The `/blame` condition only runs for fixtures with an explicit blame target.

## Conditions

- `full-transcript`: the answer prompt receives the whole synthetic prior transcript bundle. This is the expensive upper-bound baseline.
- `keyword-snippets`: the answer prompt receives naive keyword snippets with distractors. This is the cheap retrieval baseline.
- `rlm-transcript-search`: prior transcripts are stored on disk under `memory/transcripts/`; the answering agent uses RLM-style transcript search with `grep`/`read` and optional read-only `bash`.
- `subagent-rlm-transcript-search`: the parent delegates to a sub-agent, and the child uses RLM-style transcript search over transcript files.
- `memmould-map-zoom`: prior sessions are real OpenCode sessions with mem-mould enabled. The answering agent must use `session_lookup`, `session_detail`, and `message_detail`.
- `subagent-map-zoom`: the parent agent must delegate the provenance lookup to a sub-agent, then answer from the child result.
- `memmould-guided-rlm`: the answer uses mem-mould session tools first, then RLM-style transcript search in the per-run transcript corpus, then `message_detail` for final evidence.
- `subagent-memmould-guided-rlm`: the parent delegates to a hybrid child that uses mem-mould session tools plus RLM-style transcript search.
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

- Use `--out benchmarks/provenance-qa/runs/<run-name>` to name each run explicitly.
- Child-model comparisons are optional. Set `MEM_MOULD_E2E_CHILD_MODEL` only when you want sub-agents to use a different model than the parent.
- Cost is provider-dependent. The analyzer records token/cache metrics; add a separate pricing estimator if you need dollar costs.

Safety / validity notes:

- Automated benchmark runs use isolated OpenCode roots and explicit plugin config; benchmark code is not placed under `.opencode/plugins/`.
- Hybrid transcript files are generated inside the per-run worktree after real mem-mould sessions are seeded. They use real OpenCode session/message IDs for seeded sessions so the model cannot pass by citing fixture-only fact IDs.
- Bash is allowed only as an RLM-style optional tool and prompts instruct read-only use. Runs still execute in isolated benchmark worktrees, and the analyzer records `bash` call counts.
- Token/cache metrics are proxies, not measured dollar costs.

## Interpretation

Fair claim if mem-mould conditions pass:

> mem-mould can guide an agent or sub-agent to recover a prior rationale through low-fidelity session maps and selective message zoom.

Avoid claiming:

> mem-mould improves general coding-agent solve rate.
