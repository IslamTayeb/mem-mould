# Blame Recall Benchmark

This benchmark asks why a specific blamed line exists. It compares code-only lookup, transcript-oriented RLM baselines, session search, and blame-linked decant recall.

## Fixtures

- `blame-helpful-ttl-cap`: explains a 30 second presence TTL cap from a prior session rationale.
- `blame-correction-retry-cap`: explains why a stale 7-attempt payment retry plan was corrected to 4 attempts.

## Conditions

- `code-only`: repository files and git metadata only.
- `rlm-transcript-search`: static transcript corpus with `glob`/`grep`/`read`.
- `rlm-repl`: static transcript corpus through `node recall/rlm.mjs`.
- `decant-session-lookup`: decant session tools without blame routing.
- `decant-blame`: `blame_lookup` routes from line to prior session.
- `decant-blame-guided-rlm`: blame routing first, optional RLM corroboration through `recall/rlm.mjs`.

## Commands

Prepare fixtures without a model:

```sh
node --import tsx benchmarks/blame-recall/run.ts --prepare-only
```

Run one smoke condition:

```sh
DECANT_E2E_MODEL=openai/gpt-5.5 node --import tsx benchmarks/blame-recall/run.ts --fixtures blame-helpful-ttl-cap --conditions decant-blame
```

Analyze an existing run:

```sh
node --import tsx benchmarks/blame-recall/run.ts --analyze-run benchmarks/blame-recall/runs/<run>
```
