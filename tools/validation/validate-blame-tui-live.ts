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
    path.join(os.tmpdir(), "mem-mould-blame-live-"),
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

  const commitToken = await prepareGitFixture(worktree);
  const sessionID = await seedOpenCodeSession({
    repoRoot,
    tempRoot,
    home,
    data,
    config,
    state,
    cache,
    worktree,
    commitToken,
  });

  const tuiConfigPath = path.join(tempRoot, "tui.json");
  await fs.writeFile(
    tuiConfigPath,
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/tui.json",
        plugin: [pathToFileURL(path.join(repoRoot, "src/tui-plugin.tsx")).href],
      },
      null,
      2,
    )}\n`,
  );

  const runScript = path.join(tempRoot, "run-opencode-tui.sh");
  await fs.writeFile(
    runScript,
    [
      "#!/bin/sh",
      "set -eu",
      `export HOME=${shellQuote(home)}`,
      `export XDG_DATA_HOME=${shellQuote(data)}`,
      `export XDG_CONFIG_HOME=${shellQuote(config)}`,
      `export XDG_STATE_HOME=${shellQuote(state)}`,
      `export XDG_CACHE_HOME=${shellQuote(cache)}`,
      `export OPENCODE_DB=${shellQuote(path.join(tempRoot, "opencode.sqlite"))}`,
      "export OPENCODE_DISABLE_PROJECT_CONFIG=1",
      "export MEM_MOULD_DISABLE_GIT_HOOK_INSTALL=1",
      `export OPENCODE_TUI_CONFIG=${shellQuote(tuiConfigPath)}`,
      `export OPENCODE_CONFIG_CONTENT=${shellQuote(
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          plugin: [
            pathToFileURL(path.join(repoRoot, "src/server-plugin.ts")).href,
          ],
        }),
      )}`,
      "export TERM=xterm-256color",
      `exec opencode --session ${shellQuote(sessionID)} ${shellQuote(worktree)}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const tmuxName = `mem-mould-blame-${process.pid}`;
  let passed = false;
  try {
    await execFileAsync("tmux", [
      "new-session",
      "-d",
      "-s",
      tmuxName,
      "-x",
      "140",
      "-y",
      "44",
      runScript,
    ]);
    await waitForPane(
      tmuxName,
      /opencode|What should|Blame|Context Map/i,
      25_000,
    );
    await execFileAsync("tmux", ["send-keys", "-t", tmuxName, "/blame"]);
    await waitForPane(
      tmuxName,
      /\/blame[\s\S]*Open context from the session that touched a file line/i,
      10_000,
    );
    await execFileAsync("tmux", ["send-keys", "-t", tmuxName, "Tab"]);
    await waitForPane(
      tmuxName,
      /Blame lookup|src\/auth\.ts:42|file:line/i,
      15_000,
    );
    await execFileAsync("tmux", [
      "send-keys",
      "-t",
      tmuxName,
      "src/auth/rate_limiter.ts:42",
      "C-m",
    ]);
    const pane = await waitForPane(
      tmuxName,
      /Blame[\s\S]*src\/auth\/rate_limiter\.ts:42[\s\S]*(auth queue|Auth refresh queue line rationale|commit-linked)/i,
      20_000,
    );
    passed = true;
    console.log(
      JSON.stringify(
        {
          ok: true,
          tempRoot,
          tmuxSession: tmuxName,
          sessionID,
          commitToken,
          saw: "Blame dialog with mapped auth_queue blob",
          paneExcerpt: normalizePane(pane).slice(0, 1200),
        },
        null,
        2,
      ),
    );
  } finally {
    await execFileAsync("tmux", ["kill-session", "-t", tmuxName]).catch(
      () => undefined,
    );
    if (!passed || process.env.MEM_MOULD_KEEP_BLAME_LIVE_TEMP === "1") {
      console.error(`Preserved live TUI temp root: ${tempRoot}`);
    } else {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }
}

async function seedOpenCodeSession(input: {
  repoRoot: string;
  tempRoot: string;
  home: string;
  data: string;
  config: string;
  state: string;
  cache: string;
  worktree: string;
  commitToken: string;
}) {
  const env = {
    ...process.env,
    HOME: input.home,
    XDG_DATA_HOME: input.data,
    XDG_CONFIG_HOME: input.config,
    XDG_STATE_HOME: input.state,
    XDG_CACHE_HOME: input.cache,
    OPENCODE_DB: path.join(input.tempRoot, "opencode.sqlite"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    MEM_MOULD_DISABLE_GIT_HOOK_INSTALL: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: [
        pathToFileURL(path.join(input.repoRoot, "src/server-plugin.ts")).href,
      ],
    }),
  };
  const server = await startServer(env, input.worktree);
  try {
    const client = createOpencodeClient({ baseUrl: server.url });
    const session = ((
      (await client.session.create({
        directory: input.worktree,
        title: "Live TUI blame historical session",
      })) as any
    )?.data ?? {}) as { id?: string };
    assert.ok(session.id, "failed to create OpenCode session");
    await writeHistoricalMap({
      home: input.home,
      worktree: input.worktree,
      sessionID: session.id,
      commitHash: input.commitToken,
    });
    return session.id;
  } finally {
    await server.close();
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

async function startServer(env: NodeJS.ProcessEnv, cwd: string) {
  const proc = spawn(
    "opencode",
    ["serve", "--hostname=127.0.0.1", "--port=0"],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
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
      const match = chunk
        .toString()
        .match(/opencode server listening on (http:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]!);
    });
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(`Sandbox server exited early: ${String(code)}\n${stderr}`),
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

async function waitForPane(name: string, pattern: RegExp, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await capturePane(name);
    if (pattern.test(normalizePane(last))) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `timed out waiting for pane pattern ${pattern}\nLast pane:\n${normalizePane(last)}`,
  );
}

async function capturePane(name: string) {
  const { stdout } = await execFileAsync("tmux", [
    "capture-pane",
    "-p",
    "-J",
    "-S",
    "-200",
    "-t",
    name,
  ]);
  return stdout;
}

function normalizePane(value: string) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\s+/g, " ");
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
