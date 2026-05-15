# Context Canary Benchmarks

These are cheap synthetic canaries for finding a concrete mem-mould use before spending SWE-bench budget.

The success target is not leaderboard score. A canary passes when default OpenCode/GPT shows a context-management failure and mem-mould fixes or materially improves it without breaking cache behavior.

## Run

```sh
export MEM_MOULD_E2E_MODEL="<provider>/<model>"
bun run benchmark:context-canaries -- --prepare-only
bun run benchmark:context-canaries
```

Useful options:

```sh
bun run benchmark:context-canaries -- --canaries task-switch,current-task-capsule
bun run benchmark:context-canaries -- --conditions polluted-default-compact,polluted-memmould-cache-stable-boundary-compact
bun run benchmark:context-canaries -- --prompt-timeout-minutes 10
bun run benchmark:context-canaries -- --analyze-run benchmarks/context-canaries/runs/<run>
bun run benchmark:context-canaries -- --out benchmarks/context-canaries/runs/manual
```

## Conditions

- `polluted-default-compact`: noisy unrelated coding-history prelude, forced OpenCode compaction, then the canary prompt without mem-mould.
- `polluted-memmould-cache-stable-boundary-compact`: same prelude with mem-mould enabled, explicit boundary cleanup via `view_context`/`set_fidelity`, cache-stable settings, forced compaction, then the canary prompt.

## Canaries

| Canary | Failure Mode | Pass Signal |
|---|---|---|
| `task-switch` | Old auth/docs/test work pollutes a new unrelated parser task. | Final answer and visible compaction context avoid stale auth/docs terms. |
| `stale-instruction` | Old wrong implementation direction acts like a stale instruction. | Final answer avoids mutex/queue/rollback terms and follows the new parser task. |
| `conversational-inertia` | Agent repeats old failed approaches because prior responses act like bad few-shot examples. | Final answer proposes a fresh parser plan and avoids old failed auth approaches. |
| `current-task-capsule` | After compaction, the active goal is buried under old session history. | Final answer names only the current parser task and visible compaction context is clean. |

## Scoring

The analyzer records:

- stale terms in the final assistant answer.
- stale terms in visible compaction summaries.
- current-task term hits for `csv`, `header`, and `trim`.
- context tool usage for mem-mould conditions.
- provider input, cache-read, output, reasoning, and cache-hit share.

A context-hygiene pass means both final output and visible compaction context are free of planted stale terms. Cache-hit share is reported but not treated as pass/fail until enough runs establish a stable baseline.

## Hypothesis Ledger

| ID | Hypothesis | Evidence | Canary |
|---|---|---|---|
| H1 | mem-mould helps task-switch isolation. | Task-switch interference in conversational history can degrade LLMs. | `task-switch` |
| H2 | mem-mould reduces conversational inertia from old assistant responses. | Long-context agents imitate prior responses and failed approaches. | `conversational-inertia` |
| H3 | short current-task capsules beat long histories after compaction. | Long input can hurt even with relevant evidence available. | `current-task-capsule` |
| H4 | irrelevant context is actively misleading, not just expensive. | Distractor context changes reasoning paths. | `stale-instruction` |
| H5 | cache-stable prompt shape is required for the product path. | Prompt caches require stable repeated prefixes. | all canaries |
| H6 | precise summaries/retrieval are useful; wrong context is harmful. | SWE-ContextBench shows accurate summaries help and unfiltered context can hurt. | future related-task canary |
| H7 | exploration-heavy tasks benefit more than iterative-refinement tasks. | Active compression saves tokens on exploration-heavy SWE tasks but can add overhead on refinement. | future SWE canary |
| H8 | `/blame` may be a stronger user-facing use than solve-rate lift. | Session reasoning can be retrieved without dumping full transcripts. | future blame canary |

## Interpretation

Fair claim if a canary passes:

> mem-mould helped isolate the current task from stale long-session context while preserving task quality and cache behavior.

Avoid claiming:

> mem-mould improves general coding-agent solve rate.
