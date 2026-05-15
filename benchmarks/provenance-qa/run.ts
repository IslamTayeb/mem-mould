import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";

import {
  parseModelSlug,
  requiredModelSlug,
  type ModelRef,
} from "../../tools/model";

const execFileAsync = promisify(execFile);

type ConditionID =
  | "full-transcript"
  | "keyword-snippets"
  | "rlm-transcript-search"
  | "subagent-rlm-transcript-search"
  | "memmould-map-zoom"
  | "subagent-map-zoom";

type Options = {
  conditions: ConditionID[];
  outDir: string;
  modelSlug: string;
  promptTimeoutMs: number;
  prepareOnly: boolean;
  keepWorktrees: boolean;
  analyzeRun?: string;
};

type SessionMessage = {
  info?: {
    id?: string;
    role?: string;
    finish?: string;
    summary?: boolean;
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
    state?: {
      status?: string;
      input?: unknown;
      output?: unknown;
      metadata?: Record<string, unknown>;
    };
    metadata?: Record<string, unknown>;
  }>;
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

type SeededSessions = {
  relevantSessionID?: string;
  relevantMessageIDs: string[];
  sessions: Array<{
    id: string;
    title: string;
    role: "relevant" | "distractor";
  }>;
};

type RunResult = {
  condition: ConditionID;
  statsPath: string;
  messagesPath: string;
  error?: string;
  answerPassed?: boolean;
  provenancePassed?: boolean;
  benchmarkPassed?: boolean;
  childMessagesPath?: string;
};

type AnalysisRow = {
  condition: ConditionID;
  answerPassed: boolean;
  provenancePassed: boolean;
  benchmarkPassed: boolean;
  requiredHits: string[];
  missingRequired: string[];
  forbiddenHits: string[];
  citationHits: string[];
  toolCalls: number;
  contextToolCalls: number;
  taskToolCalls: number;
  messageDetailCalls: number;
  searchToolCalls: number;
  readToolCalls: number;
  transcriptFilesRead: string[];
  irrelevantTranscriptReads: string[];
  fullTranscriptPrompt: boolean;
  tokens: TokenBucket;
  cacheHitShare: number | null;
  outputPreview: string;
};

type ParsedAnswer = {
  answer?: unknown;
  why_not_global_mutex?: unknown;
};

type RunAnalysis = {
  outDir: string;
  generatedAt: string;
  rows: AnalysisRow[];
};

type PromptInput = {
  system: string;
  tools?: Record<string, boolean>;
  text: string;
};

const repoRoot = path.resolve(process.cwd());
const defaultOutDir = path.join(
  repoRoot,
  "benchmarks",
  "provenance-qa",
  "runs",
  timestampForPath(new Date()),
);

const conditions: Record<ConditionID, { plugin: boolean; subagent: boolean }> =
  {
    "full-transcript": { plugin: false, subagent: false },
    "keyword-snippets": { plugin: false, subagent: false },
    "rlm-transcript-search": { plugin: false, subagent: false },
    "subagent-rlm-transcript-search": { plugin: false, subagent: true },
    "memmould-map-zoom": { plugin: true, subagent: false },
    "subagent-map-zoom": { plugin: true, subagent: true },
  };

const fixture = {
  id: "auth-queue-rationale",
  question:
    "Why does src/auth/queue.ts deduplicate refresh work per tenant instead of using one global mutex?",
  required: [
    {
      id: "per_tenant",
      patterns: [
        /per[- ]tenant/i,
        /by tenant/i,
        /same[- ]tenant[\s\S]{0,160}different tenants/i,
        /different tenants[\s\S]{0,160}same[- ]tenant/i,
      ],
    },
    {
      id: "same_tenant_coalesce",
      patterns: [/same[- ]tenant/i, /coalesc/i, /deduplicat/i],
    },
    {
      id: "different_tenants_parallel",
      patterns: [/different tenants/i, /parallel/i],
    },
    {
      id: "global_mutex_rejected",
      patterns: [
        /global mutex/i,
        /rejected/i,
        /avoid(?:s|ed)? global serialization/i,
      ],
    },
  ],
  forbidden: [
    "billing retry",
    "markdown parser",
    "onboarding docs",
    "tenant parser",
    "quickstart",
  ],
  relevantTitle: "Auth refresh queue rationale",
  relevantSeed: [
    "This is a prior coding-session record for src/auth/queue.ts.",
    "The rejected design was one global mutex around all auth refresh work.",
    "The global mutex was rejected because the test auth_refresh_different_tenants_parallel showed unrelated tenants must not block each other.",
    "The chosen design is RefreshQueue with a per-tenant key.",
    "The rationale is: same-tenant duplicate refresh requests should coalesce into one refresh, while different tenants should continue in parallel.",
    "The targeted regression tests are auth_refresh_deduplicates_parallel_requests and auth_refresh_different_tenants_parallel.",
    "The rollback flag is FLAG_AUTH_QUEUE_ROLLBACK, but the flag is not the reason for per-tenant dedupe.",
  ].join("\n"),
  distractors: [
    {
      title: "Billing retry queue rationale",
      text: [
        "This prior session is about billing retry queues, not auth refresh.",
        "It used a global mutex because the billing provider rate-limit endpoint serializes all tenants anyway.",
        "Do not apply this to src/auth/queue.ts; it is a distractor with similar queue and tenant words.",
      ].join("\n"),
    },
    {
      title: "Markdown parser onboarding cleanup",
      text: [
        "This prior session is about onboarding docs and a markdown parser cache bug.",
        "It mentions a contributor quickstart and docs generation, not auth refresh or tenant dedupe.",
        "The parser hypothesis was stale and should never explain src/auth/queue.ts.",
      ].join("\n"),
    },
  ],
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
    console.log(`Prepared provenance QA metadata at ${options.outDir}`);
    return;
  }

  const model = parseModelSlug(options.modelSlug);
  const results: RunResult[] = [];
  for (const conditionID of options.conditions) {
    const result = await runCondition(conditionID, model, options);
    results.push(result);
    await writeSummary(options.outDir, results, options);
  }

  await writeSummary(options.outDir, results, options);
  await writeRunAnalysis(options.outDir).catch((error) => {
    console.warn(`Could not write provenance QA analysis: ${String(error)}`);
  });
  console.log(`Provenance QA artifacts written to ${options.outDir}`);
}

async function runCondition(
  conditionID: ConditionID,
  model: ModelRef,
  options: Options,
): Promise<RunResult> {
  const condition = conditions[conditionID];
  const conditionDir = path.join(options.outDir, "conditions", conditionID);
  const worktree = path.join(conditionDir, "worktree");
  await fs.mkdir(conditionDir, { recursive: true });

  const resultBase: RunResult = {
    condition: conditionID,
    statsPath: path.join(conditionDir, "stats.json"),
    messagesPath: path.join(conditionDir, "messages.json"),
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
    });
    server = await startServer(env, worktree);
    const client = createOpencodeClient({ baseUrl: server.url });
    await pickModel(client, worktree, options.modelSlug);

    const seeded = condition.plugin
      ? await seedHistoricalSessions(client, worktree, options.promptTimeoutMs)
      : emptySeededSessions();

    const sessionID = await createSession(
      client,
      worktree,
      `${conditionID} provenance qa`,
    );
    const promptInput = buildPromptForCondition(conditionID, seeded, worktree);
    await prompt(
      client,
      worktree,
      sessionID,
      promptInput.text,
      promptInput.system,
      promptInput.tools,
      options.promptTimeoutMs,
    );

    const messages = await listSessionMessages(client, worktree, sessionID);
    const childMessages = await collectChildMessages(
      client,
      worktree,
      messages,
    );
    await fs.writeFile(
      resultBase.messagesPath,
      `${JSON.stringify(messages, null, 2)}\n`,
    );
    if (childMessages.length > 0) {
      const childMessagesPath = path.join(conditionDir, "child-messages.json");
      await fs.writeFile(
        childMessagesPath,
        `${JSON.stringify(childMessages, null, 2)}\n`,
      );
      resultBase.childMessagesPath = childMessagesPath;
    }
    await writeSeedManifest(conditionDir, seeded);
    const stats = buildStats({
      conditionID,
      seeded,
      messages,
      childMessages,
      startedAt,
      fullTranscriptPrompt: conditionID === "full-transcript",
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
      answerPassed: stats.answer_passed,
      provenancePassed: stats.provenance_passed,
      benchmarkPassed: stats.benchmark_passed,
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
  const conditionList = (
    conditionArg
      ? splitList(conditionArg)
      : [
          "full-transcript",
          "keyword-snippets",
          "rlm-transcript-search",
          "subagent-rlm-transcript-search",
          "memmould-map-zoom",
          "subagent-map-zoom",
        ]
  ) as ConditionID[];
  for (const condition of conditionList) {
    assert.ok(
      condition in conditions,
      `unknown condition ${condition}; expected one of ${Object.keys(conditions).join(", ")}`,
    );
  }

  const timeoutMinutes = Number(
    valueArg(args, "--prompt-timeout-minutes") ?? "10",
  );
  assert.ok(Number.isFinite(timeoutMinutes) && timeoutMinutes > 0);
  const analyzeRun = valueArg(args, "--analyze-run");

  return {
    conditions: conditionList,
    outDir: path.resolve(valueArg(args, "--out") ?? defaultOutDir),
    modelSlug: requiredModelSlug(),
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

async function prepareFixtureRepo(worktree: string) {
  await fs.rm(worktree, { recursive: true, force: true });
  await fs.mkdir(path.join(worktree, "src", "auth"), { recursive: true });
  await fs.writeFile(
    path.join(worktree, "README.md"),
    [
      "# Provenance Fixture",
      "",
      "Small fixture repository for mem-mould provenance QA.",
      "The active question is about why auth refresh uses per-tenant queueing.",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(worktree, "src", "auth", "queue.ts"),
    [
      "export class RefreshQueue {",
      "  private readonly inflight = new Map<string, Promise<string>>();",
      "",
      "  enqueueRefresh(tenantID: string, refresh: () => Promise<string>) {",
      "    const existing = this.inflight.get(tenantID);",
      "    if (existing) return existing;",
      "    const next = refresh().finally(() => this.inflight.delete(tenantID));",
      "    this.inflight.set(tenantID, next);",
      "    return next;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  await writeSearchableTranscriptCorpus(worktree);
  await execFileAsync("git", ["init"], { cwd: worktree });
  await execFileAsync("git", ["add", "."], { cwd: worktree });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Provenance QA",
      "-c",
      "user.email=provenance@example.com",
      "commit",
      "-m",
      "seed auth queue fixture",
    ],
    { cwd: worktree },
  );
}

async function writeSearchableTranscriptCorpus(worktree: string) {
  const transcriptsDir = path.join(worktree, "memory", "transcripts");
  await fs.mkdir(transcriptsDir, { recursive: true });
  await fs.writeFile(
    path.join(worktree, "memory", "manifest.json"),
    `${JSON.stringify(
      {
        corpus: "synthetic prior-agent transcripts",
        transcript_dir: "memory/transcripts",
        sessions: [
          {
            session_id: "auth_refresh_session",
            title: fixture.relevantTitle,
            file: "auth_refresh_session.md",
          },
          {
            session_id: "billing_retry_session",
            title: "Billing retry queue rationale",
            file: "billing_retry_session.md",
          },
          {
            session_id: "markdown_parser_session",
            title: "Markdown parser onboarding cleanup",
            file: "markdown_parser_session.md",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(transcriptsDir, "auth_refresh_session.md"),
    [
      "# Auth refresh queue rationale",
      "session_id: auth_refresh_session",
      "title: Auth refresh queue rationale",
      "",
      "## message auth_fact_1",
      "The rejected design was one global mutex around all auth refresh work.",
      "",
      "## message auth_fact_2",
      "The global mutex was rejected because auth_refresh_different_tenants_parallel showed unrelated tenants must not block each other.",
      "",
      "## message auth_fact_3",
      "RefreshQueue in src/auth/queue.ts uses a per-tenant key. The complete rationale is that same-tenant duplicate refresh requests coalesce into one refresh, while different tenants continue in parallel.",
      "",
      "## message auth_fact_4",
      "The rollback flag FLAG_AUTH_QUEUE_ROLLBACK exists, but the flag is not the reason for per-tenant dedupe.",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(transcriptsDir, "billing_retry_session.md"),
    [
      "# Billing retry queue rationale",
      "session_id: billing_retry_session",
      "title: Billing retry queue rationale",
      "",
      "## message billing_fact_1",
      "Billing retry queues used a global mutex because provider limits serialize all tenants.",
      "",
      "## message billing_fact_2",
      "This session is a distractor and should not explain src/auth/queue.ts.",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(transcriptsDir, "markdown_parser_session.md"),
    [
      "# Markdown parser onboarding cleanup",
      "session_id: markdown_parser_session",
      "title: Markdown parser onboarding cleanup",
      "",
      "## message docs_fact_1",
      "Markdown parser cache issues affected onboarding docs and quickstart text.",
      "",
      "## message docs_fact_2",
      "This docs cleanup is unrelated to auth refresh queue behavior.",
      "",
    ].join("\n"),
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
      pathToFileURL(path.join(repoRoot, "src", "server-plugin.ts")).href,
    ];
  }
  const authContent = await seededAuthContent();
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
    MEM_MOULD_CACHE_STABLE: "1",
    MEM_MOULD_STABLE_PLACEHOLDERS: "1",
    MEM_MOULD_STABLE_ANCHORS: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    ...(authContent ? { OPENCODE_AUTH_CONTENT: authContent } : {}),
  } satisfies NodeJS.ProcessEnv;
}

async function seededAuthContent() {
  const seeded = process.env.MEM_MOULD_E2E_TEMP_ROOT;
  if (!seeded) return undefined;
  const authPath = path.join(seeded, "data", "opencode", "auth.json");
  return await fs.readFile(authPath, "utf8").catch(() => undefined);
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

async function seedHistoricalSessions(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  timeoutMs: number,
): Promise<SeededSessions> {
  const sessions: SeededSessions["sessions"] = [];
  const relevantSessionID = await createSession(
    client,
    directory,
    fixture.relevantTitle,
  );
  sessions.push({
    id: relevantSessionID,
    title: fixture.relevantTitle,
    role: "relevant",
  });
  await prompt(
    client,
    directory,
    relevantSessionID,
    fixture.relevantSeed,
    seedSystemPrompt(),
    {},
    timeoutMs,
  );

  for (const item of fixture.distractors) {
    const sessionID = await createSession(client, directory, item.title);
    sessions.push({ id: sessionID, title: item.title, role: "distractor" });
    await prompt(
      client,
      directory,
      sessionID,
      item.text,
      seedSystemPrompt(),
      {},
      timeoutMs,
    );
  }

  const relevantMessages = await listSessionMessages(
    client,
    directory,
    relevantSessionID,
  );
  return {
    relevantSessionID,
    relevantMessageIDs: relevantMessages
      .map((message) => message.info?.id)
      .filter((id): id is string => Boolean(id)),
    sessions,
  };
}

function emptySeededSessions(): SeededSessions {
  return {
    relevantMessageIDs: ["auth_fact_3"],
    sessions: [
      {
        id: "auth_refresh_session",
        title: fixture.relevantTitle,
        role: "relevant",
      },
      {
        id: "billing_retry_session",
        title: "Billing retry queue rationale",
        role: "distractor",
      },
      {
        id: "markdown_parser_session",
        title: "Markdown parser onboarding cleanup",
        role: "distractor",
      },
    ],
  };
}

function seedSystemPrompt() {
  return [
    "You are preserving a prior coding-session fact record for a future provenance benchmark.",
    "Do not edit files and do not call tools.",
    "Reply with one concise acknowledgement that preserves the important rationale in your own words.",
  ].join("\n");
}

function buildPromptForCondition(
  conditionID: ConditionID,
  seeded: SeededSessions,
  worktree: string,
): PromptInput {
  const answerContract = [
    "Return compact JSON only with this shape:",
    '{"answer":"...","evidence":{"session_id":"...","blob_id":"...","message_id":"..."},"why_not_global_mutex":"...","irrelevant_context_ignored":["..."]}',
    "The answer must cite the exact source identifiers you used. If a field is unavailable, use an empty string.",
  ].join("\n");

  if (conditionID === "full-transcript") {
    return {
      system: "Answer with compact JSON only. Do not call tools.",
      tools: undefined,
      text: [
        "You are given the full prior transcript bundle below.",
        "Use it to answer the provenance question and cite the provided source ids.",
        "",
        staticTranscriptBundle(),
        "",
        `Question: ${fixture.question}`,
        answerContract,
      ].join("\n"),
    };
  }

  if (conditionID === "keyword-snippets") {
    return {
      system: "Answer with compact JSON only. Do not call tools.",
      tools: undefined,
      text: [
        "A naive keyword search returned the following snippets. Some snippets are distractors.",
        "Use only snippets that directly explain src/auth/queue.ts.",
        "",
        keywordSnippetBundle(),
        "",
        `Question: ${fixture.question}`,
        answerContract,
      ].join("\n"),
    };
  }

  if (conditionID === "rlm-transcript-search") {
    const transcriptDir = path.join(worktree, "memory", "transcripts");
    return {
      system: [
        "Answer with compact JSON only.",
        "Use the file tools to search prior transcript files before answering.",
        "Required tool flow: glob memory/transcripts/*.md, grep relevant terms, then read the best transcript file.",
        "Cite exact session_id and message_id from the transcript evidence. Do not cite a message unless it supports the full rationale.",
      ].join("\n"),
      tools: { glob: true, grep: true, read: true },
      text: [
        "Prior agent memory is stored as searchable transcript files on disk.",
        `Transcript directory: ${transcriptDir}`,
        "The files include distractor sessions. Search and read selectively; do not use prior knowledge alone.",
        `Question: ${fixture.question}`,
        answerContract,
      ].join("\n"),
    };
  }

  if (conditionID === "subagent-rlm-transcript-search") {
    const transcriptDir = path.join(worktree, "memory", "transcripts");
    return {
      system: [
        "Answer with compact JSON only.",
        "Use the Task tool exactly once with a general sub-agent to investigate searchable transcript files.",
        "The sub-agent must use glob, grep, and read before answering you.",
        "Use the sub-agent result to produce final JSON with exact session_id and message_id.",
      ].join("\n"),
      tools: { task: true },
      text: [
        "Current task: answer a provenance question from prior transcript memory without loading transcript files into this parent session.",
        `Transcript directory: ${transcriptDir}`,
        `Question: ${fixture.question}`,
        "Ask the sub-agent to ignore billing retry and markdown parser distractor transcripts.",
        "The sub-agent must not cite a message unless it supports the full same-tenant coalescing plus different-tenant parallelism rationale.",
        answerContract,
      ].join("\n"),
    };
  }

  if (conditionID === "subagent-map-zoom") {
    return {
      system: [
        "Answer with compact JSON only.",
        "Use the Task tool exactly once with a general sub-agent to investigate the prior-session provenance.",
        "The sub-agent must use session_lookup, then session_detail with detail='messages', then message_detail for one exact message before answering you.",
        "Use the sub-agent result to produce the final JSON answer with exact ids.",
      ].join("\n"),
      tools: { task: true, session_tree: true },
      text: [
        "Current task: answer a provenance question from prior session memory without loading all transcripts into this parent session.",
        `Question: ${fixture.question}`,
        `Expected relevant prior-session title: ${fixture.relevantTitle}`,
        "Ask the sub-agent to ignore billing retry and markdown parser distractor sessions.",
        answerContract,
      ].join("\n"),
    };
  }

  return {
    system: [
      "Answer with compact JSON only.",
      "Use session_lookup first, then session_detail with detail='messages', then message_detail for one exact message before answering.",
      "Do not use full transcript replay. Cite exact session_id, blob_id, and message_id from the tools.",
    ].join("\n"),
    tools: {
      session_lookup: true,
      session_detail: true,
      message_detail: true,
      session_tree: true,
    },
    text: [
      "Current task: answer a provenance question from prior session memory.",
      `Question: ${fixture.question}`,
      `Search hint: ${fixture.relevantTitle}; ignore billing retry and markdown parser distractors.`,
      answerContract,
    ].join("\n"),
  };
}

function staticTranscriptBundle() {
  return [
    "<session id=auth_refresh_session title=Auth refresh queue rationale>",
    "<message id=auth_fact_1>The rejected design was one global mutex around all auth refresh work.</message>",
    "<message id=auth_fact_2>The global mutex was rejected because auth_refresh_different_tenants_parallel showed unrelated tenants must not block each other.</message>",
    "<message id=auth_fact_3>The chosen design is RefreshQueue with a per-tenant key: same-tenant duplicate refreshes coalesce, while different tenants continue in parallel.</message>",
    "</session>",
    "<session id=billing_retry_session title=Billing retry queue rationale>",
    "<message id=billing_fact_1>Billing retry queues used a global mutex because the billing provider serializes all tenants.</message>",
    "</session>",
    "<session id=markdown_parser_session title=Markdown parser onboarding cleanup>",
    "<message id=docs_fact_1>Markdown parser cache issues affected onboarding docs and quickstart text.</message>",
    "</session>",
  ].join("\n");
}

function keywordSnippetBundle() {
  return [
    "<snippet session_id=billing_retry_session message_id=billing_fact_1>Billing retry queues used a global mutex because provider limits serialize all tenants.</snippet>",
    "<snippet session_id=markdown_parser_session message_id=docs_fact_1>Onboarding docs mention a queue of markdown parser jobs and a quickstart cleanup.</snippet>",
    "<snippet session_id=auth_refresh_session message_id=auth_fact_1>The rejected design was one global mutex around all auth refresh work.</snippet>",
    "<snippet session_id=auth_refresh_session message_id=auth_fact_2>The global mutex was rejected because auth_refresh_different_tenants_parallel showed unrelated tenants must not block each other.</snippet>",
  ].join("\n");
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

async function writeSeedManifest(conditionDir: string, seeded: SeededSessions) {
  await fs.writeFile(
    path.join(conditionDir, "seeded-sessions.json"),
    `${JSON.stringify(seeded, null, 2)}\n`,
  );
}

function buildStats(input: {
  conditionID: ConditionID;
  seeded: SeededSessions;
  messages: SessionMessage[];
  childMessages: Array<{ sessionID: string; messages: SessionMessage[] }>;
  startedAt: number;
  fullTranscriptPrompt: boolean;
}) {
  const outputText = messageText(latestAssistantMessage(input.messages));
  const parsed = parseAnswer(outputText);
  const correctnessText = parsed
    ? [parsed.answer, parsed.why_not_global_mutex]
        .filter((item): item is string => typeof item === "string")
        .join("\n")
    : outputText;
  const requiredHits = fixture.required
    .filter((item) =>
      item.patterns.some((pattern) => pattern.test(correctnessText)),
    )
    .map((item) => item.id);
  const missingRequired = fixture.required
    .filter((item) => !requiredHits.includes(item.id))
    .map((item) => item.id);
  const forbiddenHits = termsInText(fixture.forbidden, correctnessText);
  const citationHits = citationMatches(outputText, input.seeded);
  const childFlatMessages = input.childMessages.flatMap(
    (item) => item.messages,
  );
  const tools = toolParts([...input.messages, ...childFlatMessages]);
  const toolNames = tools.map((part) => part.tool).filter(Boolean) as string[];
  const transcriptFilesRead = transcriptReadFiles(tools);
  const irrelevantTranscriptReads = transcriptFilesRead.filter((file) =>
    /billing_retry_session|markdown_parser_session/.test(file),
  );
  const answerPassed =
    missingRequired.length === 0 && forbiddenHits.length === 0;
  const provenancePassed =
    citationHits.includes("session") && citationHits.includes("message");

  return {
    condition: input.conditionID,
    fixture: fixture.id,
    duration_ms: Date.now() - input.startedAt,
    output_preview: outputText.slice(0, 1200),
    required_hits: requiredHits,
    missing_required: missingRequired,
    forbidden_hits: forbiddenHits,
    citation_hits: citationHits,
    relevant_session_id:
      input.seeded.relevantSessionID ?? "auth_refresh_session",
    relevant_message_ids: input.seeded.relevantMessageIDs,
    tool_call_count: toolNames.length,
    tool_names: toolNames,
    context_tool_call_count: toolNames.filter((tool) =>
      [
        "session_lookup",
        "session_detail",
        "message_detail",
        "session_tree",
      ].includes(tool),
    ).length,
    task_tool_call_count: toolNames.filter((tool) => tool === "task").length,
    message_detail_call_count: toolNames.filter(
      (tool) => tool === "message_detail",
    ).length,
    search_tool_call_count: toolNames.filter((tool) =>
      ["glob", "grep"].includes(tool),
    ).length,
    read_tool_call_count: toolNames.filter((tool) => tool === "read").length,
    transcript_files_read: transcriptFilesRead,
    irrelevant_transcript_reads: irrelevantTranscriptReads,
    child_session_count: input.childMessages.length,
    child_context_tool_call_count: toolParts(childFlatMessages).filter((part) =>
      [
        "session_lookup",
        "session_detail",
        "message_detail",
        "session_tree",
      ].includes(String(part.tool ?? "")),
    ).length,
    full_transcript_prompt: input.fullTranscriptPrompt,
    parent_tokens: summarizeTokens(input.messages),
    child_tokens: summarizeTokens(childFlatMessages),
    tokens: summarizeTokens([...input.messages, ...childFlatMessages]),
    answer_passed: answerPassed,
    provenance_passed: provenancePassed,
    benchmark_passed: answerPassed && provenancePassed,
  };
}

function transcriptReadFiles(
  tools: Array<NonNullable<SessionMessage["parts"]>[number]>,
) {
  return tools
    .filter((part) => part.tool === "read")
    .map((part) => {
      const input =
        part.state?.input && typeof part.state.input === "object"
          ? (part.state.input as Record<string, unknown>)
          : {};
      const filePath = typeof input.filePath === "string" ? input.filePath : "";
      return filePath;
    })
    .filter((filePath) => filePath.includes("memory/transcripts"));
}

async function collectChildMessages(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  parentMessages: SessionMessage[],
) {
  const childSessionIDs = extractChildSessionIDs(parentMessages);
  const childMessages: Array<{
    sessionID: string;
    messages: SessionMessage[];
  }> = [];
  for (const sessionID of childSessionIDs) {
    childMessages.push({
      sessionID,
      messages: await listSessionMessages(client, directory, sessionID),
    });
  }
  return childMessages;
}

function extractChildSessionIDs(messages: SessionMessage[]) {
  const ids = new Set<string>();
  for (const part of toolParts(messages)) {
    if (part.tool !== "task") continue;
    const output =
      typeof part.state?.output === "string" ? part.state.output : "";
    const outputID = output.match(/task_id:\s*(\S+)/)?.[1];
    if (outputID) ids.add(outputID);
    const metadata = part.state?.metadata ?? part.metadata ?? {};
    if (typeof metadata.sessionId === "string") ids.add(metadata.sessionId);
  }
  return [...ids];
}

function parseAnswer(outputText: string): ParsedAnswer | undefined {
  try {
    const direct = JSON.parse(outputText) as ParsedAnswer;
    if (direct && typeof direct === "object") return direct;
  } catch {}
  const match = outputText.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    const extracted = JSON.parse(match[0]) as ParsedAnswer;
    if (extracted && typeof extracted === "object") return extracted;
  } catch {}
  return undefined;
}

function citationMatches(outputText: string, seeded: SeededSessions) {
  const hits: string[] = [];
  const sessionID = seeded.relevantSessionID ?? "auth_refresh_session";
  if (
    outputText.includes(sessionID) ||
    outputText.includes(fixture.relevantTitle)
  ) {
    hits.push("session");
  }
  if (seeded.relevantMessageIDs.some((id) => outputText.includes(id))) {
    hits.push("message");
  }
  if (
    /blob[_-]?id/i.test(outputText) &&
    !/"blob_id"\s*:\s*""/.test(outputText)
  ) {
    hits.push("blob");
  }
  return hits;
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

function termsInText(terms: string[], text: string) {
  const lowered = text.toLowerCase();
  return terms.filter((term) => lowered.includes(term.toLowerCase()));
}

function toolParts(messages: SessionMessage[]) {
  return messages.flatMap((message) =>
    (message.parts ?? []).filter((part) => part.type === "tool"),
  );
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
    bucket.toolCalls += (message.parts ?? []).filter(
      (part) => part.type === "tool",
    ).length;
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
  const conditionEntries = await fs
    .readdir(path.join(outDir, "conditions"), { withFileTypes: true })
    .catch(() => []);
  for (const entry of conditionEntries) {
    if (!entry.isDirectory()) continue;
    const statsPath = path.join(outDir, "conditions", entry.name, "stats.json");
    const raw = await fs.readFile(statsPath, "utf8").catch(() => undefined);
    if (!raw) continue;
    const stats = JSON.parse(raw) as Record<string, unknown>;
    if (stats.error) continue;
    const tokens = normalizeTokenBucket(stats.tokens);
    rows.push({
      condition: entry.name as ConditionID,
      answerPassed: Boolean(stats.answer_passed),
      provenancePassed: Boolean(stats.provenance_passed),
      benchmarkPassed: Boolean(stats.benchmark_passed),
      requiredHits: stringArray(stats.required_hits),
      missingRequired: stringArray(stats.missing_required),
      forbiddenHits: stringArray(stats.forbidden_hits),
      citationHits: stringArray(stats.citation_hits),
      toolCalls: Number(stats.tool_call_count ?? 0) || 0,
      contextToolCalls: Number(stats.context_tool_call_count ?? 0) || 0,
      taskToolCalls: Number(stats.task_tool_call_count ?? 0) || 0,
      messageDetailCalls: Number(stats.message_detail_call_count ?? 0) || 0,
      searchToolCalls: Number(stats.search_tool_call_count ?? 0) || 0,
      readToolCalls: Number(stats.read_tool_call_count ?? 0) || 0,
      transcriptFilesRead: stringArray(stats.transcript_files_read),
      irrelevantTranscriptReads: stringArray(stats.irrelevant_transcript_reads),
      fullTranscriptPrompt: Boolean(stats.full_transcript_prompt),
      tokens,
      cacheHitShare: cacheHitShare(tokens),
      outputPreview:
        typeof stats.output_preview === "string" ? stats.output_preview : "",
    });
  }
  return {
    outDir,
    generatedAt: new Date().toISOString(),
    rows: rows.sort((a, b) => a.condition.localeCompare(b.condition)),
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
  const rows = analysis.rows.map((row) => {
    return `| ${row.condition} | ${String(row.benchmarkPassed)} | ${String(row.answerPassed)} | ${String(row.provenancePassed)} | ${escapeCell(row.requiredHits.join(", "))} | ${escapeCell(row.missingRequired.join(", "))} | ${escapeCell(row.forbiddenHits.join(", "))} | ${escapeCell(row.citationHits.join(", "))} | ${row.contextToolCalls} | ${row.searchToolCalls} | ${row.readToolCalls} | ${row.taskToolCalls} | ${row.messageDetailCalls} | ${row.transcriptFilesRead.length} | ${row.irrelevantTranscriptReads.length} | ${row.tokens.input.toLocaleString()} | ${row.tokens.cacheRead.toLocaleString()} | ${formatPercent(row.cacheHitShare)} |`;
  });
  const totals = combineTokenBuckets(analysis.rows.map((row) => row.tokens));
  return [
    "# Provenance QA Analysis",
    "",
    `- Run: ${analysis.outDir}`,
    `- Generated: ${analysis.generatedAt}`,
    `- Passed: ${analysis.rows.filter((row) => row.benchmarkPassed).length}/${analysis.rows.length}`,
    `- Aggregate input tokens: ${totals.input.toLocaleString()}`,
    `- Aggregate cache-read tokens: ${totals.cacheRead.toLocaleString()}`,
    "",
    "## Rows",
    "",
    "| Condition | Pass | Answer | Provenance | Required Hits | Missing | Forbidden | Citations | Context Tools | Search Tools | Read Tools | Task Tools | Message Detail | Transcript Reads | Irrelevant Reads | Input Tok | Cache Read Tok | Cache Hit |",
    "|---|---:|---:|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows,
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
    "# Provenance QA Run",
    "",
    `- Model: ${options.modelSlug}`,
    `- Conditions: ${options.conditions.join(", ")}`,
    "",
    "## Results",
    "",
    "| Condition | Pass | Answer | Provenance | Stats | Error |",
    "|---|---:|---:|---:|---|---|",
    ...results.map((result) => {
      const relStats = path.relative(outDir, result.statsPath);
      const error = result.error
        ? result.error.split("\n")[0]?.replaceAll("|", "\\|")
        : "";
      return `| ${result.condition} | ${result.benchmarkPassed === undefined ? "" : String(result.benchmarkPassed)} | ${result.answerPassed === undefined ? "" : String(result.answerPassed)} | ${result.provenancePassed === undefined ? "" : String(result.provenancePassed)} | [stats](${relStats}) | ${error} |`;
    }),
    "",
    "## Caveat",
    "",
    "This benchmark tests provenance QA over synthetic prior sessions. It is not a coding-agent solve-rate benchmark.",
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
