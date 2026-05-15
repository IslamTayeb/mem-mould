# Code Memory Benchmark

This benchmark tests whether prior session memory helps, hurts, or should be ignored during a coding task. It is intentionally separate from provenance QA: the primary output is a patch plus passing tests.

## Run

```sh
export MEM_MOULD_E2E_MODEL="<provider>/<model>"
bun run benchmark:code-memory -- --prepare-only
bun run benchmark:code-memory
bun run benchmark:code-memory -- --model "<provider>/<model>" --prepare-only
```

Useful options:

```sh
bun run benchmark:code-memory -- --fixtures memory-helpful-schema
bun run benchmark:code-memory -- --conditions code-only,rlm-transcript-search,memmould-only,memmould-guided-rlm
bun run benchmark:code-memory -- --combine-runs benchmarks/code-memory/runs/run-a,benchmarks/code-memory/runs/run-b --out benchmarks/code-memory/runs/combined
bun run benchmark:code-memory -- --model "<provider>/<model>" --fixtures memory-helpful-schema --conditions code-only --repeats 1
bun run benchmark:code-memory -- --repeats 3 --out benchmarks/code-memory/runs/repeats
bun run benchmark:code-memory -- --prompt-timeout-minutes 12
bun run benchmark:code-memory -- --fixtures memory-unnecessary-slug --conditions code-only --workers 4
bun run benchmark:code-memory -- --analyze-run benchmarks/code-memory/runs/<run>
bun run benchmark:code-memory -- --out benchmarks/code-memory/runs/manual
```

## Conditions

- `code-only`: no prior memory corpus and no mem-mould plugin; solve from the repository and tests.
- `rlm-transcript-search`: prior sessions are transcript files under `memory/transcripts/`; the agent may use grep/read/bash as an RLM-style memory baseline.
- `memmould-only`: prior sessions are seeded as real OpenCode sessions with mem-mould enabled; no transcript corpus is available.
- `memmould-guided-rlm`: prior sessions are seeded as real OpenCode sessions with mem-mould enabled, and a transcript corpus with real session/message IDs is also available.

## Fixtures

- `memory-unnecessary-slug`: current repo/tests fully specify the slug fix; prior memory is distractor context and should be ignored.
- `memory-helpful-schema`: visible tests cover a simple parser case, while hidden tests require a prior accepted quote-handling decision.
- `memory-harmful-refresh`: old sessions contain stale/global-mutex queue guidance, while the current task requires per-tenant refresh coalescing.
- `memory-missing-pagination`: prior sessions are related distractors; the agent should not invent provenance.
- `memory-correction-retry-cap`: stale retry-delay memory is superseded by a later accepted correction.
- `memory-synthesis-report`: hidden behavior requires preserving a parent synthesis of child-agent findings.

## Scoring

Each run records:

- public and hidden `node --test` results.
- patch bytes, expected touched files, and unexpected file edits.
- forbidden stale terms in patch/output.
- transcript reads, irrelevant reads, context-tool calls, and token/cache metrics.
- memory policy: unnecessary memory should be avoided, helpful memory should cite the relevant session/message, and harmful memory should not be cited or copied.

Fair claim if this benchmark separates conditions:

> mem-mould can act as a routing/provenance layer for coding-agent memory, helping decide when prior sessions are useful, irrelevant, or stale.

Avoid claiming:

> mem-mould generally improves coding-agent solve rate.
