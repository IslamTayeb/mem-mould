# mem-mould

mem-mould is an OpenCode plugin prototype for making an agent's context easier to see, shrink, and revisit.

The simple idea: turn a long chat into a small **context map** of topics. Active work can stay full. Old useful work can become a summary. Noise can be dropped. If the agent needs detail later, it can zoom back into the right topic instead of rereading the whole session.

## What Exists

- A server plugin that builds sideband context maps from normal OpenCode conversations.
- A TUI plugin with a sidebar, `/context`, and `/blame`.
- Topic fidelity controls: `Full`, `Summary`, `Compressed`, `Placeholder`, and `Drop`.
- Message-level controls: hide a message, force it full, or force it summarized.
- Agent tools for context inspection and historical lookup: `view_context`, `set_fidelity`, `session_lookup`, `session_detail`, `message_detail`, and `blame_lookup`.
- Sandboxed validation scripts and benchmark harnesses for testing the idea without touching normal OpenCode state.

## Why It Matters

Long-running agent sessions accumulate stale instructions, abandoned attempts, unrelated work, and old tool output. Default compaction helps fit the window, but it does not give the user or agent much control over *which* parts should stay visible.

mem-mould treats context like a map:

- keep the current task in detail.
- compress finished work.
- keep only placeholders for distant topics.
- drop dead ends.
- recover old rationale through map-guided zoom or git blame.

## What We Have Tested

- Annotation reliability: assistant turns can produce usable topic metadata without changing the visible conversation.
- Map navigation: models can choose the right placeholder topic and ask for more detail when needed.
- Sub-agent lookup: a child agent can inspect a prior session map and bring back focused evidence.
- Context canaries: mem-mould can remove planted stale context from visible compaction summaries.
- Provenance QA: mem-mould can route an agent to prior rationale through low-fidelity maps plus selective message zoom.
- SWE-bench context stress and code-memory benchmarks: current evidence is useful for context hygiene and provenance routing, not a claim of general solve-rate improvement.

Curated benchmark evidence lives in `artifacts/benchmark-runs/`. Raw local runs stay ignored under `benchmarks/*/runs/`.

## Try The Demo

```sh
npm install
npm run setup:test-env
```

The setup command prints a launch script for a disposable OpenCode test repo. Run that script, then try:

```text
/context
/blame src/auth/rate_limiter.ts:42
```

## Use In A Real Project

The plugin is not packaged yet. For local testing with a local OpenCode install, link both plugin entrypoints into the target project:

```sh
cd /path/to/target-project
mkdir -p .opencode/plugins
ln -s /path/to/mem-mould/src/server-plugin.ts .opencode/plugins/context-map.ts
ln -s /path/to/mem-mould/src/tui-plugin.tsx .opencode/plugins/context-map-tui.tsx
```

OpenCode auto-loads server plugins from `.opencode/plugins`. To load the TUI plugin too, add `.opencode/tui.json`:

```json
{
  "plugin": ["./plugins/context-map-tui.tsx"]
}
```

Start OpenCode from that target project. The plugin adds:

- Sidebar context preview.
- `/context` for topic and message fidelity controls.
- `/blame <file>:<line>` for git-blame-linked historical context.
- Agent tools: `view_context`, `set_fidelity`, `session_lookup`, `session_detail`, `message_detail`, and `blame_lookup`.

## Development

Install dependencies once:

```sh
npm install
```

Fast checks that do not require a live model:

```sh
npm run typecheck
npm test
npm run validate:blame-tui
npm run validate:blame-tui-live
npm run setup:test-env
npm run artifacts:export
```

Model-backed validations require an OpenCode-accessible model:

```sh
export MEM_MOULD_E2E_MODEL="<provider>/<model>"
npm run validate:sandbox
npm run validate:long-session
npm run evaluate:compaction
```

Benchmarks also require `MEM_MOULD_E2E_MODEL`:

```sh
export MEM_MOULD_E2E_MODEL="<provider>/<model>"
npm run benchmark:context-canaries
npm run benchmark:code-memory
npm run benchmark:provenance-qa
npm run benchmark:swebench-context
```

`benchmark:provenance-blog` can also use `MEM_MOULD_E2E_CHILD_MODEL` for child-agent runs. Raw benchmark outputs stay ignored under `benchmarks/*/runs/`; export the curated public allowlist with `npm run artifacts:export`.

## Repo Shape

- `src/`: plugin code.
- `test/`: fast unit/regression tests.
- `tools/`: validation, fixture generation, inspection, and artifact export scripts.
- `benchmarks/`: benchmark harnesses.
- `artifacts/benchmark-runs/`: curated exported benchmark evidence.
- `fixtures/`: small seeded demo/validation data.

Sideband context maps are written to `~/.opencode/context-maps/<session-id>.json`.
