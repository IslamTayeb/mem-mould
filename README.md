# mem-mould

Context map plugin for [OpenCode](https://opencode.ai). Makes the LLM's context window visible, controllable, and navigable.

## What it does

Every time the agent responds, the plugin silently annotates the response with topic metadata -- which topic ("blob") this message belongs to, a running summary, and key facts. This builds a **context map** in a sideband JSON file, without touching the conversation itself.

You can then:
- **See** what's in context (sidebar bar + `/mem-map` dialog)
- **Control** what stays in context (set topics to Full, Summary, Compressed, Placeholder, or Drop)
- **Control individual messages** (hide, force full, force summary)
- **Navigate old sessions** via git blame (`/blame src/auth.ts:42`)

The agent also has tools to inspect and manage the map itself (`context_map`, `compress_blob`, `drop_blob`, `session_lookup`, `session_zoom`, `blame_lookup`), but your choices always take priority over the agent's.

## How it works

```
You send a message
  -> Plugin injects annotation instructions into system prompt
  -> Plugin applies your fidelity choices to the message history
  -> Model responds normally, appends a hidden <annotation> block
  -> Plugin strips the annotation, saves it to sideband JSON
  -> You see the clean response
  -> Sideband map updates (new blob, updated summary, key facts)

You open /mem-map
  -> See topics, token estimates, fidelity levels
  -> Change fidelity per topic or per message
  -> Changes take effect on the next model call
```

## Fidelity levels

These control how much of a topic the model actually sees:

| Level | What the model gets | When to use |
|---|---|---|
| **Full** | Every message verbatim | Active work |
| **Summary** | Each message replaced by its one-line summary | Finished work you might reference |
| **Compressed** | One paragraph for the whole topic | Background context |
| **Placeholder** | One-line stub + key facts | Distant context, navigable via zoom |
| **Drop** | Nothing | Dead ends, noise |

Per-message controls:
- **Auto** (default): follows whatever the topic's fidelity is set to
- **Full**: always keep this message verbatim regardless of topic fidelity
- **Summary**: always replace with summary regardless of topic fidelity
- **Hide**: remove from context entirely

## Quick start

### 1. Set up a test environment

```sh
npm run setup:test-env
```

This creates a disposable demo repo with seeded sessions, commit mappings, and the plugin pre-wired. It prints a launch script path. Run it:

```sh
"/path/printed/by/setup/open-test-env.sh"
```

### 2. Try the basics

Once OpenCode opens:

1. Chat normally for a few turns on different topics
2. Open the context map: type `/mem-map` in the prompt, or press `<leader>'`, or `ctrl+p` and search "context map"
3. Navigate with `j`/`k`, switch tabs with `tab`
4. Set a topic to Compressed with `3`, or Placeholder with `4`
5. Switch to the Messages tab and hide a noisy message with `x`
6. Close with `q` and keep chatting -- your choices persist

### 3. Try blame lookup

If using the seeded test repo:

```
/blame src/auth/rate_limiter.ts:42
```

This resolves the git blame to a historical session, shows the topic map, and lets you zoom in with `1`/`2`/`3`.

## Keyboard reference

### /mem-map dialog

| Key | Topics tab | Messages tab |
|---|---|---|
| `j`/`k` | Move selection | Move selection |
| `tab` | Switch to Messages | Switch to Topics |
| `1`-`5` | Set fidelity (Full/Summary/Compressed/Placeholder/Drop) | -- |
| `x` | -- | Toggle hide |
| `a` | -- | Set to Auto (follow topic) |
| `f` | -- | Force full |
| `s` | -- | Force summary |
| `q` | Close | Close |

### /blame dialog

| Key | Action |
|---|---|
| `j`/`k` | Move between topics |
| `1`/`2`/`3` | Zoom: Placeholder / Compressed / Full |
| `q` | Close |

## Agent tools

The agent has these tools available (registered by the server plugin):

| Tool | Purpose |
|---|---|
| `context_map` | Inspect the current map |
| `compress_blob` | Change a topic's fidelity (respects your overrides) |
| `drop_blob` | Remove a topic from context |
| `session_lookup` | Search historical sessions by keyword |
| `session_zoom` | Zoom into a historical topic at compressed or full fidelity |
| `blame_lookup` | Map file:line via git blame to a historical session |

Your fidelity choices are always authoritative. The agent cannot override them without explicitly using `force`.

## Installing on a real project

The plugin is not auto-loaded. To enable it on a project:

```sh
mkdir -p .opencode/plugins
ln -s /path/to/mem-mould/src/context-map/server-plugin.ts .opencode/plugins/context-map.ts
ln -s /path/to/mem-mould/src/context-map/tui-plugin.tsx .opencode/plugins/context-map-tui.tsx
```

Then add `.opencode/tui.json`:

```json
{
  "plugin": ["./plugins/context-map-tui.tsx"]
}
```

To disable, remove the symlinks and the tui.json entry.

## Development

```sh
npm install
npm run typecheck          # type check
npm test                   # unit tests
npm run validate:sandbox   # end-to-end plugin validation
npm run validate:long-session  # 12-turn mixed-topic session
npm run evaluate:compaction    # map-guided vs default compaction
npm run setup:test-env     # create disposable manual test repo
```

## Project structure

```
src/context-map/
  types.ts           # Sideband JSON schema and annotation types
  storage.ts         # Read/write context map and commit map files
  core.ts            # Annotation parsing, fidelity transforms, map operations
  git.ts             # Git hook installation for commit-to-session mapping
  server-plugin.ts   # Server plugin (hooks + tools)
  tui-plugin.tsx     # TUI plugin (sidebar + /mem-map + /blame)
```

Sideband data lives at `~/.opencode/context-maps/<session-id>.json`.
