# AGENTS.md

## Project

mem-mould is an OpenCode plugin prototype for LLM context visualization, context control, and multi-agent context coordination.

Core thesis: long-running agent sessions should expose a compact topic map. Current work can stay full, finished work can become summaries, distant topics can become placeholders, and dead ends can be dropped. When detail is needed later, the agent or user should zoom into the relevant topic instead of rereading the full transcript.

Current implementation track is TypeScript/Bun for OpenCode. Broader future system ideas may still reference Python 3.11+ research, but active product code is TypeScript.

## Current Capabilities

- Server plugin builds sideband context maps from normal OpenCode conversations.
- TUI plugin provides sidebar state, `/context`, and `/blame` flows.
- Topic fidelity levels: `Full`, `Summary`, `Compressed`, `Placeholder`, `Drop`.
- Message-level controls: inherit topic setting, force full, force summary, hide.
- Agent tools: `view_context`, `set_fidelity`, `session_lookup`, `session_detail`, `message_detail`, `blame_lookup`.
- Git/blame path links source lines to prior sessions through commit-to-session mappings.
- Sandboxed validation and benchmark scripts exercise the plugin without touching normal OpenCode state.

## Evidence And Claims

What has evidence:

- Annotation reliability: assistant turns can produce usable topic metadata while keeping visible conversation clean.
- Map navigation: models can pick relevant placeholder topics and request zoom when needed.
- Sub-agent investigation: child agents can inspect old session maps and return focused evidence.
- Context canaries: mem-mould can remove planted stale context from visible compaction summaries.
- Provenance QA: mem-mould can route an agent to prior rationale through low-fidelity maps plus selective message zoom.

Do not overclaim:

- Current SWE-bench/code-memory evidence supports context hygiene and provenance routing, not general solve-rate improvement.
- Treat token/cache metrics as diagnostics unless a benchmark README says otherwise.
- Blog/public claims should point at curated artifacts under `artifacts/benchmark-runs/`, not raw local runs.

## Repository Shape

```
mem-mould/
  AGENTS.md
  README.md                   # Simple public overview
  src/                        # OpenCode plugin source
  test/                       # Unit tests
  tools/                      # Validation, fixture, inspection, artifact utilities
  benchmarks/                 # Benchmark harnesses and benchmark docs
  artifacts/                  # Curated exported benchmark evidence
  fixtures/                   # Small seeded validation/demo data
```

`notes/` is local-only scratch/research space and is intentionally ignored. Do not stage or rely on `notes/` for public-facing documentation. If local notes exist, use them as context only.

`.opencode/`, `node_modules/`, benchmark raw `runs/`, and local references are not public repo material.

## Public Repo Posture

- Keep `README.md` stupid-simple and product/research oriented.
- Prefer benchmark-specific details in `benchmarks/*/README.md`.
- Keep `artifacts/` data-only except `artifacts/README.md`; artifact tooling belongs under `tools/artifacts/`.
- `artifacts/benchmark-runs/` is curated public evidence only. The exporter has a public allowlist so smoke/debug/candidate/superseded runs stay out of GitHub.
- Mark generated artifacts and binary fixtures in `.gitattributes` so GitHub representation stays sane.

## External References

### OpenCode Local Checkout

Path: `../opencode` relative to repo root.

Read-only. Do not modify. Useful directories:

- `packages/plugin/src/` -- plugin SDK hooks, tools, TUI references.
- `packages/opencode/src/session/` -- compaction, overflow, prompt assembly.
- `packages/opencode/src/plugin/` -- plugin loading and lifecycle.
- `packages/opencode/src/tool/` -- tool registration, task/subagent behavior.
- `packages/opencode/src/agent/` -- agent architecture.

### Links

- OpenCode plugin docs: https://opencode.ai/docs/plugins/

## Development Commands

```sh
npm install
npm run typecheck
npm test
npm run validate:sandbox
npm run validate:long-session
npm run setup:test-env
npm run artifacts:export
```

Live validation and benchmarks require an OpenCode-accessible model slug:

```sh
export MEM_MOULD_E2E_MODEL="<provider>/<model>"
```

## OpenCode Plugin Development Rules

### Isolation

- `../opencode` is read-only. Never modify that checkout.
- Do not place WIP plugin code under `.opencode/plugins/` during development.
- OpenCode auto-discovers `{plugin,plugins}/*.{ts,js}` inside any `.opencode/` directory in the project tree and loads them into sessions for that repo.
- Move plugin code to `.opencode/plugins/` only after the three pre-build validation gates pass.

### Automated Testing Via Sandboxed Headless Server

All automated testing must use an isolated `opencode serve` process so it never touches the user's normal OpenCode config, database, or sessions. Launch with:

- Temp `HOME`.
- Temp `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`.
- Temp `OPENCODE_DB` (`:memory:` or temp file).
- `OPENCODE_CONFIG_CONTENT` with explicit `file://...` plugin spec pointing at the WIP plugin source.
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` so repo-local config is not loaded.

Drive the server through the SDK: `session.create`, `session.prompt`, `session.messages`.

If provider auth is needed inside the sandbox, copy only required credentials into the temp server via `PUT /auth/{providerID}`. Do not read or mutate the user's real auth store directly.

### Validation Gates

Three manual/scripted tests should broadly pass before plugin code is placed under `.opencode/plugins/`:

- Annotation reliability: multi-turn conversation with annotation instructions; check format, blob assignment, summary quality.
- Map navigation: fake context map at placeholder level; check blob selection and zoom requests.
- Sub-agent investigation: past session map at placeholder level in a task prompt; check navigation and focused summarization.

## Editing Rules

- Prefer small, correct changes over broad rewrites.
- Preserve existing public structure unless there is a clear repo-presentation or maintenance win.
- Do not add backward-compatibility code without a concrete need.
- Prefer self-explanatory code over comments. Comments should be short and directional, used only where intent is not obvious from the code.
- Do not commit secrets, raw provider auth, local OpenCode DB roots, or raw benchmark runtime directories.
- Do not mutate user auth stores or normal OpenCode state during validation.

## Git Workflow

- Commit only when the project is in a good state: typecheck passes, tests pass, and no known broken state remains.
- Commit messages should be concise, with a body explaining what changed and why when useful.
- Do not amend or force-push unless explicitly asked.
- If the worktree is dirty, distinguish task changes from unrelated local/user changes. Do not revert unrelated changes without explicit instruction.
