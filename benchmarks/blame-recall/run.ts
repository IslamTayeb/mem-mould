import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";

import { parseModelSlug, requiredModelSlug } from "../../tools/model";
import {
  createSession as createOpenCodeSession,
  listProviders,
  listSessionMessages as listOpenCodeSessionMessages,
} from "../../tools/opencode-sdk";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(process.cwd());
const defaultOutDir = path.join(
  repoRoot,
  "benchmarks",
  "blame-recall",
  "runs",
  timestampSlug(),
);

type ConditionID =
  | "code-only"
  | "rlm-transcript-search"
  | "rlm-repl"
  | "decant-session-lookup"
  | "decant-blame"
  | "decant-blame-guided-rlm";

type CodeFile = { file: string; lines: string[] };

type MessageFact = {
  id: string;
  text: string;
  supportsAnswer?: boolean;
};

type HistoricalSession = {
  sessionID: string;
  title: string;
  messages: MessageFact[];
};

type BlameFixture = {
  id: string;
  title: string;
  question: string;
  sourceFiles: CodeFile[];
  target: { file: string; lineText: string };
  required: Array<{ id: string; patterns: RegExp[] }>;
  forbidden: string[];
  relevant: HistoricalSession;
  distractors: HistoricalSession[];
};

type SeededSessions = {
  relevantSessionID?: string;
  relevantMessageIDs: string[];
  sessions: Array<{
    id: string;
    title: string;
    role: "relevant" | "distractor" | "decoy";
  }>;
};

type SessionMessage = {
  id?: string;
  info?: {
    id?: string;
    role?: string;
    finish?: string;
    providerID?: string;
    modelID?: string;
    tokens?: {
      input?: number;
      output?: number;
      total?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
  error?: unknown;
  role?: string;
  parts?: Array<{
    type: string;
    text?: string;
    tool?: string;
    metadata?: Record<string, unknown>;
    state?: {
      status?: string;
      input?: unknown;
      output?: unknown;
      metadata?: Record<string, unknown>;
    };
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

type ToolCall = { name: string; input: unknown };

type RunStats = {
  fixture: string;
  title: string;
  condition: ConditionID;
  benchmark_passed: boolean;
  answer_passed: boolean;
  provenance_passed: boolean;
  tool_path_passed: boolean;
  tool_path_failures: string[];
  required_hits: string[];
  missing_required: string[];
  forbidden_hits: string[];
  citation_hits: string[];
  output_preview: string;
  tool_names: string[];
  transcript_files_read: string[];
  irrelevant_transcript_reads: string[];
  tokens: TokenBucket;
  duration_ms: number;
  relevant_session_id: string;
  relevant_message_ids: string[];
  target: { file: string; line: number; line_text: string };
  error?: string;
};

type Options = {
  conditions: ConditionID[];
  fixtures: string[];
  outDir: string;
  modelSlug: string;
  promptTimeoutMs: number;
  prepareOnly: boolean;
  analyzeRun?: string;
};

type PromptInput = {
  system: string;
  text: string;
  tools?: Record<string, boolean>;
};

type Analysis = {
  outDir: string;
  generatedAt: string;
  rows: RunStats[];
};

const defaultConditions: ConditionID[] = [
  "code-only",
  "rlm-transcript-search",
  "rlm-repl",
  "decant-session-lookup",
  "decant-blame",
  "decant-blame-guided-rlm",
];

const fixtures: BlameFixture[] = [
  {
    id: "blame-helpful-ttl-cap",
    title: "Presence TTL cap rationale",
    question:
      "Why does src/presence-cache.ts cap the requested presence TTL at 30 seconds instead of trusting the caller's TTL?",
    sourceFiles: [
      file("src/presence-cache.ts", [
        "export function ttlForPresence(requestedTtlMs: number) {",
        "  const ttlMs = Math.min(requestedTtlMs, 30_000);",
        "  return Math.max(ttlMs, 1_000);",
        "}",
      ]),
    ],
    target: {
      file: "src/presence-cache.ts",
      lineText: "  const ttlMs = Math.min(requestedTtlMs, 30_000);",
    },
    required: [
      { id: "ttl_cap", patterns: [/30\s*seconds?/i, /30_?000/i] },
      {
        id: "mobile_heartbeat",
        patterns: [/mobile/i, /25\s*seconds?\s*heartbeat/i, /heartbeat/i],
      },
      {
        id: "stale_presence",
        patterns: [/stale/i, /ghost/i, /disconnect/i, /presence/i],
      },
      {
        id: "caller_ttl_rejected",
        patterns: [/caller'?s? TTL/i, /trusting the caller/i, /2\s*minutes?/i],
      },
    ],
    forbidden: ["billing retry", "markdown parser", "payment provider"],
    relevant: {
      sessionID: "presence_ttl_cap_session",
      title: "Presence cache TTL cap decision",
      messages: [
        {
          id: "presence_fact_1",
          text: "The original caller-provided two-minute TTL was rejected for presence cache entries.",
        },
        {
          id: "presence_fact_2",
          text: "Mobile clients send presence heartbeats every 25 seconds, so a 30 second cap leaves one missed heartbeat of slack without hiding disconnects.",
        },
        {
          id: "presence_fact_3",
          supportsAnswer: true,
          text: "The cap exists to prevent stale or ghost presence after mobile disconnects; trusting the caller TTL allowed users to look online for minutes after dropping.",
        },
      ],
    },
    distractors: [
      {
        sessionID: "billing_retry_ttl_session",
        title: "Billing retry TTL note",
        messages: [
          {
            id: "billing_retry_fact_1",
            text: "Billing retry records use a two-minute TTL because the upstream provider batches tenant updates.",
          },
          {
            id: "billing_retry_fact_2",
            text: "This billing note mentions TTLs but is not about presence cache freshness.",
          },
        ],
      },
      {
        sessionID: "markdown_cache_session",
        title: "Markdown parser cache cleanup",
        messages: [
          {
            id: "markdown_fact_1",
            text: "The markdown parser cache was capped to avoid stale rendered docs during local development.",
          },
        ],
      },
    ],
  },
  {
    id: "blame-correction-retry-cap",
    title: "Payment retry correction rationale",
    question:
      "Why does src/payment-retry.ts cap payment retries at 4 attempts instead of the earlier 7-attempt plan?",
    sourceFiles: [
      file("src/payment-retry.ts", [
        "export const RETRY_BACKOFF_MS = [0, 10_000, 25_000, 50_000];",
        "",
        "export function cappedRetryAttempts(maxAttempts: number) {",
        "  const attempts = Math.min(maxAttempts, 4);",
        "  return Math.max(attempts, 1);",
        "}",
      ]),
    ],
    target: {
      file: "src/payment-retry.ts",
      lineText: "  const attempts = Math.min(maxAttempts, 4);",
    },
    required: [
      { id: "four_attempts", patterns: [/4 attempts?/i, /four attempts?/i] },
      {
        id: "seven_corrected",
        patterns: [/7[- ]attempt/i, /seven[- ]attempt/i, /corrected/i, /earlier plan/i],
      },
      {
        id: "idempotency_window",
        patterns: [/90\s*seconds?/i, /idempotency/i, /window/i],
      },
      {
        id: "duplicate_charge",
        patterns: [/duplicate charge/i, /double charge/i, /charge twice/i],
      },
    ],
    forbidden: ["presence heartbeat", "markdown parser", "two-minute TTL"],
    relevant: {
      sessionID: "payment_retry_correction_session",
      title: "Payment retry cap correction",
      messages: [
        {
          id: "retry_fact_1",
          text: "The first plan used seven retry attempts, but that was corrected after checking the provider's idempotency behavior.",
        },
        {
          id: "retry_fact_2",
          text: "The payment provider keeps idempotency keys valid for only 90 seconds.",
        },
        {
          id: "retry_fact_3",
          supportsAnswer: true,
          text: "Four attempts with the current backoff schedule stay inside the 90 second idempotency window; seven attempts can outlive the key and risk a duplicate charge.",
        },
      ],
    },
    distractors: [
      {
        sessionID: "email_retry_session",
        title: "Email retry backoff plan",
        messages: [
          {
            id: "email_retry_fact_1",
            text: "Email delivery keeps seven attempts because SMTP retries are idempotent and user-visible latency is acceptable.",
          },
          {
            id: "email_retry_fact_2",
            text: "Do not apply this to payment retries; it is a different provider and failure mode.",
          },
        ],
      },
      {
        sessionID: "presence_retry_decoy_session",
        title: "Presence reconnect retry note",
        messages: [
          {
            id: "presence_retry_fact_1",
            text: "Presence reconnect retries mention four attempts but have no payment idempotency window.",
          },
        ],
      },
    ],
  },
];

async function main() {
  const options = parseOptions();

  if (options.analyzeRun) {
    const analysis = await analyzeRun(options.analyzeRun);
    await writeAnalysisFiles(options.analyzeRun, analysis);
    console.log(renderAnalysisMarkdown(analysis));
    return;
  }

  await fs.mkdir(options.outDir, { recursive: true });
  await fs.writeFile(
    path.join(options.outDir, "config.json"),
    `${JSON.stringify(options, null, 2)}\n`,
  );

  const selectedFixtures = fixtures.filter((fixture) =>
    options.fixtures.includes(fixture.id),
  );

  if (options.prepareOnly) {
    for (const fixture of selectedFixtures) {
      const fixtureDir = path.join(options.outDir, "fixtures", fixture.id);
      await fs.mkdir(fixtureDir, { recursive: true });
      await prepareFixtureRepo(path.join(fixtureDir, "worktree"), fixture, {
        includeTranscripts: true,
      });
      await fs.writeFile(
        path.join(fixtureDir, "fixture.json"),
        `${JSON.stringify(fixtureForJson(fixture), null, 2)}\n`,
      );
    }
    await writeSummary(options.outDir, [], options);
    console.log(`Prepared blame-recall fixtures at ${options.outDir}`);
    return;
  }

  parseModelSlug(options.modelSlug);
  const results: Array<{
    fixture: string;
    condition: ConditionID;
    statsPath: string;
    pass?: boolean;
    error?: string;
  }> = [];

  for (const fixture of selectedFixtures) {
    for (const condition of options.conditions) {
      const result = await runFixtureCondition(fixture, condition, options);
      results.push(result);
      await writeSummary(options.outDir, results, options);
      console.log(
        `Finished ${results.length}/${selectedFixtures.length * options.conditions.length}: ${fixture.id}/${condition}`,
      );
    }
  }

  await writeSummary(options.outDir, results, options);
  const analysis = await analyzeRun(options.outDir);
  await writeAnalysisFiles(options.outDir, analysis);
  console.log(renderAnalysisMarkdown(analysis));
  console.log(`Blame-recall artifacts written to ${options.outDir}`);
}

async function runFixtureCondition(
  fixture: BlameFixture,
  condition: ConditionID,
  options: Options,
) {
  const conditionDir = path.join(
    options.outDir,
    "fixtures",
    fixture.id,
    "conditions",
    condition,
  );
  const worktree = path.join(conditionDir, "worktree");
  const statsPath = path.join(conditionDir, "stats.json");
  await fs.mkdir(conditionDir, { recursive: true });
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const startedAt = Date.now();
  try {
    const seedCommitHash = await prepareFixtureRepo(worktree, fixture, {
      includeTranscripts:
        condition === "rlm-transcript-search" || condition === "rlm-repl",
    });
    const opencodeRoot = resolveOpenCodeRoot(conditionDir);
    const env = await buildOpenCodeEnv({
      opencodeRoot,
      conditionDir,
      modelSlug: options.modelSlug,
      plugin: usesDecant(condition),
    });
    server = await startServer(env, worktree);
    const client = createOpencodeClient({ baseUrl: server.url });
    await pickModel(client, worktree, options.modelSlug);

    const seeded = usesDecant(condition)
      ? await seedHistoricalSessions(
          client,
          worktree,
          fixture,
          options.promptTimeoutMs,
        )
      : staticSeededSessions(fixture);

    if (condition === "decant-blame-guided-rlm") {
      await writeHybridTranscriptCorpus(client, worktree, fixture, seeded);
      await writeRecallCommitFile(worktree, fixture, seedCommitHash);
    }
    if (usesBlame(condition)) {
      await writeBlameCommitMap(
        opencodeRoot.home,
        worktree,
        fixture,
        seeded,
        seedCommitHash,
      );
    }

    const sessionID = await createSession(
      client,
      worktree,
      `${fixture.id} ${condition}`,
    );
    const promptInput = buildPromptForCondition(fixture, condition, worktree);
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
    await fs.writeFile(
      path.join(conditionDir, "messages.json"),
      `${JSON.stringify(messages, null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(conditionDir, "seeded-sessions.json"),
      `${JSON.stringify(seeded, null, 2)}\n`,
    );
    await copyContextMaps(opencodeRoot.home, conditionDir);
    const stats = buildStats({
      fixture,
      condition,
      seeded,
      messages,
      startedAt,
    });
    await fs.writeFile(statsPath, `${JSON.stringify(stats, null, 2)}\n`);
    return {
      fixture: fixture.id,
      condition,
      statsPath,
      pass: stats.benchmark_passed,
    };
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    await fs.writeFile(
      statsPath,
      `${JSON.stringify(failedStats(fixture, condition, startedAt, message), null, 2)}\n`,
    );
    return { fixture: fixture.id, condition, statsPath, error: message };
  } finally {
    await server?.close();
  }
}

async function prepareFixtureRepo(
  worktree: string,
  fixture: BlameFixture,
  options: { includeTranscripts: boolean },
) {
  await fs.rm(worktree, { recursive: true, force: true });
  for (const item of fixture.sourceFiles) await writeWorktreeFile(worktree, item);
  if (options.includeTranscripts) await writeTranscriptCorpus(worktree, fixture);
  await execFileAsync("git", ["init"], { cwd: worktree });
  await execFileAsync("git", ["add", "."], { cwd: worktree });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Blame Recall Benchmark",
      "-c",
      "user.email=blame-recall@example.com",
      "commit",
      "-m",
      `seed ${fixture.id}`,
    ],
    { cwd: worktree },
  );
  const commitHash = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktree })
  ).stdout.trim();
  if (options.includeTranscripts)
    await writeRecallCommitFile(worktree, fixture, commitHash);
  return commitHash;
}

async function writeWorktreeFile(worktree: string, item: CodeFile) {
  const filePath = path.join(worktree, item.file);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${item.lines.join("\n")}\n`);
}

async function writeTranscriptCorpus(worktree: string, fixture: BlameFixture) {
  const entries = [
    { session: fixture.relevant, role: "relevant" as const },
    ...fixture.distractors.map((session) => ({
      session,
      role: "distractor" as const,
    })),
    ...generatedDecoys(fixture).map((session) => ({
      session,
      role: "decoy" as const,
    })),
  ];
  await writeRecallFiles(
    worktree,
    fixture,
    entries.map(({ session, role }) => ({
      sessionID: session.sessionID,
      title: session.title,
      role,
      file: `${session.sessionID}.md`,
      markdown: transcriptMarkdown(session),
      text: session.messages.map((message) => message.text).join("\n"),
    })),
  );
}

async function writeHybridTranscriptCorpus(
  client: ReturnType<typeof createOpencodeClient>,
  worktree: string,
  fixture: BlameFixture,
  seeded: SeededSessions,
) {
  const sourceSessions = [
    { source: fixture.relevant, role: "relevant" as const },
    ...fixture.distractors.map((source) => ({
      source,
      role: "distractor" as const,
    })),
  ];
  const entries: Array<{
    sessionID: string;
    title: string;
    role: "relevant" | "distractor" | "decoy";
    file: string;
    markdown: string;
    text: string;
  }> = [];

  for (const item of seeded.sessions) {
    const match = sourceSessions.find(
      ({ source, role }) => source.title === item.title && role === item.role,
    );
    if (!match) continue;
    const messages = await listSessionMessages(client, worktree, item.id);
    const messageID =
      messages.find(
        (message) => (message.info?.role ?? message.role) === "user",
      )?.info?.id ?? messages[0]?.info?.id;
    assert.ok(messageID, `missing seeded message for ${item.id}`);
    const fileName = `${match.source.sessionID}--${item.id}.md`;
    entries.push({
      sessionID: item.id,
      title: item.title,
      role: item.role,
      file: fileName,
      markdown: hybridTranscriptMarkdown({
        sessionID: item.id,
        title: item.title,
        messageID,
        messages: match.source.messages,
      }),
      text: match.source.messages.map((message) => message.text).join("\n"),
    });
  }

  for (const session of generatedDecoys(fixture)) {
    entries.push({
      sessionID: session.sessionID,
      title: session.title,
      role: "decoy",
      file: `${session.sessionID}.md`,
      markdown: transcriptMarkdown(session),
      text: session.messages.map((message) => message.text).join("\n"),
    });
  }

  await writeRecallFiles(worktree, fixture, entries, {
    idPolicy:
      "Hybrid transcripts use real OpenCode session_id and message_id values for seeded sessions. Cite those real ids, not fixture labels.",
  });
}

async function writeRecallFiles(
  worktree: string,
  fixture: BlameFixture,
  entries: Array<{
    sessionID: string;
    title: string;
    role: "relevant" | "distractor" | "decoy";
    file: string;
    markdown: string;
    text: string;
  }>,
  options: { idPolicy?: string } = {},
) {
  const recallDir = path.join(worktree, "recall");
  const transcriptDir = path.join(recallDir, "transcripts");
  await fs.mkdir(transcriptDir, { recursive: true });
  for (const entry of entries) {
    await fs.writeFile(path.join(transcriptDir, entry.file), entry.markdown);
  }
  await fs.writeFile(
    path.join(recallDir, "manifest.json"),
    `${JSON.stringify(
      {
        fixture: fixture.id,
        transcript_dir: "recall/transcripts",
        id_policy: options.idPolicy,
        sessions: entries.map((entry) => ({
          session_id: entry.sessionID,
          title: entry.title,
          role: entry.role,
          file: entry.file,
        })),
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(recallDir, "index.json"),
    `${JSON.stringify(
      {
        fixture: fixture.id,
        generated_at: new Date().toISOString(),
        sessions: entries.map((entry) => ({
          session_id: entry.sessionID,
          title: entry.title,
          role: entry.role,
          file: `transcripts/${entry.file}`,
          text: entry.text,
        })),
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(path.join(recallDir, "rlm.mjs"), rlmScript());
}

async function writeRecallCommitFile(
  worktree: string,
  fixture: BlameFixture,
  commitHash: string,
) {
  const recallDir = path.join(worktree, "recall");
  await fs.mkdir(recallDir, { recursive: true });
  await fs.writeFile(
    path.join(recallDir, "commits.json"),
    `${JSON.stringify(
      {
        fixture: fixture.id,
        commits: [
          {
            commit_hash: commitHash,
            file: fixture.target.file,
            line: targetLine(fixture),
            line_text: fixture.target.lineText.trim(),
            relevant_session_id: fixture.relevant.sessionID,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function rlmScript() {
  return `#!/usr/bin/env node
import fs from "node:fs";

const root = new URL(".", import.meta.url);
const index = JSON.parse(fs.readFileSync(new URL("index.json", root), "utf8"));
const commitsPath = new URL("commits.json", root);
const commits = fs.existsSync(commitsPath) ? JSON.parse(fs.readFileSync(commitsPath, "utf8")) : { commits: [] };
const [cmd, ...args] = process.argv.slice(2);

function terms(value) {
  return String(value).toLowerCase().split(/[^a-z0-9_]+/).filter((item) => item.length > 2);
}

function score(doc, queryTerms) {
  const haystack = [doc.title, doc.text].join("\\n").toLowerCase();
  return queryTerms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
}

if (!cmd || cmd === "help") {
  console.log("Usage: node recall/rlm.mjs list | search <query> | show <session_id> | commit <hash>");
  process.exit(0);
}

if (cmd === "list") {
  console.log(JSON.stringify(index.sessions.map(({ session_id, title, role, file }) => ({ session_id, title, role, file })), null, 2));
} else if (cmd === "search") {
  const query = args.join(" ");
  const queryTerms = terms(query);
  const hits = index.sessions
    .map((doc) => ({ ...doc, score: score(doc, queryTerms) }))
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ session_id, title, role, file, score }) => ({ session_id, title, role, file, score }));
  console.log(JSON.stringify({ query, hits }, null, 2));
} else if (cmd === "show") {
  const sessionID = args[0];
  const doc = index.sessions.find((item) => item.session_id === sessionID);
  if (!doc) throw new Error("unknown session_id: " + sessionID);
  console.log(fs.readFileSync(new URL(doc.file, root), "utf8"));
} else if (cmd === "commit") {
  const hash = args[0];
  const hit = commits.commits.find((item) => item.commit_hash.startsWith(hash));
  console.log(JSON.stringify(hit ?? null, null, 2));
} else {
  throw new Error("unknown command: " + cmd);
}
`;
}

function transcriptMarkdown(session: HistoricalSession) {
  return [
    `# ${session.title}`,
    `session_id: ${session.sessionID}`,
    `title: ${session.title}`,
    "",
    ...session.messages.flatMap((message) => [
      `## message ${message.id}`,
      message.text,
      "",
    ]),
  ].join("\n");
}

function hybridTranscriptMarkdown(input: {
  sessionID: string;
  title: string;
  messageID: string;
  messages: MessageFact[];
}) {
  return [
    `# ${input.title}`,
    `session_id: ${input.sessionID}`,
    `title: ${input.title}`,
    "id_policy: cite the heading message id below, not fixture fact labels",
    "",
    `## message ${input.messageID}`,
    ...input.messages.map((message) => `- ${message.text}`),
    "",
  ].join("\n");
}

function generatedDecoys(fixture: BlameFixture): HistoricalSession[] {
  return Array.from({ length: 6 }, (_, index) => ({
    sessionID: `${fixture.id}_decoy_${index + 1}`.replaceAll("-", "_"),
    title: `${fixture.title} decoy ${index + 1}`,
    messages: [
      {
        id: `decoy_fact_${index + 1}`,
        text: `Decoy ${index + 1}: mentions ${fixture.target.file} and similar blame language, but it is not the rationale for the blamed line.`,
      },
    ],
  }));
}

type OpenCodeRoot = {
  home: string;
  data: string;
  config: string;
  state: string;
  cache: string;
};

function resolveOpenCodeRoot(conditionDir: string): OpenCodeRoot {
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
    DECANT_DISABLE_GIT_HOOK_INSTALL: "1",
    DECANT_CACHE_STABLE: "1",
    DECANT_STABLE_PLACEHOLDERS: "1",
    DECANT_STABLE_ANCHORS: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    ...(authContent ? { OPENCODE_AUTH_CONTENT: authContent } : {}),
  } satisfies NodeJS.ProcessEnv;
}

async function seededAuthContent() {
  const seeded = process.env.DECANT_E2E_TEMP_ROOT;
  if (!seeded) return undefined;
  return await fs
    .readFile(path.join(seeded, "data", "opencode", "auth.json"), "utf8")
    .catch(() => undefined);
}

async function startServer(env: NodeJS.ProcessEnv, cwd: string) {
  const proc = spawn(
    "opencode",
    ["serve", "--hostname=127.0.0.1", "--port=0"],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
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
  const providers = await listProviders(client, directory);
  const provider = (providers.all ?? []).find(
    (item) => item.id === requested.providerID,
  );
  assert.ok(provider, `provider is not available: ${requested.providerID}`);
  assert.ok(
    (providers.connected ?? []).includes(requested.providerID),
    `provider is not connected in isolated sandbox: ${requested.providerID}`,
  );
  assert.ok(
    requested.modelID in provider.models,
    `model is not available: ${requested.providerID}/${requested.modelID}`,
  );
}

async function seedHistoricalSessions(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  fixture: BlameFixture,
  timeoutMs: number,
): Promise<SeededSessions> {
  const relevantSessionID = await createSession(
    client,
    directory,
    fixture.relevant.title,
  );
  await prompt(
    client,
    directory,
    relevantSessionID,
    transcriptMarkdown(fixture.relevant),
    seedSystemPrompt(),
    {},
    timeoutMs,
  );
  const sessions: SeededSessions["sessions"] = [
    { id: relevantSessionID, title: fixture.relevant.title, role: "relevant" },
  ];

  for (const distractor of fixture.distractors) {
    const sessionID = await createSession(client, directory, distractor.title);
    sessions.push({ id: sessionID, title: distractor.title, role: "distractor" });
    await prompt(
      client,
      directory,
      sessionID,
      transcriptMarkdown(distractor),
      seedSystemPrompt(),
      {},
      timeoutMs,
    );
  }

  const messages = await listSessionMessages(client, directory, relevantSessionID);
  return {
    relevantSessionID,
    relevantMessageIDs: messages
      .map((message) => message.info?.id)
      .filter((id): id is string => Boolean(id)),
    sessions,
  };
}

function staticSeededSessions(fixture: BlameFixture): SeededSessions {
  return {
    relevantSessionID: fixture.relevant.sessionID,
    relevantMessageIDs: fixture.relevant.messages
      .filter((message) => message.supportsAnswer)
      .map((message) => message.id),
    sessions: [
      { id: fixture.relevant.sessionID, title: fixture.relevant.title, role: "relevant" },
      ...fixture.distractors.map((item) => ({
        id: item.sessionID,
        title: item.title,
        role: "distractor" as const,
      })),
    ],
  };
}

function seedSystemPrompt() {
  return "Preserve this prior coding-session record for a blame-recall benchmark. Do not edit files or call tools. Acknowledge concisely while retaining exact rationale and corrections.";
}

async function writeBlameCommitMap(
  home: string,
  worktree: string,
  fixture: BlameFixture,
  seeded: SeededSessions,
  commitHash: string,
) {
  const root = path.join(home, ".opencode", "context-maps");
  await fs.mkdir(root, { recursive: true });
  const sessionID = seeded.relevantSessionID;
  assert.ok(sessionID, "decant blame condition needs a relevant session");
  const sessionMap = objectValue(
    await readJson(path.join(root, `${sessionID}.json`)),
  );
  const activeBlobID =
    stringValue(sessionMap?.lastActiveBlobID) ??
    arrayValue(sessionMap?.blobOrder)?.[0];
  const activeBlobLabel = activeBlobID
    ? stringValue(recordValue(sessionMap?.blobs)?.[activeBlobID]?.label)
    : undefined;
  const changedFiles = (
    await execFileAsync("git", ["show", "--pretty=format:", "--name-only", commitHash], {
      cwd: worktree,
    })
  ).stdout
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
  await fs.writeFile(
    path.join(root, "_commits.json"),
    `${JSON.stringify(
      {
        version: 1,
        updatedAt: Date.now(),
        entries: {
          [commitHash]: {
            commitHash,
            sessionID,
            timestamp: Date.now(),
            directory: worktree,
            worktree,
            activeBlobID,
            activeBlobLabel,
            activeBlobIDs: activeBlobID ? [activeBlobID] : [],
            activeBlobLabels: activeBlobLabel ? [activeBlobLabel] : [],
            commitSubject: `seed ${fixture.id}`,
            changedFiles,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

function buildPromptForCondition(
  fixture: BlameFixture,
  condition: ConditionID,
  worktree: string,
): PromptInput {
  const line = targetLine(fixture);
  const target = `${fixture.target.file}:${line}`;
  const transcriptDir = path.join(worktree, "recall", "transcripts");
  const rlmPath = path.join(worktree, "recall", "rlm.mjs");
  const answerContract = [
    "Return compact JSON only with this shape:",
    '{"answer":"...","evidence":{"session_id":"...","message_id":"...","method":"..."},"irrelevant_context_ignored":["..."]}',
    "The evidence must cite the exact prior session/message that supports the rationale. If no prior context is available, leave evidence fields empty.",
  ].join("\n");

  if (condition === "code-only") {
    return {
      system:
        "Answer compact JSON only. Inspect repository files and git metadata if useful, but no prior session memory or transcript corpus is available. Do not modify files.",
      tools: { read: true, grep: true, bash: true },
      text: [
        `Question: ${fixture.question}`,
        `Target line: ${target}`,
        `Line text: ${fixture.target.lineText.trim()}`,
        answerContract,
      ].join("\n"),
    };
  }

  if (condition === "rlm-transcript-search") {
    return {
      system:
        "Answer compact JSON only. Use RLM-style transcript search with glob/grep/read and optional read-only bash. Do not use decant/session tools. Cite exact session_id and message_id from transcript headings.",
      tools: { glob: true, grep: true, read: true, bash: true },
      text: [
        `Question: ${fixture.question}`,
        `Target line: ${target}`,
        `Transcript directory: ${transcriptDir}`,
        answerContract,
      ].join("\n"),
    };
  }

  if (condition === "rlm-repl") {
    return {
      system:
        "Answer compact JSON only. Use the local read-only RLM interface, not ad hoc transcript grep. Run node recall/rlm.mjs search/show/commit through bash, then cite exact session_id and message_id.",
      tools: { bash: true, read: true },
      text: [
        `Question: ${fixture.question}`,
        `Target line: ${target}`,
        `RLM interface: ${rlmPath}`,
        "Required route: use `node recall/rlm.mjs search <query>` and `node recall/rlm.mjs show <session_id>` before answering.",
        answerContract,
      ].join("\n"),
    };
  }

  if (condition === "decant-session-lookup") {
    return {
      system:
        "Answer compact JSON only. Use session_lookup, then session_detail detail='messages', then message_detail for exact evidence. Do not use blame_lookup, transcript files, glob, grep, read, or bash.",
      tools: {
        session_lookup: true,
        session_detail: true,
        message_detail: true,
        session_tree: true,
      },
      text: [
        `Question: ${fixture.question}`,
        `Target line: ${target}`,
        `Search hint: ${fixture.title}`,
        answerContract,
      ].join("\n"),
    };
  }

  if (condition === "decant-blame") {
    return {
      system:
        "Answer compact JSON only. Use blame_lookup first, then session_detail detail='messages', then message_detail for exact evidence. Do not use transcript files, glob, grep, read, or bash.",
      tools: { blame_lookup: true, session_detail: true, message_detail: true },
      text: [
        `Question: ${fixture.question}`,
        `Use blame target file=${fixture.target.file} line=${line}.`,
        answerContract,
      ].join("\n"),
    };
  }

  return {
    system:
      "Answer compact JSON only. Use blame_lookup first to route to the prior session, then session_detail/message_detail for exact evidence. Use the local RLM interface only as corroboration; do not use ad hoc transcript grep.",
    tools: {
      blame_lookup: true,
      session_detail: true,
      message_detail: true,
      bash: true,
      read: true,
    },
    text: [
      `Question: ${fixture.question}`,
      `Use blame target file=${fixture.target.file} line=${line}.`,
      `RLM interface: ${rlmPath}`,
      "After blame_lookup, use `node recall/rlm.mjs commit <commit_hash>` or `node recall/rlm.mjs search <query>` only if you need corroborating transcript evidence.",
      answerContract,
    ].join("\n"),
  };
}

async function createSession(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  title: string,
) {
  const session = await createOpenCodeSession(client, directory, title);
  assert.ok(session.id, "failed to create session");
  return session.id;
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
    }),
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
    const assistant = [...messages].reverse().find((message) => {
      const role = message.info?.role ?? message.role;
      const id = message.info?.id ?? message.id;
      return role === "assistant" && id && !beforeIDs.has(id);
    });
    if (!assistant) continue;
    const finish = assistant.info?.finish;
    if (finish === "error") throw new Error(JSON.stringify(assistant.error));
    if (finish) return assistant;
  }
  throw new Error(`timed out waiting for assistant in ${sessionID}`);
}

async function listSessionMessages(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  sessionID: string,
) {
  return (await listOpenCodeSessionMessages(
    client,
    directory,
    sessionID,
  )) as SessionMessage[];
}

function buildStats(input: {
  fixture: BlameFixture;
  condition: ConditionID;
  seeded: SeededSessions;
  messages: SessionMessage[];
  startedAt: number;
}): RunStats {
  const output = outputText(input.messages);
  const requiredHits = input.fixture.required
    .filter((required) => required.patterns.some((pattern) => pattern.test(output)))
    .map((required) => required.id);
  const missingRequired = input.fixture.required
    .filter((required) => !requiredHits.includes(required.id))
    .map((required) => required.id);
  const forbiddenHits = input.fixture.forbidden.filter((term) =>
    output.toLowerCase().includes(term.toLowerCase()),
  );
  const tools = collectToolCalls(input.messages);
  const toolNames = tools.map((tool) => tool.name);
  const transcriptFilesRead = transcriptReadFiles(tools);
  const irrelevantTranscriptReads = transcriptFilesRead.filter(
    (filePath) =>
      !filePath.includes(input.fixture.relevant.sessionID) &&
      !filePath.includes(input.seeded.relevantSessionID ?? ""),
  );
  const citationHits = citationMatches(output, input.seeded, input.fixture);
  const answerPassed = missingRequired.length === 0 && forbiddenHits.length === 0;
  const provenancePassed =
    input.condition === "code-only" ? true : citationHits.length > 0;
  const toolPathFailures = toolPathFailuresFor(
    input.condition,
    toolNames,
    transcriptFilesRead,
  );
  const toolPathPassed = toolPathFailures.length === 0;
  return {
    fixture: input.fixture.id,
    title: input.fixture.title,
    condition: input.condition,
    benchmark_passed: answerPassed && provenancePassed && toolPathPassed,
    answer_passed: answerPassed,
    provenance_passed: provenancePassed,
    tool_path_passed: toolPathPassed,
    tool_path_failures: toolPathFailures,
    required_hits: requiredHits,
    missing_required: missingRequired,
    forbidden_hits: forbiddenHits,
    citation_hits: citationHits,
    output_preview: output.slice(0, 2_000),
    tool_names: toolNames,
    transcript_files_read: transcriptFilesRead,
    irrelevant_transcript_reads: irrelevantTranscriptReads,
    tokens: tokenBucket(input.messages, tools.length),
    duration_ms: Date.now() - input.startedAt,
    relevant_session_id:
      input.seeded.relevantSessionID ?? input.fixture.relevant.sessionID,
    relevant_message_ids: input.seeded.relevantMessageIDs,
    target: {
      file: input.fixture.target.file,
      line: targetLine(input.fixture),
      line_text: input.fixture.target.lineText.trim(),
    },
  };
}

function failedStats(
  fixture: BlameFixture,
  condition: ConditionID,
  startedAt: number,
  error: string,
): RunStats {
  return {
    fixture: fixture.id,
    title: fixture.title,
    condition,
    benchmark_passed: false,
    answer_passed: false,
    provenance_passed: false,
    tool_path_passed: false,
    tool_path_failures: ["run failed"],
    required_hits: [],
    missing_required: fixture.required.map((item) => item.id),
    forbidden_hits: [],
    citation_hits: [],
    output_preview: "",
    tool_names: [],
    transcript_files_read: [],
    irrelevant_transcript_reads: [],
    tokens: emptyTokenBucket(),
    duration_ms: Date.now() - startedAt,
    relevant_session_id: fixture.relevant.sessionID,
    relevant_message_ids: fixture.relevant.messages
      .filter((message) => message.supportsAnswer)
      .map((message) => message.id),
    target: {
      file: fixture.target.file,
      line: targetLine(fixture),
      line_text: fixture.target.lineText.trim(),
    },
    error,
  };
}

function toolPathFailuresFor(
  condition: ConditionID,
  toolNames: string[],
  transcriptFilesRead: string[],
) {
  const failures: string[] = [];
  const has = (tool: string) => toolNames.includes(tool);
  const requireTools = (tools: string[]) => {
    for (const tool of tools) if (!has(tool)) failures.push(`missing ${tool}`);
  };
  const rejectTools = (tools: string[]) => {
    for (const tool of tools) if (has(tool)) failures.push(`forbidden ${tool}`);
  };

  if (condition === "code-only") {
    rejectTools(["session_lookup", "session_detail", "message_detail", "blame_lookup"]);
  } else if (condition === "rlm-transcript-search") {
    rejectTools(["session_lookup", "session_detail", "message_detail", "blame_lookup"]);
    if (!has("grep") && !has("read") && !has("bash"))
      failures.push("missing transcript search tool");
    if (transcriptFilesRead.length === 0) failures.push("no transcript file read");
  } else if (condition === "rlm-repl") {
    requireTools(["bash"]);
    rejectTools(["session_lookup", "session_detail", "message_detail", "blame_lookup", "grep", "glob"]);
  } else if (condition === "decant-session-lookup") {
    requireTools(["session_lookup", "session_detail", "message_detail"]);
    rejectTools(["blame_lookup", "grep", "glob", "read", "bash"]);
  } else if (condition === "decant-blame") {
    requireTools(["blame_lookup", "session_detail", "message_detail"]);
    rejectTools(["session_lookup", "grep", "glob", "read", "bash"]);
  } else {
    requireTools(["blame_lookup", "message_detail"]);
    rejectTools(["grep", "glob"]);
  }
  return failures;
}

function collectToolCalls(messages: SessionMessage[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      const name = part.tool ?? stringValue(part.metadata?.tool);
      if (!name) continue;
      calls.push({ name, input: part.state?.input });
    }
  }
  return calls;
}

function transcriptReadFiles(tools: ToolCall[]) {
  const files = new Set<string>();
  for (const tool of tools) {
    const raw = JSON.stringify(tool.input ?? "");
    for (const match of raw.matchAll(/[^\s"'`]+recall\/transcripts\/[^\s"'`]+/g)) {
      files.add(match[0]);
    }
  }
  return [...files].sort();
}

function outputText(messages: SessionMessage[]) {
  return messages
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function citationMatches(
  output: string,
  seeded: SeededSessions,
  fixture: BlameFixture,
) {
  const hits: string[] = [];
  const relevantSessionID = seeded.relevantSessionID ?? fixture.relevant.sessionID;
  if (output.includes(relevantSessionID)) hits.push(`session:${relevantSessionID}`);
  const messageIDs = new Set([
    ...seeded.relevantMessageIDs,
    ...fixture.relevant.messages
      .filter((message) => message.supportsAnswer)
      .map((message) => message.id),
  ]);
  for (const messageID of messageIDs) {
    if (output.includes(messageID)) hits.push(`message:${messageID}`);
  }
  return hits;
}

function tokenBucket(messages: SessionMessage[], toolCalls: number): TokenBucket {
  const bucket = emptyTokenBucket();
  bucket.toolCalls = toolCalls;
  for (const message of messages) {
    bucket.messages += 1;
    if ((message.info?.role ?? message.role) === "assistant") bucket.assistant += 1;
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

function usesDecant(condition: ConditionID) {
  return (
    condition === "decant-session-lookup" ||
    condition === "decant-blame" ||
    condition === "decant-blame-guided-rlm"
  );
}

function usesBlame(condition: ConditionID) {
  return condition === "decant-blame" || condition === "decant-blame-guided-rlm";
}

function targetLine(fixture: BlameFixture) {
  const source = fixture.sourceFiles.find((item) => item.file === fixture.target.file);
  assert.ok(source, `missing target file fixture: ${fixture.target.file}`);
  const index = source.lines.findIndex((line) => line === fixture.target.lineText);
  assert.ok(index >= 0, `missing target line fixture: ${fixture.target.lineText}`);
  return index + 1;
}

async function copyContextMaps(home: string, conditionDir: string) {
  const source = path.join(home, ".opencode", "context-maps");
  const dest = path.join(conditionDir, "context-maps");
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(source, dest, { recursive: true }).catch(() => undefined);
}

async function analyzeRun(outDir: string): Promise<Analysis> {
  const files = await statsFiles(outDir);
  const rows: RunStats[] = [];
  for (const filePath of files) {
    rows.push(JSON.parse(await fs.readFile(filePath, "utf8")) as RunStats);
  }
  rows.sort((a, b) =>
    `${a.fixture}/${a.condition}`.localeCompare(`${b.fixture}/${b.condition}`),
  );
  return { outDir, generatedAt: new Date().toISOString(), rows };
}

async function statsFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await statsFiles(filePath)));
    else if (entry.name === "stats.json") files.push(filePath);
  }
  return files;
}

async function writeAnalysisFiles(outDir: string, analysis: Analysis) {
  await fs.writeFile(
    path.join(outDir, "analysis.json"),
    `${JSON.stringify(analysis, null, 2)}\n`,
  );
  await fs.writeFile(path.join(outDir, "analysis.md"), renderAnalysisMarkdown(analysis));
}

async function writeSummary(
  outDir: string,
  results: Array<{
    fixture: string;
    condition: ConditionID;
    statsPath: string;
    pass?: boolean;
    error?: string;
  }>,
  options: Options,
) {
  await fs.writeFile(
    path.join(outDir, "summary.json"),
    `${JSON.stringify({ options, results }, null, 2)}\n`,
  );
}

function renderAnalysisMarkdown(analysis: Analysis) {
  const lines = [
    "# Blame Recall Analysis",
    "",
    `Run: ${analysis.outDir}`,
    "",
    "| Fixture | Condition | Pass | Answer | Provenance | Tool Path | Missing | Forbidden | Input | Cache Read | Irrelevant Reads |",
    "|---|---:|---:|---:|---:|---:|---|---|---:|---:|---:|",
  ];
  for (const row of analysis.rows) {
    lines.push(
      `| ${row.fixture} | ${row.condition} | ${String(row.benchmark_passed)} | ${String(row.answer_passed)} | ${String(row.provenance_passed)} | ${String(row.tool_path_passed)} | ${row.missing_required.join(", ")} | ${row.forbidden_hits.join(", ")} | ${row.tokens.input.toLocaleString()} | ${row.tokens.cacheRead.toLocaleString()} | ${row.irrelevant_transcript_reads.length} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function parseOptions(): Options {
  const args = process.argv.slice(2);
  const fixtureArg = valueArg(args, "--fixtures");
  const conditionArg = valueArg(args, "--conditions");
  const modelArg = valueArg(args, "--model");
  const timeoutMinutes = Number(valueArg(args, "--prompt-timeout-minutes") ?? "12");
  assert.ok(Number.isFinite(timeoutMinutes) && timeoutMinutes > 0);
  const selectedFixtures = fixtureArg
    ? splitList(fixtureArg)
    : fixtures.map((fixture) => fixture.id);
  const knownFixtures = new Set(fixtures.map((fixture) => fixture.id));
  for (const fixture of selectedFixtures)
    assert.ok(knownFixtures.has(fixture), `unknown fixture: ${fixture}`);
  const selectedConditions = (conditionArg
    ? splitList(conditionArg)
    : defaultConditions) as ConditionID[];
  for (const condition of selectedConditions)
    assert.ok(defaultConditions.includes(condition), `unknown condition: ${condition}`);
  const prepareOnly = hasArg(args, "--prepare-only");
  const analyzeRunArg = valueArg(args, "--analyze-run");
  const analyzeRun = analyzeRunArg ? path.resolve(analyzeRunArg) : undefined;
  return {
    conditions: selectedConditions,
    fixtures: selectedFixtures,
    outDir: path.resolve(valueArg(args, "--out") ?? defaultOutDir),
    modelSlug:
      prepareOnly || analyzeRun
        ? (modelArg ?? process.env.DECANT_E2E_MODEL ?? "")
        : requiredModelSlug(modelArg, { cliFlag: "--model" }),
    promptTimeoutMs: timeoutMinutes * 60_000,
    prepareOnly,
    analyzeRun,
  };
}

function valueArg(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
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

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function file(filePath: string, lines: string[]): CodeFile {
  return { file: filePath, lines };
}

function fixtureForJson(fixture: BlameFixture) {
  return {
    ...fixture,
    target: { ...fixture.target, line: targetLine(fixture) },
    required: fixture.required.map((item) => ({
      id: item.id,
      patterns: item.patterns.map((pattern) => String(pattern)),
    })),
  };
}

async function readJson(filePath: string) {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function recordValue(value: unknown): Record<string, Record<string, unknown>> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, Record<string, unknown>>)
    : undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(label)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
