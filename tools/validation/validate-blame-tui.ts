import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";

import type { ContextMapFile } from "../../src/types";

const execFileAsync = promisify(execFile);

async function main() {
  const repoRoot = path.resolve(process.cwd());
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "mem-mould-blame-tui-"),
  );
  const home = path.join(tempRoot, "home");
  const data = path.join(tempRoot, "data");
  const config = path.join(tempRoot, "config");
  const state = path.join(tempRoot, "state");
  const cache = path.join(tempRoot, "cache");
  const worktree = path.join(tempRoot, "worktree");
  await Promise.all(
    [home, data, config, state, cache, worktree].map((dir) =>
      fs.mkdir(dir, { recursive: true }),
    ),
  );

  const previousHome = process.env.HOME;
  process.env.HOME = home;

  const serverPluginSpec = pathToFileURL(
    path.join(repoRoot, "src/server-plugin.ts"),
  ).href;
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: cache,
    OPENCODE_DB: path.join(tempRoot, "opencode.sqlite"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    MEM_MOULD_DISABLE_GIT_HOOK_INSTALL: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: [serverPluginSpec],
    }),
  };

  const blamedLineToken = await prepareGitFixture(worktree);
  const server = await startServer(env, worktree);
  let passed = false;

  try {
    const client = createOpencodeClient({ baseUrl: server.url });
    const session = ((
      (await client.session.create({
        directory: worktree,
        title: "Blame TUI historical session",
      })) as any
    )?.data ?? {}) as { id?: string };
    assert.ok(session.id, "failed to create historical OpenCode session");

    await writeHistoricalMap({
      home,
      worktree,
      sessionID: session.id,
      commitHash: blamedLineToken,
    });

    const module = (await import(
      pathToFileURL(path.join(repoRoot, "src/tui-plugin.tsx")).href
    )) as {
      default?: {
        tui?: (
          api: unknown,
          options?: unknown,
          meta?: unknown,
        ) => Promise<void>;
      };
    };
    const tui = module.default?.tui;
    assert.ok(tui, "failed to load TUI plugin module");

    const mock = createMockTuiApi({
      client,
      worktree,
      sessionID: session.id,
      blameInput: "src/auth/rate_limiter.ts:42",
    });
    await tui(mock.api, undefined, {
      id: "mem-mould.context-map-tui",
      source: "file",
      spec: pathToFileURL(path.join(repoRoot, "src/tui-plugin.tsx")).href,
    });

    const blameCommand = mock.commands.find(
      (command) =>
        command.value === "context-map.blame" &&
        command.slash?.name === "blame",
    );
    assert.ok(blameCommand, "TUI plugin did not register /blame command");
    assert.ok(
      mock.commands.some(
        (command) =>
          command.value === "context-map.open" &&
          command.slash?.name === "context",
      ),
      "TUI plugin did not register /context command",
    );

    mock.trigger("context-map.blame");
    await waitFor(() => mock.historyDialogOpened || mock.toasts.length > 0);

    assert.deepEqual(mock.toasts, [], "expected no error toast from /blame");
    assert.equal(mock.promptTitle, "Blame lookup", "expected blame prompt");
    assert.ok(
      mock.historyDialogOpened,
      "expected /blame to open history dialog",
    );
    assert.equal(
      mock.dialogSizes.includes("xlarge"),
      true,
      "expected history dialog to use xlarge layout",
    );

    passed = true;
    console.log(
      JSON.stringify(
        {
          ok: true,
          tempRoot,
          server: server.url,
          sessionID: session.id,
          blamedLineToken,
          registeredSlash: "/blame",
          promptInput: mock.blameInput,
          historyDialogOpened: mock.historyDialogOpened,
        },
        null,
        2,
      ),
    );
  } finally {
    await server.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (!passed || process.env.MEM_MOULD_KEEP_BLAME_TUI_TEMP === "1") {
      console.error(`Preserved blame TUI temp root: ${tempRoot}`);
    } else {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }
}

async function prepareGitFixture(worktree: string) {
  await execFileAsync("git", ["init"], { cwd: worktree });
  const file = path.join(worktree, "src/auth/rate_limiter.ts");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lines = Array.from({ length: 50 }, (_, index) => {
    const line = index + 1;
    if (line === 42) return "  return enqueueRefresh(tenantID);";
    if (line === 1) return "export function refreshToken(tenantID: string) {";
    if (line === 50) return "}";
    return `  // fixture filler line ${line}`;
  });
  await fs.writeFile(file, `${lines.join("\n")}\n`);
  await execFileAsync("git", ["add", "."], { cwd: worktree });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Mem Mould Test",
      "-c",
      "user.email=mem-mould@example.invalid",
      "commit",
      "-m",
      "Add auth rate limiter fixture",
    ],
    { cwd: worktree },
  );
  const { stdout } = await execFileAsync(
    "git",
    ["blame", "-L", "42,42", "--", "src/auth/rate_limiter.ts"],
    { cwd: worktree },
  );
  const token = stdout.trim().split(/\s+/)[0];
  assert.ok(token, "failed to resolve fixture blame token");
  return token;
}

async function writeHistoricalMap(input: {
  home: string;
  worktree: string;
  sessionID: string;
  commitHash: string;
}) {
  const root = path.join(input.home, ".opencode", "context-maps");
  await fs.mkdir(root, { recursive: true });
  const now = Date.now();
  const map: ContextMapFile = {
    version: 1,
    sessionID: input.sessionID,
    directory: input.worktree,
    worktree: input.worktree,
    createdAt: now,
    updatedAt: now,
    totalTokenEstimate: 220,
    lastActiveBlobID: "auth_queue",
    settings: {
      placeholderIncludesKeyFacts: true,
      placeholderIncludesKeyFactsSource: "default",
      toolHistoryCleanup: true,
      stablePlaceholders: false,
      stablePlaceholdersSource: "default",
      stableAnchors: false,
      stableAnchorsSource: "default",
    },
    blobOrder: ["auth_queue"],
    blobs: {
      auth_queue: {
        id: "auth_queue",
        label: "auth queue",
        summary:
          "Historical session that added the rate limiter line and chose enqueueRefresh for tenant-scoped refresh coalescing.",
        placeholder: "Auth refresh queue line rationale",
        keyFacts: [
          "line 42 calls enqueueRefresh",
          "same-tenant refreshes coalesce while different tenants remain independent",
        ],
        fidelity: "summary",
        fidelitySource: "default",
        messageIDs: ["msg_auth_user", "msg_auth_assistant"],
        tokenEstimate: 220,
        createdAt: now,
        lastActiveAt: now,
        commitHashes: [input.commitHash],
      },
    },
    messages: {
      msg_auth_user: {
        id: "msg_auth_user",
        role: "user",
        blobID: "auth_queue",
        summary: "Asked for the auth refresh race on line 42 to be fixed.",
        keyFacts: ["target file is src/auth/rate_limiter.ts"],
        hidden: false,
        hiddenSource: "default",
        fidelityOverride: "inherit",
        fidelitySource: "default",
        tokenEstimate: 80,
        createdAt: now,
        updatedAt: now,
        source: "annotation",
        partTypes: ["text"],
        toolNames: [],
      },
      msg_auth_assistant: {
        id: "msg_auth_assistant",
        role: "assistant",
        blobID: "auth_queue",
        summary:
          "Added enqueueRefresh at line 42 so duplicate tenant refreshes share one in-flight promise.",
        keyFacts: [
          "enqueueRefresh preserves per-tenant coalescing",
          "global mutex was avoided to keep unrelated tenants independent",
        ],
        hidden: false,
        hiddenSource: "default",
        fidelityOverride: "inherit",
        fidelitySource: "default",
        tokenEstimate: 140,
        createdAt: now + 1,
        updatedAt: now + 1,
        source: "annotation",
        partTypes: ["text"],
        toolNames: [],
      },
    },
    pendingRetroactive: {},
  };
  await fs.writeFile(
    path.join(root, `${input.sessionID}.json`),
    `${JSON.stringify(map, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(root, "_commits.json"),
    `${JSON.stringify(
      {
        version: 1,
        updatedAt: now,
        entries: {
          [input.commitHash]: {
            commitHash: input.commitHash,
            sessionID: input.sessionID,
            timestamp: now,
            directory: input.worktree,
            worktree: input.worktree,
            activeBlobID: "auth_queue",
            activeBlobLabel: "auth queue",
            activeBlobIDs: ["auth_queue"],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

function createMockTuiApi(input: {
  client: ReturnType<typeof createOpencodeClient>;
  worktree: string;
  sessionID: string;
  blameInput: string;
}) {
  const commands: Array<{
    title: string;
    value: string;
    slash?: { name: string };
    onSelect?: () => void;
  }> = [];
  const toasts: unknown[] = [];
  const dialogSizes: string[] = [];
  let replaceCount = 0;
  let promptTitle = "";
  let historyDialogOpened = false;

  const clientAdapter = {
    ...input.client,
    session: {
      ...(input.client as any).session,
      get(args: { sessionID: string; directory: string }) {
        return (input.client as any).session.get(args);
      },
      messages(args: { sessionID: string; directory: string; limit?: number }) {
        return (input.client as any).session.messages(args);
      },
    },
  };

  const api = {
    app: { version: "sandbox" },
    command: {
      register(cb: () => typeof commands) {
        commands.push(...cb());
        return () => undefined;
      },
      trigger(value: string) {
        const command = commands.find((item) => item.value === value);
        command?.onSelect?.();
      },
      show() {},
    },
    route: {
      register() {
        return () => undefined;
      },
      navigate() {},
      current: { name: "session", params: { sessionID: input.sessionID } },
    },
    ui: {
      DialogPrompt(props: {
        title: string;
        onConfirm: (value: string) => void;
      }) {
        promptTitle = props.title;
        queueMicrotask(() => props.onConfirm(input.blameInput));
        return { type: "DialogPrompt" };
      },
      toast(toast: unknown) {
        toasts.push(toast);
      },
      dialog: {
        get open() {
          return replaceCount > 0;
        },
        replace(render: () => unknown) {
          replaceCount += 1;
          if (replaceCount === 1) render();
          else historyDialogOpened = true;
        },
        clear() {},
        setSize(size: string) {
          dialogSizes.push(size);
        },
      },
    },
    keybind: {
      create() {
        return { all: {}, get: () => "ctrl+g" };
      },
      print() {
        return "ctrl+g";
      },
      match() {
        return false;
      },
    },
    state: {
      path: { directory: input.worktree, worktree: input.worktree },
      provider: [],
      session: {
        messages() {
          return [];
        },
      },
    },
    theme: {
      current: {
        text: "white",
        textMuted: "gray",
        border: "gray",
        warning: "yellow",
        backgroundElement: "black",
        primary: "blue",
        secondary: "magenta",
        accent: "cyan",
        info: "cyan",
        success: "green",
        error: "red",
      },
    },
    client: clientAdapter,
    slots: {
      register() {},
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose() {
        return () => undefined;
      },
    },
    kv: {},
    event: { on: () => () => undefined },
    plugins: {},
  };

  return {
    api,
    commands,
    toasts,
    dialogSizes,
    blameInput: input.blameInput,
    get promptTitle() {
      return promptTitle;
    },
    get historyDialogOpened() {
      return historyDialogOpened;
    },
    trigger(value: string) {
      api.command.trigger(value);
    },
  };
}

async function startServer(env: NodeJS.ProcessEnv, cwd: string) {
  const proc = spawn(
    "opencode",
    ["serve", "--hostname=127.0.0.1", "--port=0"],
    {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out starting sandbox server\n${stderr}`)),
      20_000,
    );
    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      const match = text.match(
        /opencode server listening on (http:\/\/[^\s]+)/,
      );
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]!);
    });
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Sandbox server exited early with code ${String(code)}\n${stderr}`,
        ),
      );
    });
    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  return {
    url,
    async close() {
      proc.kill("SIGTERM");
      await new Promise((resolve) => proc.once("exit", resolve));
    },
  };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for /blame dialog result");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
