import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";

const execFileAsync = promisify(execFile);

type ModelRef = {
  providerID: string;
  modelID: string;
};

async function main() {
  const projectRoot = path.resolve(process.cwd());
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "mem-mould-context-map-manual-"),
  );
  const repo = path.join(tempRoot, "demo-repo");
  const home = path.join(tempRoot, "home");
  const data = path.join(tempRoot, "data");
  const config = path.join(tempRoot, "config");
  const state = path.join(tempRoot, "state");
  const cache = path.join(tempRoot, "cache");
  await Promise.all(
    [repo, home, data, config, state, cache].map((dir) =>
      fs.mkdir(dir, { recursive: true }),
    ),
  );

  await createDemoRepo(projectRoot, repo);
  const commits = await createDemoCommits(repo);

  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: cache,
    OPENCODE_DB: path.join(tempRoot, "opencode.sqlite"),
    MEM_MOULD_DISABLE_GIT_HOOK_INSTALL: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: [
        pathToFileURL(
          path.join(projectRoot, "src", "context-map", "server-plugin.ts"),
        ).href,
      ],
    }),
  };

  const server = await startServer(env, repo);

  try {
    const client = createOpencodeClient({ baseUrl: server.url });
    const model = await pickModel(client, repo);
    console.log(`Seeding demo env with ${model.providerID}/${model.modelID}`);

    const authSession = await seedAuthSession(client, repo, model);
    const docsSession = await seedDocsSession(client, repo, model);
    const refactorSession = await seedRefactorSession(client, repo, model);

    await writeCommitMap(home, repo, [
      { commitHash: commits.authCommit, sessionID: authSession },
      { commitHash: commits.docsCommit, sessionID: docsSession },
    ]);

    await writeTestingGuide(repo, {
      authSession,
      docsSession,
      refactorSession,
      authCommit: commits.authCommit,
      docsCommit: commits.docsCommit,
    });
    await writeLaunchScripts(tempRoot, repo, {
      home,
      data,
      config,
      state,
      cache,
      db: path.join(tempRoot, "opencode.sqlite"),
    });

    console.log(
      JSON.stringify(
        {
          temp_root: tempRoot,
          repo,
          launch_script: path.join(tempRoot, "open-test-env.sh"),
          testing_guide: path.join(repo, "TESTING.md"),
          sessions: {
            authSession,
            docsSession,
            refactorSession,
          },
          commits,
        },
        null,
        2,
      ),
    );
  } finally {
    await server.close();
  }
}

async function createDemoRepo(projectRoot: string, repo: string) {
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Context Map Demo"], {
    cwd: repo,
  });
  await execFileAsync(
    "git",
    ["config", "user.email", "context-map-demo@example.com"],
    { cwd: repo },
  );

  await fs.mkdir(path.join(repo, ".opencode", "plugins"), { recursive: true });
  await fs.mkdir(path.join(repo, "src", "auth"), { recursive: true });
  await fs.mkdir(path.join(repo, "tests"), { recursive: true });
  await fs.mkdir(path.join(repo, "docs"), { recursive: true });

  await fs.symlink(
    path.join(projectRoot, "src", "context-map", "server-plugin.ts"),
    path.join(repo, ".opencode", "plugins", "context-map.ts"),
  );
  await fs.symlink(
    path.join(projectRoot, "src", "context-map", "tui-plugin.tsx"),
    path.join(repo, ".opencode", "plugins", "context-map-tui.tsx"),
  );
  await fs.writeFile(
    path.join(repo, ".opencode", "tui.json"),
    `${JSON.stringify({ plugin: ["./plugins/context-map-tui.tsx"] }, null, 2)}\n`,
  );

  await fs.writeFile(
    path.join(repo, "README.md"),
    "# Context Map Demo Repo\n\nDisposable repo for manual context-map plugin testing.\n",
  );
  await fs.writeFile(
    path.join(repo, "src", "auth", "rate_limiter.ts"),
    renderRateLimiter(false),
  );
  await fs.writeFile(
    path.join(repo, "docs", "onboarding.md"),
    "# Onboarding\n\nStart with repo setup and local development basics.\n",
  );
}

async function createDemoCommits(repo: string) {
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "initial demo repo"], {
    cwd: repo,
  });

  await fs.writeFile(
    path.join(repo, "src", "auth", "rate_limiter.ts"),
    renderRateLimiter(true),
  );
  await fs.writeFile(
    path.join(repo, "src", "auth", "queue.ts"),
    `export async function enqueueRefresh<T>(job: () => Promise<T>) {\n  return await job()\n}\n`,
  );
  await fs.writeFile(
    path.join(repo, "tests", "auth.concurrent.test.ts"),
    `test("auth queue serializes concurrent refreshes", async () => {\n  expect(true).toBe(true)\n})\n`,
  );
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "switch auth refresh to queue"], {
    cwd: repo,
  });
  const authCommit = await gitHead(repo);

  await fs.writeFile(
    path.join(repo, "docs", "onboarding.md"),
    [
      "# Onboarding",
      "",
      "## Quickstart",
      "- Install deps",
      "- Run tests",
      "- Review auth rollback details if you touch token refresh",
      "",
      "## Docs map",
      "- auth queue behavior",
      "- API quickstart",
    ].join("\n") + "\n",
  );
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "expand onboarding docs"], {
    cwd: repo,
  });
  const docsCommit = await gitHead(repo);

  return { authCommit, docsCommit };
}

async function seedAuthSession(
  client: ReturnType<typeof createOpencodeClient>,
  repo: string,
  model: ModelRef,
) {
  const sessionID = await createSession(
    client,
    repo,
    "Auth queue investigation",
  );
  await prompt(
    client,
    repo,
    sessionID,
    model,
    "Investigate why src/auth/rate_limiter.ts line 42 uses an async queue instead of a mutex.",
  );
  await prompt(
    client,
    repo,
    sessionID,
    model,
    "Explain what went wrong with the mutex attempt and mention any rollback flag.",
  );
  await prompt(
    client,
    repo,
    sessionID,
    model,
    "Mention where the shared queue helper should live and what concurrency tests matter.",
  );
  return sessionID;
}

async function seedDocsSession(
  client: ReturnType<typeof createOpencodeClient>,
  repo: string,
  model: ModelRef,
) {
  const sessionID = await createSession(client, repo, "Docs quickstart update");
  await prompt(
    client,
    repo,
    sessionID,
    model,
    "Outline onboarding docs updates for new API contributors and mention how quickstart should be structured.",
  );
  await prompt(
    client,
    repo,
    sessionID,
    model,
    "Mention one doc that should link back to the auth rollback details.",
  );
  return sessionID;
}

async function seedRefactorSession(
  client: ReturnType<typeof createOpencodeClient>,
  repo: string,
  model: ModelRef,
) {
  const sessionID = await createSession(client, repo, "Queue helper refactor");
  await prompt(
    client,
    repo,
    sessionID,
    model,
    "Explain where a shared async queue helper should live and why auth middleware should reuse it.",
  );
  return sessionID;
}

async function writeCommitMap(
  home: string,
  repo: string,
  items: Array<{ commitHash: string; sessionID: string }>,
) {
  const root = path.join(home, ".opencode", "context-maps");
  await fs.mkdir(root, { recursive: true });

  const entries: Record<string, unknown> = {};
  for (const item of items) {
    const mapPath = path.join(root, `${item.sessionID}.json`);
    const map = JSON.parse(await fs.readFile(mapPath, "utf8")) as {
      lastActiveBlobID?: string;
      blobs?: Record<string, { label?: string }>;
    };
    entries[item.commitHash] = {
      commitHash: item.commitHash,
      sessionID: item.sessionID,
      timestamp: Date.now(),
      directory: repo,
      worktree: repo,
      activeBlobID: map.lastActiveBlobID,
      activeBlobLabel: map.lastActiveBlobID
        ? map.blobs?.[map.lastActiveBlobID]?.label
        : undefined,
      activeBlobIDs: map.lastActiveBlobID ? [map.lastActiveBlobID] : [],
    };
  }

  await fs.writeFile(
    path.join(root, "_commits.json"),
    JSON.stringify({ version: 1, updatedAt: Date.now(), entries }, null, 2),
  );
}

async function writeTestingGuide(
  repo: string,
  input: {
    authSession: string;
    docsSession: string;
    refactorSession: string;
    authCommit: string;
    docsCommit: string;
  },
) {
  const guide = [
    "# Manual Testing Guide",
    "",
    "## Start",
    "Run the launch script printed by setup-test-env.",
    "",
    "## Good first checks",
    "- Open `/mem-map` after a couple of turns and inspect blob/message grouping.",
    "- Ask: `why does src/auth/rate_limiter.ts line 42 use an async queue instead of a mutex?`",
    "- Run `/blame src/auth/rate_limiter.ts:42`",
    "- Ask the agent to call `context_map` and `compress_blob` naturally.",
    "",
    "## Seeded sessions",
    `- auth: ${input.authSession}`,
    `- docs: ${input.docsSession}`,
    `- refactor: ${input.refactorSession}`,
    "",
    "## Commit mapping",
    `- auth commit: ${input.authCommit}`,
    `- docs commit: ${input.docsCommit}`,
  ].join("\n");
  await fs.writeFile(path.join(repo, "TESTING.md"), `${guide}\n`);
}

async function writeLaunchScripts(
  tempRoot: string,
  repo: string,
  env: {
    home: string;
    data: string;
    config: string;
    state: string;
    cache: string;
    db: string;
  },
) {
  const launch = `#!/bin/sh
export HOME=${shellQuote(env.home)}
export XDG_DATA_HOME=${shellQuote(env.data)}
export XDG_CONFIG_HOME=${shellQuote(env.config)}
export XDG_STATE_HOME=${shellQuote(env.state)}
export XDG_CACHE_HOME=${shellQuote(env.cache)}
export OPENCODE_DB=${shellQuote(env.db)}
cd ${shellQuote(repo)} || exit 1
exec opencode "$@"
`;
  const cleanup = `#!/bin/sh
rm -rf ${shellQuote(tempRoot)}
`;
  await fs.writeFile(path.join(tempRoot, "open-test-env.sh"), launch);
  await fs.writeFile(path.join(tempRoot, "cleanup-test-env.sh"), cleanup);
  await fs.chmod(path.join(tempRoot, "open-test-env.sh"), 0o755);
  await fs.chmod(path.join(tempRoot, "cleanup-test-env.sh"), 0o755);
}

function renderRateLimiter(useQueue: boolean) {
  const lines = [
    'import { enqueueRefresh } from "./queue"',
    "",
    "export async function refreshToken(userID: string) {",
    "  const current = await loadCurrentToken(userID)",
    "  if (!current.needsRefresh) return current",
    "",
    "  // filler 6",
    "  // filler 7",
    "  // filler 8",
    "  // filler 9",
    "  // filler 10",
    "  // filler 11",
    "  // filler 12",
    "  // filler 13",
    "  // filler 14",
    "  // filler 15",
    "  // filler 16",
    "  // filler 17",
    "  // filler 18",
    "  // filler 19",
    "  // filler 20",
    "  // filler 21",
    "  // filler 22",
    "  // filler 23",
    "  // filler 24",
    "  // filler 25",
    "  // filler 26",
    "  // filler 27",
    "  // filler 28",
    "  // filler 29",
    "  // filler 30",
    "  // filler 31",
    "  // filler 32",
    "  // filler 33",
    "  // filler 34",
    "  // filler 35",
    "  // filler 36",
    "  // filler 37",
    "  // filler 38",
    "  // filler 39",
    "  // filler 40",
    useQueue
      ? "  return await enqueueRefresh(async () => await issueNewToken(userID))"
      : "  return await withMutex(userID, async () => await issueNewToken(userID))",
    "}",
    "",
    "async function loadCurrentToken(userID: string) {",
    "  return { userID, needsRefresh: true }",
    "}",
    "",
    "async function issueNewToken(userID: string) {",
    "  return { userID, needsRefresh: false }",
    "}",
    "",
    "async function withMutex(userID: string, job: () => Promise<unknown>) {",
    "  return await job()",
    "}",
  ];
  return `${lines.join("\n")}\n`;
}

function shellQuote(value: string) {
  return JSON.stringify(value);
}

async function gitHead(repo: string) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
  });
  return stdout.trim();
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

async function pickModel(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
): Promise<ModelRef> {
  const providers = (((await client.provider.list({ directory })) as any)
    ?.data ?? {}) as {
    all?: Array<{ id: string; models: Record<string, unknown> }>;
  };
  const all = providers.all ?? [];
  const preferred: ModelRef[] = [
    { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    {
      providerID: "amazon-bedrock",
      modelID: "global.anthropic.claude-sonnet-4-6",
    },
    { providerID: "openai", modelID: "gpt-5.4" },
  ];
  for (const candidate of preferred) {
    const provider = all.find((item) => item.id === candidate.providerID);
    if (provider && candidate.modelID in provider.models) return candidate;
  }
  const provider = all[0];
  assert.ok(provider, "no providers available while seeding demo env");
  const modelID = Object.keys(provider.models)[0];
  assert.ok(modelID, `provider ${provider.id} has no models`);
  return { providerID: provider.id, modelID };
}

async function createSession(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  title: string,
) {
  const session = (((await client.session.create({ directory, title })) as any)
    ?.data ?? {}) as { id: string };
  assert.ok(session.id, `failed to create session ${title}`);
  return session.id;
}

async function prompt(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  sessionID: string,
  model: ModelRef,
  text: string,
) {
  const reply = ((
    (await client.session.prompt({
      directory,
      sessionID,
      model,
      parts: [{ type: "text", text }],
    })) as any
  )?.data ?? {}) as { parts: Array<{ type: string; text?: string }> };
  const visible = reply.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  assert.ok(visible.length > 0, `empty seeded reply for prompt: ${text}`);
  assert.ok(
    !visible.includes("<annotation>"),
    "annotation leaked during seeding",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
