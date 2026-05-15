# Artifacts

Portable benchmark artifacts live under `artifacts/benchmark-runs/`. This directory is for curated public evidence, not every local run.

Raw benchmark runs stay in `benchmarks/*/runs/` and remain ignored because they can include large OpenCode roots, SQLite databases, logs, and temporary worktrees. Export them with:

```sh
npm run artifacts:export
```

The exporter implementation lives at `tools/artifacts/export.ts`. It only exports the current public allowlist, so smoke runs, diagnostics, candidates, and superseded matrices stay out of the GitHub tree.

The exporter copies report files, charts, stats, model messages, patches, predictions, and evaluation output while skipping raw runtime state. It also normalizes old script-path references in exported text.

For code-memory and RLM-style runs, the exporter preserves only the portable memory corpus from skipped worktrees: `worktree/memory/manifest.json` and `worktree/memory/transcripts/*.md`.
