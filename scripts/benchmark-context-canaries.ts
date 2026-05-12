import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";

const execFileAsync = promisify(execFile);

type ModelRef = {
  providerID: string;
  modelID: string;
};

type SessionMessage = {
  info?: {
    id?: string;
    role?: string;
    finish?: string;
    summary?: boolean;
    system?: string;
    tokens?: {
      input?: number;
      output?: number;
      total?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
  role?: string;
  parts?: Array<{
    type: string;
    text?: string;
    tool?: string;
    state?: { status?: string; input?: unknown; output?: unknown };
  }>;
};

type ConditionID =
  | "polluted-default-compact"
  | "polluted-memmould-cache-stable-boundary-compact";

type CanaryID =
  | "task-switch"
  | "stale-instruction"
  | "conversational-inertia"
  | "current-task-capsule";

type ConditionConfig = {
  id: ConditionID;
  plugin: boolean;
  contextCleanup: boolean;
  cacheStable: boolean;
  taskBoundary: boolean;
};

type CanaryConfig = {
  id: CanaryID;
  title: string;
  failureMode: string;
  finalPrompt: string;
  systemPrompt: string;
  currentTerms: string[];
};

type Options = {
  conditions: ConditionID[];
  canaries: CanaryID[];
  outDir: string;
  modelSlug: string;
  promptTimeoutMs: number;
  prepareOnly: boolean;
  keepWorktrees: boolean;
  analyzeRun?: string;
};

type TokenBucket = {
  messages: number;
  assistant: number;
  input: number;
  output: number;
  total: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  toolCalls: number;
  maxInput: number;
};

type RunResult = {
  condition: ConditionID;
  canary: CanaryID;
  sessionID?: string;
  statsPath: string;
  messagesPath: string;
  contextMapPath: string;
  contextHygienePassed?: boolean;
  canaryPassed?: boolean;
  error?: string;
};

type AnalysisRow = {
  condition: ConditionID;
  canary: CanaryID;
  contextHygienePassed: boolean;
  canaryPassed: boolean;
  currentTaskTermHits: string[];
  staleTermsInOutput: string[];
  staleTermsInCompactionSummary: string[];
  staleTermsInVisibleCompactionSummary: string[];
  sessionSummaryFidelity?: string;
  contextToolCalls: number;
  toolCalls: number;
  tokens: TokenBucket;
  cacheHitShare: number | null;
  outputPreview: string;
};

type RunAnalysis = {
  outDir: string;
  generatedAt: string;
  rows: AnalysisRow[];
};

const repoRoot = path.resolve(process.cwd());
const defaultOutDir = path.join(
  repoRoot,
  "benchmarks",
  "context-canaries",
  "runs",
  timestampForPath(new Date()),
);

const staleTerms = [
  "auth rate limiter",
  "rate_limiter",
  "MutexRefreshCoordinator",
  "FLAG_AUTH_QUEUE_ROLLBACK",
  "enqueueRefresh",
  "src/auth/queue.ts",
  "markdown parser",
  "quickstart",
  "onboarding docs",
  "auth_refresh_deduplicates_parallel_requests",
];

const preludeTurns = [
  "We are investigating an auth rate limiter race in a separate service. The suspected hot spot is `src/auth/rate_limiter.ts:42`, where two concurrent refresh requests can both observe an expired token and schedule duplicate refresh work. Think through the likely root cause, but do not edit files yet.",
  "Stay on the auth race. I tried a mutex-oriented design earlier, but I am worried it serializes too much of the request path and may still fail if the lock is scoped per handler instance instead of per tenant. Explain what would make that failure mode plausible.",
  "The mutex attempt did fail under a concurrent test. Preserve this as an important fact for later: the failed approach was `MutexRefreshCoordinator`, and the failing test name was `auth_refresh_deduplicates_parallel_requests`. We are leaning toward an async queue instead.",
  "Switch topics. For onboarding docs, outline a contributor quickstart for API developers. It should mention local environment setup, a short smoke test command, where API route files live, and how to find feature-flag documentation. This docs work is low priority compared with auth.",
  "Still on docs: the quickstart wording got noisy. We renamed the section from Setup to First local run, then back to Quickstart, then to Contributor quickstart. Also mention that the docs cleanup should not affect runtime behavior.",
  "Switch again. For the auth work, assume the final approach is an async queue helper extracted to `src/auth/queue.ts`. The rollback flag is `FLAG_AUTH_QUEUE_ROLLBACK`. The helper should deduplicate per tenant and expose a narrow `enqueueRefresh` API.",
  "Now discuss tests, but keep it separate from docs. We need concurrency tests for same-tenant refresh dedupe, different-tenant parallelism, rollback flag behavior, and failure propagation when a queued refresh rejects. The same-tenant test is the most important.",
  "Add a stale note that should not be reused unless explicitly relevant: in an old prototype, we thought the bug was caused by a markdown parser caching issue in docs generation. That hypothesis was wrong and belongs to the docs cleanup thread, not the auth fix.",
  "Return to auth. Summarize the important facts: mutex failed tests, async queue is the final direction, rollback is behind `FLAG_AUTH_QUEUE_ROLLBACK`, helper lives in `src/auth/queue.ts`, and the docs/markdown parser idea is unrelated noise.",
  "We are about to switch to a completely different open-source parser task. The old auth/docs/test discussion is only historical context. Do not let those details leak into the next repository unless a context-management tool explicitly says they are relevant.",
];

const conditions: Record<ConditionID, ConditionConfig> = {
  "polluted-default-compact": {
    id: "polluted-default-compact",
    plugin: false,
    contextCleanup: false,
    cacheStable: false,
    taskBoundary: false,
  },
  "polluted-memmould-cache-stable-boundary-compact": {
    id: "polluted-memmould-cache-stable-boundary-compact",
    plugin: true,
    contextCleanup: true,
    cacheStable: true,
    taskBoundary: true,
  },
};

const canaries: Record<CanaryID, CanaryConfig> = {
  "task-switch": {
    id: "task-switch",
    title: "Task-switch hygiene",
    failureMode:
      "Old unrelated auth/docs/test work pollutes a new parser task.",
    currentTerms: ["csv", "header", "trim"],
    systemPrompt:
      "Answer with compact JSON only. Do not call tools. Do not edit files.",
    finalPrompt: [
      "We are now working on a wholly unrelated parser issue in this repository.",
      "Current task: a CSV header parser should trim spaces around comma-separated header names.",
      "Return JSON with keys current_task, proposed_fix, stale_context_policy, and next_action.",
      "Do not mention historical topics unless they are directly relevant to this parser issue.",
    ].join("\n"),
  },
  "stale-instruction": {
    id: "stale-instruction",
    title: "Stale-instruction defense",
    failureMode: "Old implementation direction acts like a stale instruction.",
    currentTerms: ["csv", "header", "trim"],
    systemPrompt:
      "Answer with compact JSON only. Do not call tools. Do not edit files.",
    finalPrompt: [
      "Current task: choose the implementation approach for a CSV header parser bug.",
      "Important latest instruction: the solution is only about trimming spaces around comma-separated CSV header names.",
      "Return JSON with keys approach, forbidden_old_approach_used, and rationale.",
      "The approach must be specific to the parser task and must not reuse unrelated earlier implementation directions.",
    ].join("\n"),
  },
  "conversational-inertia": {
    id: "conversational-inertia",
    title: "Conversational inertia",
    failureMode:
      "Agent repeats old failed approaches because prior responses behave like bad examples.",
    currentTerms: ["csv", "header", "trim"],
    systemPrompt:
      "Answer with compact JSON only. Do not call tools. Do not edit files.",
    finalPrompt: [
      "Start fresh on this repository's parser task.",
      "Current task: propose a minimal plan for trimming whitespace around CSV header cells before they are stored.",
      "Return JSON with keys fresh_plan, reused_failed_prior_approach, and why_this_is_current.",
      "Avoid carrying over approaches from unrelated prior discussion.",
    ].join("\n"),
  },
  "current-task-capsule": {
    id: "current-task-capsule",
    title: "Current-task capsule",
    failureMode:
      "After compaction, the current task is buried under old session history.",
    currentTerms: ["csv", "header", "trim"],
    systemPrompt:
      "Answer with compact JSON only. Do not call tools. Do not edit files.",
    finalPrompt: [
      "We are beginning the current task now: update a CSV header parser so header cells are trimmed around commas.",
      "What is the current task?",
      "Return JSON with keys current_task, immediate_next_step, and ready_for_new_issue.",
      "Only describe the current task and immediate next step.",
    ].join("\n"),
  },
};

async function main() {
  const options = parseOptions();

  if (options.analyzeRun) {
    const analysis = await analyzeRun(options.analyzeRun);
    await writeAnalysisFiles(options.analyzeRun, analysis);
    console.log(runAnalysisMarkdown(analysis));
    console.log(
      `Analysis written to ${path.join(options.analyzeRun, "analysis.md")}`,
    );
    return;
  }

  await fs.mkdir(options.outDir, { recursive: true });
  await fs.writeFile(
    path.join(options.outDir, "config.json"),
    `${JSON.stringify(options, null, 2)}\n`,
  );

  if (options.prepareOnly) {
    await writeSummary(options.outDir, [], options);
    console.log(`Prepared context canary metadata at ${options.outDir}`);
    return;
  }

  const model = parseModelSlug(options.modelSlug);
  const results: RunResult[] = [];
  for (const conditionID of options.conditions) {
    for (const canaryID of options.canaries) {
      const result = await runConditionCanary(
        conditions[conditionID],
        canaries[canaryID],
        model,
        options,
      );
      results.push(result);
      await writeSummary(options.outDir, results, options);
    }
  }

  await writeSummary(options.outDir, results, options);
  await writeRunAnalysis(options.outDir).catch((error) => {
    console.warn(`Could not write canary analysis: ${String(error)}`);
  });
  console.log(`Context canary artifacts written to ${options.outDir}`);
}

async function runConditionCanary(
  condition: ConditionConfig,
  canary: CanaryConfig,
  model: ModelRef,
  options: Options,
): Promise<RunResult> {
  const conditionDir = path.join(
    options.outDir,
    "conditions",
    condition.id,
    canary.id,
  );
  const worktree = path.join(conditionDir, "worktree");
  await fs.mkdir(conditionDir, { recursive: true });

  const resultBase: RunResult = {
    condition: condition.id,
    canary: canary.id,
    statsPath: path.join(conditionDir, "stats.json"),
    messagesPath: path.join(conditionDir, "messages.json"),
    contextMapPath: path.join(conditionDir, "context-map.json"),
  };

  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const startedAt = Date.now();
  try {
    await prepareFixtureRepo(worktree);
    const opencodeRoot = await resolveOpenCodeRoot(conditionDir);
    const env = await buildOpenCodeEnv({
      opencodeRoot,
      conditionDir,
      modelSlug: options.modelSlug,
      plugin: condition.plugin,
      cacheStable: condition.cacheStable,
      taskBoundary: condition.taskBoundary,
    });
    server = await startServer(env, worktree);
    const client = createOpencodeClient({ baseUrl: server.url });
    await pickModel(client, worktree, options.modelSlug);
    const sessionID = await createSession(
      client,
      worktree,
      `${condition.id} ${canary.id}`,
    );

    for (const turn of preludeTurns) {
      await prompt(
        client,
        worktree,
        sessionID,
        turn,
        "This is pre-task conversation history for a context canary. Do not edit files and do not call tools. Respond concisely while preserving important facts for later compaction.",
        {},
        options.promptTimeoutMs,
      );
    }

    if (condition.contextCleanup) {
      await requestContextCleanup(
        client,
        worktree,
        sessionID,
        options.promptTimeoutMs,
      );
    }

    await forceCompaction(client, worktree, sessionID, model);
    await prompt(
      client,
      worktree,
      sessionID,
      canary.finalPrompt,
      canary.systemPrompt,
      {},
      options.promptTimeoutMs,
    );

    const messages = await listSessionMessages(client, worktree, sessionID);
    await fs.writeFile(
      resultBase.messagesPath,
      `${JSON.stringify(messages, null, 2)}\n`,
    );
    await copyContextMapIfPresent(opencodeRoot.home, sessionID, conditionDir);
    const stats = await buildStats({
      condition,
      canary,
      sessionID,
      messages,
      conditionDir,
      startedAt,
    });
    await fs.writeFile(
      resultBase.statsPath,
      `${JSON.stringify(stats, null, 2)}\n`,
    );

    if (!options.keepWorktrees) {
      await fs.rm(worktree, { recursive: true, force: true });
    }

    return {
      ...resultBase,
      sessionID,
      contextHygienePassed: stats.context_hygiene_passed,
      canaryPassed: stats.canary_passed,
    };
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    await fs.writeFile(
      resultBase.statsPath,
      `${JSON.stringify({ error: message }, null, 2)}\n`,
    );
    return { ...resultBase, error: message };
  } finally {
    await server?.close();
  }
}

function parseOptions(): Options {
  const args = process.argv.slice(2);
  const conditionArg = valueArg(args, "--conditions");
  const canaryArg = valueArg(args, "--canaries") ?? valueArg(args, "--canary");
  const conditionsList = (
    conditionArg
      ? splitList(conditionArg)
      : [
          "polluted-default-compact",
          "polluted-memmould-cache-stable-boundary-compact",
        ]
  ) as ConditionID[];
  const canaryList = (
    canaryArg
      ? splitList(canaryArg)
      : [
          "task-switch",
          "stale-instruction",
          "conversational-inertia",
          "current-task-capsule",
        ]
  ) as CanaryID[];

  for (const condition of conditionsList) {
    assert.ok(
      condition in conditions,
      `unknown condition ${condition}; expected one of ${Object.keys(conditions).join(", ")}`,
    );
  }
  for (const canary of canaryList) {
    assert.ok(
      canary in canaries,
      `unknown canary ${canary}; expected one of ${Object.keys(canaries).join(", ")}`,
    );
  }

  const timeoutMinutes = Number(
    valueArg(args, "--prompt-timeout-minutes") ?? "10",
  );
  assert.ok(Number.isFinite(timeoutMinutes) && timeoutMinutes > 0);
  const analyzeRun = valueArg(args, "--analyze-run");

  return {
    conditions: conditionsList,
    canaries: canaryList,
    outDir: path.resolve(valueArg(args, "--out") ?? defaultOutDir),
    modelSlug: process.env.MEM_MOULD_E2E_MODEL ?? "openai/gpt-5.5",
    promptTimeoutMs: timeoutMinutes * 60_000,
    prepareOnly: hasArg(args, "--prepare-only"),
    keepWorktrees: hasArg(args, "--keep-worktrees"),
    analyzeRun: analyzeRun ? path.resolve(analyzeRun) : undefined,
  };
}

function valueArg(args: string[], name: string) {
  const equals = args.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return undefined;
}

function hasArg(args: string[], name: string) {
  return args.includes(name);
}

function splitList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseModelSlug(modelSlug: string): ModelRef {
  const index = modelSlug.indexOf("/");
  assert.ok(index > 0, `model must be provider/model, got: ${modelSlug}`);
  return {
    providerID: modelSlug.slice(0, index),
    modelID: modelSlug.slice(index + 1),
  };
}

async function prepareFixtureRepo(worktree: string) {
  await fs.rm(worktree, { recursive: true, force: true });
  await fs.mkdir(path.join(worktree, "src"), { recursive: true });
  await fs.writeFile(
    path.join(worktree, "README.md"),
    [
      "# Parser Fixture",
      "",
      "Small fixture repository for context canaries.",
      "The active issue is about CSV header parsing, not auth or docs.",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(worktree, "src", "csv_parser.ts"),
    [
      "export function parseHeader(line: string) {",
      "  return line.split(',');",
      "}",
      "",
    ].join("\n"),
  );
  await execFileAsync("git", ["init"], { cwd: worktree });
  await execFileAsync("git", ["add", "."], { cwd: worktree });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Context Canary",
      "-c",
      "user.email=context-canary@example.com",
      "commit",
      "-m",
      "seed parser fixture",
    ],
    { cwd: worktree },
  );
}

type OpenCodeRoot = {
  home: string;
  data: string;
  config: string;
  state: string;
  cache: string;
};

async function resolveOpenCodeRoot(
  conditionDir: string,
): Promise<OpenCodeRoot> {
  const seeded = process.env.MEM_MOULD_E2E_TEMP_ROOT;
  if (seeded) {
    return {
      home: path.join(seeded, "home"),
      data: path.join(seeded, "data"),
      config: path.join(seeded, "config"),
      state: path.join(seeded, "state"),
      cache: path.join(seeded, "cache"),
    };
  }
  const root = path.join(conditionDir, "opencode-root");
  return {
    home: path.join(root, "home"),
    data: path.join(root, "data"),
    config: path.join(root, "config"),
    state: path.join(root, "state"),
    cache: path.join(root, "cache"),
  };
}

async function buildOpenCodeEnv(input: {
  opencodeRoot: OpenCodeRoot;
  conditionDir: string;
  modelSlug: string;
  plugin: boolean;
  cacheStable: boolean;
  taskBoundary: boolean;
}) {
  await Promise.all(
    Object.values(input.opencodeRoot).map((dir) =>
      fs.mkdir(dir, { recursive: true }),
    ),
  );
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    model: input.modelSlug,
  };
  if (input.plugin) {
    config.plugin = [
      pathToFileURL(
        path.join(repoRoot, "src", "context-map", "server-plugin.ts"),
      ).href,
    ];
  }
  return {
    ...process.env,
    HOME: input.opencodeRoot.home,
    XDG_DATA_HOME: input.opencodeRoot.data,
    XDG_CONFIG_HOME: input.opencodeRoot.config,
    XDG_STATE_HOME: input.opencodeRoot.state,
    XDG_CACHE_HOME: input.opencodeRoot.cache,
    OPENCODE_DB: path.join(input.conditionDir, "opencode.sqlite"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    MEM_MOULD_DISABLE_GIT_HOOK_INSTALL: "1",
    ...(input.cacheStable
      ? {
          MEM_MOULD_CACHE_STABLE: "1",
          MEM_MOULD_STABLE_PLACEHOLDERS: "1",
          MEM_MOULD_STABLE_ANCHORS: "1",
        }
      : {}),
    ...(input.taskBoundary ? { MEM_MOULD_TASK_BOUNDARY: "1" } : {}),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  } satisfies NodeJS.ProcessEnv;
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
      if (proc.exitCode !== null) return;
      proc.kill("SIGTERM");
      await new Promise((resolve) => proc.once("exit", resolve));
    },
  };
}

async function pickModel(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  modelSlug: string,
) {
  const requested = parseModelSlug(modelSlug);
  const providers = (((await client.provider.list({ directory })) as any)
    ?.data ?? {}) as {
    all?: Array<{ id: string; models: Record<string, unknown> }>;
    connected?: string[];
  };
  const provider = (providers.all ?? []).find(
    (item) => item.id === requested.providerID,
  );
  assert.ok(provider, `provider is not available: ${requested.providerID}`);
  assert.ok(
    (providers.connected ?? []).includes(requested.providerID),
    `provider is not connected in the isolated sandbox: ${requested.providerID}`,
  );
  assert.ok(
    requested.modelID in provider.models,
    `model is not available: ${requested.providerID}/${requested.modelID}`,
  );
}

async function createSession(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  title: string,
) {
  const session = (((await client.session.create({ directory, title })) as any)
    ?.data ?? {}) as { id?: string };
  assert.ok(session.id, "failed to create session");
  return session.id;
}

async function requestContextCleanup(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  sessionID: string,
  timeoutMs: number,
) {
  await prompt(
    client,
    directory,
    sessionID,
    "We are ending the old auth/docs/test planning work and switching to a wholly unrelated parser issue. Call view_context exactly once. Then call set_fidelity with fidelity='drop' for every blob about auth, docs, onboarding, tests, stale hypotheses, queue helpers, mutexes, rollback flags, or prior planning. No prior blob is current for the next task. If a blob cannot be dropped safely, set it to placeholder and explain why in one short phrase. Then answer with only ok.",
    "You must call view_context and at least one set_fidelity call before answering. Do not edit repository files. Avoid unrelated tools.",
    { view_context: true, set_fidelity: true },
    timeoutMs,
  );
}

async function forceCompaction(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  sessionID: string,
  model: ModelRef,
) {
  await client.session.summarize({
    directory,
    sessionID,
    providerID: model.providerID,
    modelID: model.modelID,
    auto: false,
  } as any);
}

async function prompt(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  sessionID: string,
  text: string,
  system: string | undefined,
  tools: Record<string, boolean> | undefined,
  timeoutMs: number,
) {
  const before = await listSessionMessages(client, directory, sessionID);
  const beforeIDs = new Set(before.map((message) => message.info?.id));
  const raw = (await withTimeout(
    client.session.promptAsync({
      directory,
      sessionID,
      system,
      tools,
      parts: [{ type: "text", text }],
    }) as Promise<unknown>,
    timeoutMs,
    `prompt timed out in ${sessionID}`,
  )) as { data?: { error?: unknown }; error?: unknown };
  const reply = raw.data ?? raw ?? {};
  if (reply.error) throw new Error(JSON.stringify(reply.error));
  return await waitForAssistantMessage(
    client,
    directory,
    sessionID,
    beforeIDs,
    timeoutMs,
  );
}

async function waitForAssistantMessage(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  sessionID: string,
  beforeIDs: Set<string | undefined>,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const messages = await listSessionMessages(client, directory, sessionID);
    const assistant = [...messages]
      .reverse()
      .find(
        (message) =>
          (message.info?.role ?? message.role) === "assistant" &&
          !beforeIDs.has(message.info?.id) &&
          message.info?.finish &&
          message.info.finish !== "tool-calls",
      );
    if (assistant) return assistant;
  }
  throw new Error(`timed out waiting for assistant message in ${sessionID}`);
}

async function listSessionMessages(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  sessionID: string,
) {
  return ((
    (await client.session.messages({
      sessionID,
      directory,
      limit: 5000,
    })) as any
  )?.data ?? []) as SessionMessage[];
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function copyContextMapIfPresent(
  home: string,
  sessionID: string,
  conditionDir: string,
) {
  const mapsDir = path.join(home, ".opencode", "context-maps");
  const files = [
    `${sessionID}.json`,
    `${sessionID}.trace.jsonl`,
    `${sessionID}.debug.json`,
  ];
  for (const file of files) {
    const src = path.join(mapsDir, file);
    const dst = path.join(
      conditionDir,
      file === `${sessionID}.json` ? "context-map.json" : file,
    );
    const content = await fs.readFile(src).catch(() => undefined);
    if (content) await fs.writeFile(dst, content);
  }
}

async function buildStats(input: {
  condition: ConditionConfig;
  canary: CanaryConfig;
  sessionID: string;
  messages: SessionMessage[];
  conditionDir: string;
  startedAt: number;
}) {
  const outputText = messageText(latestAssistantMessage(input.messages));
  const staleOutputTerms = termsInText(staleTerms, outputText);
  const staleSummaryTerms = termsInText(
    staleTerms,
    compactionSummaries(input.messages).join("\n"),
  );
  const sessionSummaryFidelity = await readSessionSummaryFidelity(
    input.conditionDir,
  );
  const visibleStaleSummaryTerms = isHiddenFidelity(sessionSummaryFidelity)
    ? []
    : staleSummaryTerms;
  const currentTaskTermHits = termsInText(
    input.canary.currentTerms,
    outputText,
  );
  const toolNames = input.messages
    .flatMap((message) => toolParts(message.parts))
    .map((part) => part.tool)
    .filter((tool): tool is string => Boolean(tool));
  const contextHygienePassed =
    staleOutputTerms.length === 0 && visibleStaleSummaryTerms.length === 0;
  const canaryPassed =
    contextHygienePassed &&
    currentTaskTermHits.length >= Math.min(2, input.canary.currentTerms.length);

  return {
    condition: input.condition.id,
    canary: input.canary.id,
    title: input.canary.title,
    failure_mode: input.canary.failureMode,
    session_id: input.sessionID,
    duration_ms: Date.now() - input.startedAt,
    message_count: input.messages.length,
    tool_call_count: toolNames.length,
    tool_names: toolNames,
    context_tool_call_count: toolNames.filter((tool) =>
      ["view_context", "set_fidelity"].includes(tool),
    ).length,
    output_preview: outputText.slice(0, 800),
    current_task_term_hits: currentTaskTermHits,
    stale_terms_in_output: staleOutputTerms,
    stale_terms_in_compaction_summary: staleSummaryTerms,
    stale_terms_in_visible_compaction_summary: visibleStaleSummaryTerms,
    session_summary_fidelity: sessionSummaryFidelity,
    tokens: summarizeTokens(input.messages),
    context_hygiene_passed: contextHygienePassed,
    canary_passed: canaryPassed,
  };
}

function toolParts(parts: SessionMessage["parts"]) {
  return (parts ?? []).filter((part) => part.type === "tool");
}

function latestAssistantMessage(messages: SessionMessage[]) {
  return [...messages]
    .reverse()
    .find((message) => (message.info?.role ?? message.role) === "assistant");
}

function messageText(message: SessionMessage | undefined) {
  return (message?.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function compactionSummaries(messages: SessionMessage[]) {
  return messages
    .filter(
      (message) =>
        (message.info?.role ?? message.role) === "assistant" &&
        (message.info?.summary === true ||
          messageText(message).startsWith("## Goal")),
    )
    .map(messageText)
    .filter(Boolean);
}

function termsInText(terms: string[], text: string) {
  const lowered = text.toLowerCase();
  return terms.filter((term) => lowered.includes(term.toLowerCase()));
}

async function readSessionSummaryFidelity(conditionDir: string) {
  const raw = await fs
    .readFile(path.join(conditionDir, "context-map.json"), "utf8")
    .catch(() => undefined);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      blobs?: Record<string, { fidelity?: string }>;
    };
    return parsed.blobs?.session_summary?.fidelity;
  } catch {
    return undefined;
  }
}

function isHiddenFidelity(fidelity: string | undefined) {
  return fidelity === "drop" || fidelity === "placeholder";
}

function emptyTokenBucket(): TokenBucket {
  return {
    messages: 0,
    assistant: 0,
    input: 0,
    output: 0,
    total: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolCalls: 0,
    maxInput: 0,
  };
}

function summarizeTokens(messages: SessionMessage[]) {
  const bucket = emptyTokenBucket();
  for (const message of messages) {
    bucket.messages++;
    const role = message.info?.role ?? message.role;
    if (role !== "assistant") continue;
    bucket.assistant++;
    bucket.toolCalls += toolParts(message.parts).length;
    const tokens = message.info?.tokens;
    if (!tokens) continue;
    bucket.input += tokens.input ?? 0;
    bucket.output += tokens.output ?? 0;
    bucket.total += tokens.total ?? 0;
    bucket.reasoning += tokens.reasoning ?? 0;
    bucket.cacheRead += tokens.cache?.read ?? 0;
    bucket.cacheWrite += tokens.cache?.write ?? 0;
    bucket.maxInput = Math.max(bucket.maxInput, tokens.input ?? 0);
  }
  return bucket;
}

function cacheHitShare(bucket: TokenBucket) {
  const denominator = bucket.input + bucket.cacheRead;
  return denominator === 0 ? null : bucket.cacheRead / denominator;
}

async function writeRunAnalysis(outDir: string) {
  const analysis = await analyzeRun(outDir);
  await writeAnalysisFiles(outDir, analysis);
}

async function writeAnalysisFiles(outDir: string, analysis: RunAnalysis) {
  await fs.writeFile(
    path.join(outDir, "analysis.json"),
    `${JSON.stringify(analysis, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(outDir, "analysis.md"),
    runAnalysisMarkdown(analysis),
  );
}

async function analyzeRun(outDir: string): Promise<RunAnalysis> {
  const rows: AnalysisRow[] = [];
  const conditionsDir = path.join(outDir, "conditions");
  const conditionEntries = await fs
    .readdir(conditionsDir, { withFileTypes: true })
    .catch(() => []);
  for (const conditionEntry of conditionEntries) {
    if (!conditionEntry.isDirectory()) continue;
    const conditionID = conditionEntry.name as ConditionID;
    const conditionDir = path.join(conditionsDir, conditionEntry.name);
    const canaryEntries = await fs
      .readdir(conditionDir, { withFileTypes: true })
      .catch(() => []);
    for (const canaryEntry of canaryEntries) {
      if (!canaryEntry.isDirectory()) continue;
      const canaryID = canaryEntry.name as CanaryID;
      const statsPath = path.join(conditionDir, canaryEntry.name, "stats.json");
      const raw = await fs.readFile(statsPath, "utf8").catch(() => undefined);
      if (!raw) continue;
      const stats = JSON.parse(raw) as Record<string, unknown>;
      if (stats.error) continue;
      const tokens = normalizeTokenBucket(stats.tokens);
      rows.push({
        condition: conditionID,
        canary: canaryID,
        contextHygienePassed: Boolean(stats.context_hygiene_passed),
        canaryPassed: Boolean(stats.canary_passed),
        currentTaskTermHits: stringArray(stats.current_task_term_hits),
        staleTermsInOutput: stringArray(stats.stale_terms_in_output),
        staleTermsInCompactionSummary: stringArray(
          stats.stale_terms_in_compaction_summary,
        ),
        staleTermsInVisibleCompactionSummary: stringArray(
          stats.stale_terms_in_visible_compaction_summary,
        ),
        sessionSummaryFidelity:
          typeof stats.session_summary_fidelity === "string"
            ? stats.session_summary_fidelity
            : undefined,
        contextToolCalls: Number(stats.context_tool_call_count ?? 0) || 0,
        toolCalls: Number(stats.tool_call_count ?? 0) || 0,
        tokens,
        cacheHitShare: cacheHitShare(tokens),
        outputPreview:
          typeof stats.output_preview === "string" ? stats.output_preview : "",
      });
    }
  }
  return {
    outDir,
    generatedAt: new Date().toISOString(),
    rows: rows.sort((a, b) =>
      a.canary === b.canary
        ? a.condition.localeCompare(b.condition)
        : a.canary.localeCompare(b.canary),
    ),
  };
}

function normalizeTokenBucket(value: unknown) {
  const record = value && typeof value === "object" ? value : {};
  const item = record as Record<string, unknown>;
  return {
    messages: Number(item.messages ?? 0) || 0,
    assistant: Number(item.assistant ?? 0) || 0,
    input: Number(item.input ?? 0) || 0,
    output: Number(item.output ?? 0) || 0,
    total: Number(item.total ?? 0) || 0,
    reasoning: Number(item.reasoning ?? 0) || 0,
    cacheRead: Number(item.cacheRead ?? 0) || 0,
    cacheWrite: Number(item.cacheWrite ?? 0) || 0,
    toolCalls: Number(item.toolCalls ?? 0) || 0,
    maxInput: Number(item.maxInput ?? 0) || 0,
  } satisfies TokenBucket;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function runAnalysisMarkdown(analysis: RunAnalysis) {
  const byCondition = new Map<ConditionID, AnalysisRow[]>();
  for (const row of analysis.rows) {
    const rows = byCondition.get(row.condition) ?? [];
    rows.push(row);
    byCondition.set(row.condition, rows);
  }
  const aggregateRows = Array.from(byCondition.entries()).map(
    ([condition, rows]) => {
      const tokens = combineTokenBuckets(rows.map((row) => row.tokens));
      const hygiene = rows.filter((row) => row.contextHygienePassed).length;
      const passed = rows.filter((row) => row.canaryPassed).length;
      return `| ${condition} | ${passed}/${rows.length} | ${hygiene}/${rows.length} | ${tokens.input.toLocaleString()} | ${tokens.cacheRead.toLocaleString()} | ${formatPercent(cacheHitShare(tokens))} |`;
    },
  );
  return [
    "# Context Canary Analysis",
    "",
    `- Run: ${analysis.outDir}`,
    `- Generated: ${analysis.generatedAt}`,
    "",
    "## Aggregate",
    "",
    "| Condition | Canary Pass | Hygiene Pass | Input Tok | Cache Read Tok | Cache Hit Share |",
    "|---|---:|---:|---:|---:|---:|",
    ...aggregateRows,
    "",
    "## Rows",
    "",
    "| Canary | Condition | Canary Pass | Hygiene Pass | Current Terms | Stale Output | Visible Stale Summary | Summary Fidelity | Context Tools | Input Tok | Cache Hit |",
    "|---|---|---:|---:|---|---|---|---|---:|---:|---:|",
    ...analysis.rows.map(
      (row) =>
        `| ${row.canary} | ${row.condition} | ${String(row.canaryPassed)} | ${String(row.contextHygienePassed)} | ${escapeCell(row.currentTaskTermHits.join(", "))} | ${escapeCell(row.staleTermsInOutput.join(", "))} | ${escapeCell(row.staleTermsInVisibleCompactionSummary.join(", "))} | ${row.sessionSummaryFidelity ?? ""} | ${row.contextToolCalls} | ${row.tokens.input.toLocaleString()} | ${formatPercent(row.cacheHitShare)} |`,
    ),
    "",
  ].join("\n");
}

function combineTokenBuckets(buckets: TokenBucket[]) {
  const total = emptyTokenBucket();
  for (const bucket of buckets) {
    total.messages += bucket.messages;
    total.assistant += bucket.assistant;
    total.input += bucket.input;
    total.output += bucket.output;
    total.total += bucket.total;
    total.reasoning += bucket.reasoning;
    total.cacheRead += bucket.cacheRead;
    total.cacheWrite += bucket.cacheWrite;
    total.toolCalls += bucket.toolCalls;
    total.maxInput = Math.max(total.maxInput, bucket.maxInput);
  }
  return total;
}

async function writeSummary(
  outDir: string,
  results: RunResult[],
  options: Options,
) {
  const lines = [
    "# Context Canary Run",
    "",
    `- Model: ${options.modelSlug}`,
    `- Canaries: ${options.canaries.join(", ")}`,
    `- Conditions: ${options.conditions.join(", ")}`,
    "",
    "## Results",
    "",
    "| Canary | Condition | Canary Pass | Hygiene Pass | Stats | Error |",
    "|---|---|---:|---:|---|---|",
    ...results.map((result) => {
      const relStats = path.relative(outDir, result.statsPath);
      const error = result.error
        ? result.error.split("\n")[0]?.replaceAll("|", "\\|")
        : "";
      return `| ${result.canary} | ${result.condition} | ${result.canaryPassed === undefined ? "" : String(result.canaryPassed)} | ${result.contextHygienePassed === undefined ? "" : String(result.contextHygienePassed)} | [stats](${relStats}) | ${error} |`;
    }),
    "",
    "## Caveat",
    "",
    "These canaries test context-management failure modes. They are not SWE-bench or product-wide reliability scores.",
    "",
  ];
  await fs.writeFile(path.join(outDir, "summary.md"), `${lines.join("\n")}\n`);
}

function escapeCell(value: string) {
  return value.replaceAll("|", "\\|");
}

function formatPercent(value: number | null) {
  return value === null ? "" : `${(value * 100).toFixed(1)}%`;
}

function timestampForPath(date: Date) {
  return date.toISOString().replaceAll(":", "").replaceAll(".", "-");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
