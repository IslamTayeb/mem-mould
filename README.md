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

The plugin is not packaged yet. For local testing, link the source files into a project's OpenCode plugin directory:

```sh
mkdir -p .opencode/plugins
ln -s /path/to/mem-mould/src/server-plugin.ts .opencode/plugins/context-map.ts
ln -s /path/to/mem-mould/src/tui-plugin.tsx .opencode/plugins/context-map-tui.tsx
```

Then add `.opencode/tui.json`:

```json
{
  "plugin": ["./plugins/context-map-tui.tsx"]
}
```

## Development

```sh
npm run typecheck
npm test
npm run validate:sandbox
npm run validate:long-session
```

Live validation and benchmarks require an OpenCode-accessible model:

```sh
export MEM_MOULD_E2E_MODEL="<provider>/<model>"
```

## Repo Shape

- `src/`: plugin code.
- `test/`: unit tests.
- `tools/`: validation, fixture generation, inspection, and artifact export scripts.
- `benchmarks/`: benchmark harnesses.
- `artifacts/benchmark-runs/`: curated exported benchmark evidence.
- `fixtures/`: small seeded demo/validation data.

Sideband context maps are written to `~/.opencode/context-maps/<session-id>.json`.
