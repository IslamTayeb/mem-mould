# SWE-Bench Context Stress

This is a small benchmark wrapper for the mem-mould prototype. It uses SWE-bench tasks and the official SWE-bench grader as the task substrate, but it intentionally changes the conversation condition before the task.

This is not a SWE-bench leaderboard run. It is a blog-oriented stress test for long-running coding-agent context. The current goal is to find a concrete mem-mould use case, not to prove generic SWE-bench solve-rate lift.

## Conditions

- `clean-no-plugin`: the selected model solves the SWE-bench task in a fresh OpenCode session with no mem-mould plugin.
- `polluted-default-compact`: the selected model first receives a noisy unrelated coding-history prelude, then OpenCode default compaction is forced, then the SWE-bench task is solved without mem-mould.
- `polluted-memmould-compact`: the selected model receives the same noisy prelude with mem-mould enabled, gets a chance to use `view_context` and `set_fidelity`, then compaction is forced and the SWE-bench task is solved.
- `polluted-memmould-boundary-compact`: same as mem-mould compact, but the cleanup turn declares a hard task boundary and asks old auth/docs/test blobs to be dropped.
- `polluted-memmould-cache-stable-boundary-compact`: boundary mode plus cache-stable mem-mould settings. Dynamic annotation/guidance prompts are suppressed, placeholder text/anchors are stable, compaction summaries are hidden as placeholders, and fallback-created current-task blobs stay full.

The initial comparison is `polluted-default-compact` vs `polluted-memmould-compact`. The useful follow-up comparison is now `polluted-default-compact` vs `polluted-memmould-cache-stable-boundary-compact`.

For cheaper hypothesis testing before SWE-bench runs, use `bun run benchmark:context-canaries`. The canaries target task-switch hygiene, stale-instruction defense, conversational inertia, and current-task capsule behavior.

## Run

```sh
export MEM_MOULD_E2E_MODEL="<provider>/<model>"
bun run benchmark:swebench-context -- --skip-eval
```

Useful options:

```sh
bun run benchmark:swebench-context -- --prepare-only
bun run benchmark:swebench-context -- --select-candidates --max-candidates 25
bun run benchmark:swebench-context -- --select-candidates --dataset princeton-nlp/SWE-bench_Lite --max-candidates 25
bun run benchmark:swebench-context -- --instance sympy__sympy-20590 --skip-eval
bun run benchmark:swebench-context -- --conditions polluted-default-compact,polluted-memmould-compact --skip-eval
bun run benchmark:swebench-context -- --conditions polluted-default-compact,polluted-memmould-compact --eval-runner uv
bun run benchmark:swebench-context -- --conditions polluted-memmould-cache-stable-boundary-compact --instance django__django-16560 --eval-runner uv
bun run benchmark:swebench-context -- --conditions polluted-memmould-cache-stable-boundary-compact --instance django__django-16560 --diagnostic-after-compaction --skip-eval
bun run benchmark:swebench-context -- --analyze-run benchmarks/swebench-context/runs/<run>
bun run benchmark:swebench-context -- --out benchmarks/swebench-context/runs/manual
```

If `--skip-eval` is omitted, the script tries to run the official SWE-bench harness for each generated patch. Use `--eval-runner uv` if `swebench` is not installed in the system Python:

```sh
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Lite \
  --predictions_path <prediction.jsonl> \
  --instance_ids <instance-id> \
  --max_workers 1 \
  --run_id <run-id>
```

## Requirements

- `opencode` on `PATH`.
- OpenCode provider auth for `MEM_MOULD_E2E_MODEL`, usually via `MEM_MOULD_E2E_TEMP_ROOT` pointing at an isolated authenticated root.
- Network access to GitHub and Hugging Face dataset metadata.
- Optional: Python SWE-bench harness and Docker if running official evaluation locally.

## Artifacts

Each run writes artifacts under `benchmarks/swebench-context/runs/<timestamp>/`:

- `config.json`: model, dataset, conditions, and instances.
- `summary.md`: blog-readable run summary.
- `analysis.md` / `analysis.json`: token/cache, visible stale-summary, and context-transform diagnostics.
- `conditions/<condition>/<instance>/patch.diff`: generated patch.
- `conditions/<condition>/<instance>/prediction.jsonl`: SWE-bench prediction file.
- `conditions/<condition>/<instance>/messages.json`: OpenCode session messages.
- `conditions/<condition>/<instance>/context-map.json`: mem-mould map when available.
- `conditions/<condition>/<instance>/stats.json`: tool counts, timings, patch stats, and evaluator result path.
- `candidates.md` / `candidates.json`: ranked harder-task candidates when using `--select-candidates`.

## Graded Scoring

The official SWE-bench `resolved` flag is still recorded, but this harness also parses `report.json` when available:

```text
fail_to_pass_score = FAIL_TO_PASS.success / FAIL_TO_PASS.total
regression_penalty = PASS_TO_PASS.failure / PASS_TO_PASS.total
quality_score = fail_to_pass_score - regression_penalty
```

This makes hard or partially solved tasks useful for comparison even when both conditions are not fully resolved.

## Context Diagnostics

The analyzer reads saved `messages.json`, `stats.json`, `context-map.json`, and trace files. It reports:

- provider input tokens, cache-read tokens, and cache-hit share.
- transformed raw/effective context tokens from mem-mould traces.
- whether stale auth/docs/test terms remain visible in compaction summaries.
- stale terms in patches and post-issue assistant text.

This matters because a condition can reduce transformed context while still losing provider prompt-cache reuse. Treat cache-hit share and uncached input as first-class metrics alongside SWE-bench grading.

## Hypothesis Ledger

| ID | Hypothesis | Current Status |
|---|---|---|
| H1 | mem-mould helps task-switch isolation. | Supported by stale-summary removal; needs canary win. |
| H2 | mem-mould reduces conversational inertia from old failed approaches. | Not tested yet. |
| H3 | short current-task capsules beat long histories after compaction. | Diagnostic run showed clean placeholder summary; needs repeated canaries. |
| H4 | irrelevant context is actively misleading, not just expensive. | Not tested yet. |
| H5 | cache-stable prompt shape is required. | Supported: old dynamic path collapsed cache, cache-stable path recovered it. |
| H6 | precise summaries/retrieval help; wrong context hurts. | Suggested by SWE-ContextBench; not tested in this repo yet. |
| H7 | exploration-heavy tasks benefit more than iterative-refinement tasks. | Suggested by Active Context Compression; current hard defaults were mostly floor cases. |
| H8 | `/blame` may be a clearer use than solve-rate lift. | Staged validation exists; benchmark evidence does not cover it. |

## Canary Ladder

Run these before spending more SWE-bench budget:

| Canary | Pass Signal |
|---|---|
| Task-switch hygiene | mem-mould removes visible stale auth/docs/test summaries and default does not. |
| Stale-instruction defense | mem-mould avoids old wrong implementation direction. |
| Conversational inertia | mem-mould avoids repeating old failed approaches. |
| Current-task capsule | mem-mould names only the active task after compaction. |
| Exploration-heavy SWE | mem-mould saves tokens/time with equal quality on calibrated tasks. |
| `/blame` navigation | staged map drilldown answers why a line exists with less context than full transcript search. |

## Harder Defaults

The default dataset is `SWE-bench/SWE-bench_Verified`, with a small harder starter set:

- `pydata__xarray-6992`
- `pylint-dev__pylint-4551`
- `django__django-16560`

## Interpretation

Fair claim:

> The task and pass/fail grading came from SWE-bench. I changed the pre-task context to mimic a long-running agent session and compared the same selected model with and without mem-mould.

Stronger claim only after canary evidence:

> mem-mould fixed a concrete context-management failure such as task-switch interference or stale-instruction leakage.

Avoid claiming:

> This is a leaderboard-comparable SWE-bench score.
