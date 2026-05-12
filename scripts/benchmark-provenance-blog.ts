import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(process.cwd());

type ConditionID =
  | "searchable-transcript"
  | "subagent-searchable-transcript"
  | "memmould-map-zoom"
  | "subagent-map-zoom"
  | "memmould-blame-lookup";

type ModelRef = { providerID: string; modelID: string };

type Options = {
  conditions: ConditionID[];
  fixtures: string[];
  outDir: string;
  modelSlug: string;
  childModelSlug?: string;
  promptTimeoutMs: number;
  prepareOnly: boolean;
  analyzeRun?: string;
};

type PromptInput = {
  text: string;
  system?: string;
  tools?: Record<string, boolean>;
};

type MessageFact = {
  id: string;
  text: string;
  supportsAnswer?: boolean;
};

type Fixture = {
  id: string;
  title: string;
  question: string;
  required: Array<{ id: string; patterns: RegExp[] }>;
  forbidden: string[];
  sourceFiles: Array<{ file: string; lines: string[] }>;
  relevant: {
    sessionID: string;
    title: string;
    messages: MessageFact[];
  };
  distractors: Array<{
    sessionID: string;
    title: string;
    messages: MessageFact[];
    forbidden?: string[];
  }>;
  blame?: {
    file: string;
    line: number;
  };
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

type SessionMessage = {
  info?: {
    id?: string;
    role?: string;
    finish?: string;
    summary?: boolean;
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

type RunStats = {
  fixture: string;
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
  tool_call_count: number;
  context_tool_call_count: number;
  search_tool_call_count: number;
  read_tool_call_count: number;
  task_tool_call_count: number;
  message_detail_call_count: number;
  blame_lookup_call_count: number;
  transcript_files_read: string[];
  irrelevant_transcript_reads: string[];
  child_session_count: number;
  parent_tokens: TokenBucket;
  child_tokens: TokenBucket;
  tokens: TokenBucket;
  parent_models: string[];
  child_models: string[];
  duration_ms: number;
  relevant_session_id: string;
  relevant_message_ids: string[];
  error?: string;
};

type Analysis = {
  outDir: string;
  generatedAt: string;
  rows: RunStats[];
};

const defaultOutDir = path.join(
  repoRoot,
  "benchmarks",
  "provenance-qa",
  "runs",
  `blog-${timestampForPath(new Date())}`,
);

const defaultConditions: ConditionID[] = [
  "searchable-transcript",
  "subagent-searchable-transcript",
  "memmould-map-zoom",
  "subagent-map-zoom",
  "memmould-blame-lookup",
];

const fixtures: Fixture[] = [
  {
    id: "auth-queue-rationale",
    title: "Auth queue rationale",
    question:
      "Why does src/auth/queue.ts deduplicate refresh work per tenant instead of using one global mutex?",
    required: [
      {
        id: "per_tenant",
        patterns: [
          /per[- ]tenant/i,
          /same[- ]tenant[\s\S]{0,160}different tenants/i,
        ],
      },
      {
        id: "same_tenant_coalesce",
        patterns: [/same[- ]tenant/i, /coalesc/i, /deduplicat/i],
      },
      {
        id: "different_tenants_parallel",
        patterns: [/different tenants/i, /parallel/i, /unrelated tenants/i],
      },
      {
        id: "global_mutex_rejected",
        patterns: [
          /global (auth )?mutex/i,
          /rejected|instead of|rather than|not use/i,
          /would .*block|blocking behind|must not block/i,
        ],
      },
    ],
    forbidden: ["billing retry", "markdown parser", "quickstart"],
    sourceFiles: [
      {
        file: "src/auth/queue.ts",
        lines: [
          "export class RefreshQueue {",
          "  private readonly inflight = new Map<string, Promise<string>>();",
          "  enqueueRefresh(tenantID: string, refresh: () => Promise<string>) {",
          "    const existing = this.inflight.get(tenantID);",
          "    if (existing) return existing;",
          "    const next = refresh().finally(() => this.inflight.delete(tenantID));",
          "    this.inflight.set(tenantID, next);",
          "    return next;",
          "  }",
          "}",
        ],
      },
    ],
    relevant: {
      sessionID: "auth_refresh_session",
      title: "Auth refresh queue rationale",
      messages: [
        {
          id: "auth_fact_1",
          text: "The rejected design was one global mutex around all auth refresh work.",
        },
        {
          id: "auth_fact_2",
          text: "The global mutex was rejected because auth_refresh_different_tenants_parallel showed unrelated tenants must not block each other.",
        },
        {
          id: "auth_fact_3",
          supportsAnswer: true,
          text: "RefreshQueue uses a per-tenant key: same-tenant duplicate refreshes coalesce, while different tenants continue in parallel.",
        },
      ],
    },
    distractors: [
      {
        sessionID: "billing_retry_session",
        title: "Billing retry queue rationale",
        messages: [
          {
            id: "billing_fact_1",
            text: "Billing retry queues used a global mutex because provider limits serialize all tenants.",
          },
          {
            id: "billing_fact_2",
            text: "This is not the auth refresh queue rationale.",
          },
        ],
      },
      {
        sessionID: "markdown_parser_session",
        title: "Markdown parser onboarding cleanup",
        messages: [
          {
            id: "docs_fact_1",
            text: "Markdown parser cache issues affected onboarding docs and quickstart text.",
          },
        ],
      },
    ],
  },
  {
    id: "correction-chain",
    title: "Correction chain",
    question:
      "Why does src/parser/schema.ts trim schema field names after splitting fields instead of before tokenization?",
    required: [
      {
        id: "after_split",
        patterns: [
          /after (splitting|split|tokenization|tokenizing)/i,
          /split first/i,
          /tokeni[sz](e|es|ing) first/i,
          /then trim(s|med)?/i,
          /trim(ming)? afterward/i,
        ],
      },
      { id: "preserve_raw", patterns: [/preserv/i, /raw/i, /quoted/i] },
      {
        id: "earlier_wrong",
        patterns: [/earlier/i, /wrong/i, /superseded/i, /correction/i],
      },
    ],
    forbidden: ["network timeout", "billing queue", "global mutex"],
    sourceFiles: [
      {
        file: "src/parser/schema.ts",
        lines: [
          "export function parseSchemaHeader(line: string) {",
          "  return line.split('|').map((field) => field.trim());",
          "}",
        ],
      },
    ],
    relevant: {
      sessionID: "schema_parser_session",
      title: "Schema parser correction chain",
      messages: [
        {
          id: "schema_fact_1",
          text: "Early note, later superseded: trim the whole schema header before tokenization.",
        },
        {
          id: "schema_fact_2",
          supportsAnswer: true,
          text: "Correction: tokenize first, then trim each field. This preserves raw delimiter and quoted-field behavior while cleaning field names.",
        },
        {
          id: "schema_fact_3",
          text: "The earlier before-tokenization rationale was wrong and should not be cited as final.",
        },
      ],
    },
    distractors: [
      {
        sessionID: "csv_trim_session",
        title: "CSV trim cleanup",
        messages: [
          {
            id: "csv_fact_1",
            text: "CSV header cells trim around commas; this is related but not the schema pipe parser correction.",
          },
        ],
      },
      {
        sessionID: "network_timeout_session",
        title: "Network timeout parser",
        messages: [
          {
            id: "net_fact_1",
            text: "A network parser strips whitespace before tokenization; this is a distractor.",
          },
        ],
      },
    ],
  },
  {
    id: "false-provenance",
    title: "False provenance",
    question:
      "Why does src/cache/index.ts scope TTL by namespace instead of using one global TTL?",
    required: [
      {
        id: "namespace_ttl",
        patterns: [
          /namespace[- ]scoped/i,
          /scope.*namespace/i,
          /per[- ]namespace/i,
        ],
      },
      {
        id: "avoid_noisy_namespace",
        patterns: [
          /noisy namespace/i,
          /unrelated namespace/i,
          /cross[- ]namespace/i,
        ],
      },
      {
        id: "global_ttl_rejected",
        patterns: [/global ttl/i, /rejected/i, /not use/i],
      },
    ],
    forbidden: ["billing cache", "image cache", "global mutex"],
    sourceFiles: [
      {
        file: "src/cache/index.ts",
        lines: [
          "export function ttlKey(namespace: string, key: string) {",
          "  return `${namespace}:${key}`;",
          "}",
        ],
      },
    ],
    relevant: {
      sessionID: "cache_namespace_session",
      title: "Cache namespace TTL rationale",
      messages: [
        {
          id: "cache_fact_1",
          text: "A global TTL was considered for cache entries.",
        },
        {
          id: "cache_fact_2",
          supportsAnswer: true,
          text: "Namespace-scoped TTL was chosen so one noisy namespace cannot extend or evict unrelated namespaces through a shared global TTL policy.",
        },
      ],
    },
    distractors: [
      {
        sessionID: "billing_cache_session",
        title: "Billing cache global TTL",
        messages: [
          {
            id: "billing_cache_fact_1",
            text: "Billing cache intentionally uses one global TTL because its provider invalidates all tenants together.",
          },
        ],
      },
      {
        sessionID: "image_cache_session",
        title: "Image cache namespace notes",
        messages: [
          {
            id: "image_cache_fact_1",
            text: "Image cache namespace prefixes are only for CDN purges, not TTL rationale.",
          },
        ],
      },
    ],
  },
  {
    id: "related-reuse",
    title: "Related past work reuse",
    question:
      "For src/tsv/schema.ts, what prior CSV parser lesson should be reused, and what stale detail should not be copied?",
    required: [
      {
        id: "reuse_principle",
        patterns: [/reuse/i, /lesson/i, /trim.*after/i, /after splitting/i],
      },
      {
        id: "do_not_copy_comma",
        patterns: [/do not copy/i, /not copy/i, /comma/i],
      },
      { id: "tsv_specific", patterns: [/tab/i, /tsv/i] },
    ],
    forbidden: ["auth refresh", "global mutex", "billing retry"],
    sourceFiles: [
      {
        file: "src/tsv/schema.ts",
        lines: [
          "export function parseTsvSchema(line: string) {",
          "  return line.split('\t').map((field) => field.trim());",
          "}",
        ],
      },
    ],
    relevant: {
      sessionID: "csv_parser_lesson_session",
      title: "CSV parser lesson for related reuse",
      messages: [
        {
          id: "reuse_fact_1",
          supportsAnswer: true,
          text: "Reusable lesson: trim fields after delimiter splitting so cell names are clean without altering raw parse boundaries.",
        },
        {
          id: "reuse_fact_2",
          supportsAnswer: true,
          text: "Stale detail: do not copy comma-specific CSV splitting into TSV; use tab delimiters for TSV.",
        },
      ],
    },
    distractors: [
      {
        sessionID: "auth_related_session",
        title: "Auth queue related reuse",
        messages: [
          {
            id: "auth_related_fact_1",
            text: "Auth refresh queue reuse involved per-tenant dedupe and is unrelated to TSV parsing.",
          },
        ],
      },
      {
        sessionID: "markdown_table_session",
        title: "Markdown table parser",
        messages: [
          {
            id: "md_fact_1",
            text: "Markdown tables use pipes and alignment markers; do not use this as TSV schema rationale.",
          },
        ],
      },
    ],
  },
  {
    id: "multi-agent-synthesis",
    title: "Multi-agent synthesis",
    question:
      "Which child agent's prior finding explains why src/report/summary.ts keeps failed-test IDs in the final report?",
    required: [
      {
        id: "child_agent",
        patterns: [/test investigator/i, /child/i, /sub-agent/i],
      },
      { id: "failed_test_ids", patterns: [/failed[- ]test/i, /test ids/i] },
      { id: "triage", patterns: [/triage/i, /reproduce/i, /debug/i] },
    ],
    forbidden: ["docs writer", "style reviewer", "billing queue"],
    sourceFiles: [
      {
        file: "src/report/summary.ts",
        lines: [
          "export function includeFailureIDs(ids: string[]) {",
          "  return ids.length > 0 ? { failed_test_ids: ids } : {};",
          "}",
        ],
      },
    ],
    relevant: {
      sessionID: "test_investigator_child_session",
      title: "Test investigator child session",
      messages: [
        {
          id: "child_fact_1",
          supportsAnswer: true,
          text: "The test investigator child found that failed-test IDs must remain in final reports so a later agent can reproduce and triage exact failures.",
        },
        {
          id: "child_fact_2",
          text: "The parent accepted this child finding and kept failed_test_ids in src/report/summary.ts.",
        },
      ],
    },
    distractors: [
      {
        sessionID: "docs_writer_child_session",
        title: "Docs writer child session",
        messages: [
          {
            id: "docs_child_fact_1",
            text: "The docs writer child asked for shorter report prose and no debugging IDs.",
          },
        ],
      },
      {
        sessionID: "style_reviewer_child_session",
        title: "Style reviewer child session",
        messages: [
          {
            id: "style_child_fact_1",
            text: "The style reviewer child wanted field names alphabetized; not the rationale for failed-test IDs.",
          },
        ],
      },
    ],
  },
  {
    id: "blame-line-rationale",
    title: "Blame line rationale",
    question:
      "Using provenance, why does src/cache/ttl.ts cap requested TTL with namespaceMaxSeconds on line 2?",
    required: [
      {
        id: "cap_ttl",
        patterns: [/cap/i, /namespaceMaxSeconds/i, /namespace max/i],
      },
      {
        id: "noisy_namespace",
        patterns: [/noisy namespace/i, /unrelated namespace/i],
      },
      {
        id: "line_rationale",
        patterns: [/line/i, /src\/cache\/ttl\.ts/i, /ttl/i],
      },
    ],
    forbidden: ["billing retry", "markdown parser", "global mutex"],
    sourceFiles: [
      {
        file: "src/cache/ttl.ts",
        lines: [
          "export function capNamespaceTTL(requestedSeconds: number, namespaceMaxSeconds: number) {",
          "  return Math.min(requestedSeconds, namespaceMaxSeconds);",
          "}",
        ],
      },
    ],
    relevant: {
      sessionID: "ttl_blame_session",
      title: "TTL blame rationale session",
      messages: [
        {
          id: "ttl_fact_1",
          text: "The code line was introduced in src/cache/ttl.ts.",
        },
        {
          id: "ttl_fact_2",
          supportsAnswer: true,
          text: "Line 2 caps requested TTL with namespaceMaxSeconds so a noisy namespace cannot extend stale cache retention beyond its namespace budget.",
        },
      ],
    },
    distractors: [
      {
        sessionID: "ttl_billing_session",
        title: "Billing TTL distractor",
        messages: [
          {
            id: "ttl_billing_fact_1",
            text: "Billing TTL is capped by provider policy, not namespaceMaxSeconds.",
          },
        ],
      },
      {
        sessionID: "ttl_markdown_session",
        title: "Markdown TTL distractor",
        messages: [
          {
            id: "ttl_md_fact_1",
            text: "Markdown preview TTL was shortened for docs preview freshness.",
          },
        ],
      },
    ],
    blame: { file: "src/cache/ttl.ts", line: 2 },
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
  if (options.prepareOnly) {
    await writeSummary(options.outDir, [], options);
    console.log(`Prepared blog provenance benchmark at ${options.outDir}`);
    return;
  }

  const selectedFixtures = fixtures.filter((fixture) =>
    options.fixtures.includes(fixture.id),
  );
  const results: Array<{
    fixture: string;
    condition: ConditionID;
    statsPath: string;
    error?: string;
    pass?: boolean;
  }> = [];
  for (const fixture of selectedFixtures) {
    for (const condition of options.conditions) {
      if (condition === "memmould-blame-lookup" && !fixture.blame) continue;
      const result = await runFixtureCondition(fixture, condition, options);
      results.push(result);
      await writeSummary(options.outDir, results, options);
    }
  }
  await writeSummary(options.outDir, results, options);
  const analysis = await analyzeRun(options.outDir);
  await writeAnalysisFiles(options.outDir, analysis);
  console.log(renderAnalysisMarkdown(analysis));
  console.log(`Blog provenance artifacts written to ${options.outDir}`);
}

async function runFixtureCondition(
  fixture: Fixture,
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
  await fs.mkdir(conditionDir, { recursive: true });
  const statsPath = path.join(conditionDir, "stats.json");
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const startedAt = Date.now();
  try {
    await prepareFixtureRepo(worktree, fixture, {
      includeTranscripts: condition.includes("searchable"),
    });
    const opencodeRoot = resolveOpenCodeRoot(conditionDir);
    const env = await buildOpenCodeEnv({
      opencodeRoot,
      conditionDir,
      modelSlug: options.modelSlug,
      childModelSlug: options.childModelSlug,
      plugin: usesMemMould(condition),
    });
    server = await startServer(env, worktree);
    const client = createOpencodeClient({ baseUrl: server.url });
    await pickModel(client, worktree, options.modelSlug);
    if (options.childModelSlug)
      await pickModel(client, worktree, options.childModelSlug);

    const seeded = usesMemMould(condition)
      ? await seedHistoricalSessions(
          client,
          worktree,
          fixture,
          options.promptTimeoutMs,
        )
      : staticSeededSessions(fixture);
    if (
      condition === "memmould-blame-lookup" &&
      fixture.blame &&
      seeded.relevantSessionID
    ) {
      await writeBlameCommitMap(opencodeRoot.home, worktree, fixture, seeded);
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
    const childMessages = await collectChildMessages(
      client,
      worktree,
      messages,
    );
    await fs.writeFile(
      path.join(conditionDir, "messages.json"),
      `${JSON.stringify(messages, null, 2)}\n`,
    );
    if (childMessages.length > 0) {
      await fs.writeFile(
        path.join(conditionDir, "child-messages.json"),
        `${JSON.stringify(childMessages, null, 2)}\n`,
      );
    }
    await fs.writeFile(
      path.join(conditionDir, "seeded-sessions.json"),
      `${JSON.stringify(seeded, null, 2)}\n`,
    );
    const stats = buildStats({
      fixture,
      condition,
      seeded,
      messages,
      childMessages,
      startedAt,
    });
    await fs.writeFile(statsPath, `${JSON.stringify(stats, null, 2)}\n`);
    await fs.rm(worktree, { recursive: true, force: true });
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

function usesMemMould(condition: ConditionID) {
  return (
    condition === "memmould-map-zoom" ||
    condition === "subagent-map-zoom" ||
    condition === "memmould-blame-lookup"
  );
}

function parseOptions(): Options {
  const args = process.argv.slice(2);
  const fixtureArg = valueArg(args, "--fixtures");
  const conditionArg = valueArg(args, "--conditions");
  const timeoutMinutes = Number(
    valueArg(args, "--prompt-timeout-minutes") ?? "12",
  );
  assert.ok(Number.isFinite(timeoutMinutes) && timeoutMinutes > 0);
  const selectedFixtures = fixtureArg
    ? splitList(fixtureArg)
    : fixtures.map((fixture) => fixture.id);
  const knownFixtures = new Set(fixtures.map((fixture) => fixture.id));
  for (const fixture of selectedFixtures)
    assert.ok(knownFixtures.has(fixture), `unknown fixture: ${fixture}`);
  const selectedConditions = (
    conditionArg ? splitList(conditionArg) : defaultConditions
  ) as ConditionID[];
  for (const condition of selectedConditions)
    assert.ok(
      defaultConditions.includes(condition),
      `unknown condition: ${condition}`,
    );
  const analyzeRun = valueArg(args, "--analyze-run");
  return {
    conditions: selectedConditions,
    fixtures: selectedFixtures,
    outDir: path.resolve(valueArg(args, "--out") ?? defaultOutDir),
    modelSlug: process.env.MEM_MOULD_E2E_MODEL ?? "openai/gpt-5.5",
    childModelSlug: process.env.MEM_MOULD_E2E_CHILD_MODEL || undefined,
    promptTimeoutMs: timeoutMinutes * 60_000,
    prepareOnly: hasArg(args, "--prepare-only"),
    analyzeRun: analyzeRun ? path.resolve(analyzeRun) : undefined,
  };
}

async function prepareFixtureRepo(
  worktree: string,
  fixture: Fixture,
  options: { includeTranscripts: boolean },
) {
  await fs.rm(worktree, { recursive: true, force: true });
  for (const file of fixture.sourceFiles) {
    await fs.mkdir(path.dirname(path.join(worktree, file.file)), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(worktree, file.file),
      `${file.lines.join("\n")}\n`,
    );
  }
  if (options.includeTranscripts)
    await writeTranscriptCorpus(worktree, fixture);
  await execFileAsync("git", ["init"], { cwd: worktree });
  await execFileAsync("git", ["add", "."], { cwd: worktree });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Provenance Blog",
      "-c",
      "user.email=provenance-blog@example.com",
      "commit",
      "-m",
      `seed ${fixture.id}`,
    ],
    { cwd: worktree },
  );
}

async function writeTranscriptCorpus(worktree: string, fixture: Fixture) {
  const dir = path.join(worktree, "memory", "transcripts");
  await fs.mkdir(dir, { recursive: true });
  const sessions = [
    fixture.relevant,
    ...fixture.distractors,
    ...generatedDistractors(fixture),
  ];
  await fs.writeFile(
    path.join(worktree, "memory", "manifest.json"),
    `${JSON.stringify(
      {
        fixture: fixture.id,
        transcript_dir: "memory/transcripts",
        sessions: sessions.map((session) => ({
          session_id: session.sessionID,
          title: session.title,
          file: `${session.sessionID}.md`,
        })),
      },
      null,
      2,
    )}\n`,
  );
  for (const session of sessions) {
    await fs.writeFile(
      path.join(dir, `${session.sessionID}.md`),
      transcriptMarkdown(session),
    );
  }
}

function transcriptMarkdown(session: {
  sessionID: string;
  title: string;
  messages: MessageFact[];
}) {
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

function generatedDistractors(fixture: Fixture) {
  return Array.from({ length: 8 }, (_, index) => ({
    sessionID: `${fixture.id}_decoy_${index + 1}`.replaceAll("-", "_"),
    title: `${fixture.title} decoy ${index + 1}`,
    messages: [
      {
        id: `decoy_fact_${index + 1}`,
        text: `Decoy ${index + 1}: mentions ${fixture.sourceFiles[0]?.file ?? "the file"} and similar terms, but it is not the final rationale and should not be cited.`,
      },
      {
        id: `decoy_noise_${index + 1}`,
        text: "This note exists to make transcript search less trivial and force evidence citation rather than keyword matching.",
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
  childModelSlug?: string;
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
  const agentConfig: Record<string, Record<string, unknown>> = {};
  if (input.childModelSlug)
    agentConfig.general = { model: input.childModelSlug };
  agentConfig.transcript = {
    mode: "subagent",
    description:
      "Transcript provenance investigator. Use this agent when the parent asks for glob, grep, and read over prior transcript files.",
    ...(input.childModelSlug ? { model: input.childModelSlug } : {}),
    permission: {
      glob: "allow",
      grep: "allow",
      read: "allow",
      bash: "deny",
      task: "deny",
      todowrite: "deny",
      session_lookup: "deny",
      session_detail: "deny",
      message_detail: "deny",
      session_tree: "deny",
      blame_lookup: "deny",
    },
  };
  if (input.plugin) {
    agentConfig.memmould = {
      mode: "subagent",
      description:
        "Mem-mould provenance investigator. Use this agent when the parent asks for session_lookup, session_detail, and message_detail over prior session maps.",
      ...(input.childModelSlug ? { model: input.childModelSlug } : {}),
      permission: {
        glob: "deny",
        grep: "deny",
        read: "deny",
        bash: "deny",
        session_lookup: "allow",
        session_detail: "allow",
        message_detail: "allow",
        session_tree: "allow",
        blame_lookup: "allow",
      },
    };
    config.plugin = [
      pathToFileURL(
        path.join(repoRoot, "src", "context-map", "server-plugin.ts"),
      ).href,
    ];
  }
  if (Object.keys(agentConfig).length > 0) config.agent = agentConfig;
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
    `provider is not connected in isolated sandbox: ${requested.providerID}`,
  );
  assert.ok(
    requested.modelID in provider.models,
    `model is not available: ${requested.providerID}/${requested.modelID}`,
  );
}

function parseModelSlug(modelSlug: string): ModelRef {
  const index = modelSlug.indexOf("/");
  assert.ok(index > 0, `model must be provider/model, got: ${modelSlug}`);
  return {
    providerID: modelSlug.slice(0, index),
    modelID: modelSlug.slice(index + 1),
  };
}

async function seedHistoricalSessions(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  fixture: Fixture,
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
    sessions.push({
      id: sessionID,
      title: distractor.title,
      role: "distractor",
    });
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
  const messages = await listSessionMessages(
    client,
    directory,
    relevantSessionID,
  );
  return {
    relevantSessionID,
    relevantMessageIDs: messages
      .map((message) => message.info?.id)
      .filter((id): id is string => Boolean(id)),
    sessions,
  };
}

function staticSeededSessions(fixture: Fixture): SeededSessions {
  return {
    relevantMessageIDs: fixture.relevant.messages
      .filter((message) => message.supportsAnswer)
      .map((message) => message.id),
    sessions: [
      {
        id: fixture.relevant.sessionID,
        title: fixture.relevant.title,
        role: "relevant",
      },
      ...fixture.distractors.map((item) => ({
        id: item.sessionID,
        title: item.title,
        role: "distractor" as const,
      })),
    ],
  };
}

function seedSystemPrompt() {
  return "Preserve this prior coding-session record for a provenance benchmark. Do not edit files or call tools. Acknowledge concisely while preserving the important rationale.";
}

async function writeBlameCommitMap(
  home: string,
  worktree: string,
  fixture: Fixture,
  seeded: SeededSessions,
) {
  const commitHash = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktree })
  ).stdout.trim();
  const root = path.join(home, ".opencode", "context-maps");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "_commits.json"),
    `${JSON.stringify(
      {
        version: 1,
        updatedAt: Date.now(),
        entries: {
          [commitHash]: {
            commitHash,
            sessionID: seeded.relevantSessionID,
            timestamp: Date.now(),
            directory: worktree,
            worktree,
            activeBlobIDs: [],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  void fixture;
}

function buildPromptForCondition(
  fixture: Fixture,
  condition: ConditionID,
  worktree: string,
): PromptInput {
  const answerContract = [
    "Return compact JSON only with this shape:",
    '{"answer":"...","evidence":{"session_id":"...","blob_id":"...","message_id":"..."},"rationale":"...","irrelevant_context_ignored":["..."]}',
    "The cited message_id must support the full answer, not just a nearby subclaim.",
    "If a correction, stale detail, or rejected alternative matters, mention it explicitly in rationale.",
  ].join("\n");
  const transcriptDir = path.join(worktree, "memory", "transcripts");
  const distractorTitles = fixture.distractors
    .map((item) => item.title)
    .join(", ");
  if (condition === "searchable-transcript") {
    return {
      system:
        "Answer with compact JSON only. Use only glob, grep, and read over transcript files before answering. Do not use bash or mem-mould/session tools. Cite exact session_id and message_id.",
      tools: { glob: true, grep: true, read: true },
      text: [
        `Transcript directory: ${transcriptDir}`,
        `Question: ${fixture.question}`,
        `Distractors include: ${distractorTitles}`,
        answerContract,
      ].join("\n"),
    };
  }
  if (condition === "subagent-searchable-transcript") {
    return {
      system:
        "Answer with compact JSON only. Use the Task tool exactly once with subagent_type='transcript'. The child must use only glob, grep, and read over transcript files before returning evidence. Do not ask the child to use bash or mem-mould/session tools.",
      tools: { task: true },
      text: [
        `Transcript directory: ${transcriptDir}`,
        `Question: ${fixture.question}`,
        "Task instruction: call subagent_type='transcript', not general or explore.",
        `Ask the child to ignore distractors: ${distractorTitles}`,
        answerContract,
      ].join("\n"),
    };
  }
  if (condition === "memmould-blame-lookup") {
    assert.ok(fixture.blame, "blame condition requires fixture.blame");
    return {
      system:
        "Answer with compact JSON only. Use blame_lookup first, then session_detail detail='messages', then message_detail for exact evidence. Do not use glob, grep, read, bash, or transcript files.",
      tools: { blame_lookup: true, session_detail: true, message_detail: true },
      text: [
        `Question: ${fixture.question}`,
        `Use blame target file=${fixture.blame.file} line=${fixture.blame.line}.`,
        answerContract,
      ].join("\n"),
    };
  }
  if (condition === "subagent-map-zoom") {
    return {
      system:
        "Answer with compact JSON only. Use the Task tool exactly once with subagent_type='memmould'. The child must use only session_lookup, session_detail detail='messages', and message_detail before returning evidence. Do not ask the child to use glob, grep, read, bash, or transcript files.",
      tools: { task: true, session_tree: true },
      text: [
        `Question: ${fixture.question}`,
        `Expected relevant prior session: ${fixture.relevant.title}`,
        "Task instruction: call subagent_type='memmould', not general or explore.",
        "No transcript corpus is available for this condition; provenance must come from mem-mould session tools.",
        `Ask the child to ignore distractors: ${distractorTitles}`,
        answerContract,
      ].join("\n"),
    };
  }
  return {
    system:
      "Answer with compact JSON only. Use session_lookup, then session_detail detail='messages', then message_detail before answering. Do not use glob, grep, read, bash, or transcript files.",
    tools: {
      session_lookup: true,
      session_detail: true,
      message_detail: true,
      session_tree: true,
    },
    text: [
      `Question: ${fixture.question}`,
      `Search hint: ${fixture.relevant.title}. Ignore distractors: ${distractorTitles}`,
      answerContract,
    ].join("\n"),
  };
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

async function collectChildMessages(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  parentMessages: SessionMessage[],
) {
  const ids = new Set<string>();
  for (const part of toolParts(parentMessages)) {
    if (part.tool !== "task") continue;
    const output =
      typeof part.state?.output === "string" ? part.state.output : "";
    const outputID = output.match(/task_id:\s*(\S+)/)?.[1];
    if (outputID) ids.add(outputID);
    const metadata = part.state?.metadata ?? part.metadata ?? {};
    if (typeof metadata.sessionId === "string") ids.add(metadata.sessionId);
  }
  const result: Array<{ sessionID: string; messages: SessionMessage[] }> = [];
  for (const sessionID of ids)
    result.push({
      sessionID,
      messages: await listSessionMessages(client, directory, sessionID),
    });
  return result;
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
      new Promise<never>(
        (_, reject) =>
          (timeout = setTimeout(() => reject(new Error(message)), timeoutMs)),
      ),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function buildStats(input: {
  fixture: Fixture;
  condition: ConditionID;
  seeded: SeededSessions;
  messages: SessionMessage[];
  childMessages: Array<{ sessionID: string; messages: SessionMessage[] }>;
  startedAt: number;
}): RunStats {
  const outputText = messageText(latestAssistantMessage(input.messages));
  const correctnessText = answerCorrectnessText(outputText);
  const forbiddenText = answerForbiddenText(outputText);
  const requiredHits = input.fixture.required
    .filter((item) =>
      item.patterns.some((pattern) => pattern.test(correctnessText)),
    )
    .map((item) => item.id);
  const missingRequired = input.fixture.required
    .filter((item) => !requiredHits.includes(item.id))
    .map((item) => item.id);
  const forbiddenHits = termsInText(input.fixture.forbidden, forbiddenText);
  const citationHits = citationMatches(outputText, input.seeded, input.fixture);
  const childFlatMessages = input.childMessages.flatMap(
    (item) => item.messages,
  );
  const allMessages = [...input.messages, ...childFlatMessages];
  const tools = toolParts(allMessages);
  const toolNames = tools.map((part) => part.tool).filter(Boolean) as string[];
  const transcriptFilesRead = transcriptReadFiles(tools);
  const toolPath = evaluateToolPath(
    input.condition,
    toolNames,
    transcriptFilesRead,
  );
  const irrelevantTranscriptReads = transcriptFilesRead.filter(
    (file) =>
      input.fixture.distractors.some((d) => file.includes(d.sessionID)) ||
      /decoy/.test(file),
  );
  const answerPassed =
    missingRequired.length === 0 && forbiddenHits.length === 0;
  const provenancePassed =
    citationHits.includes("session") && citationHits.includes("message");
  return {
    fixture: input.fixture.id,
    condition: input.condition,
    benchmark_passed: answerPassed && provenancePassed && toolPath.passed,
    answer_passed: answerPassed,
    provenance_passed: provenancePassed,
    tool_path_passed: toolPath.passed,
    tool_path_failures: toolPath.failures,
    required_hits: requiredHits,
    missing_required: missingRequired,
    forbidden_hits: forbiddenHits,
    citation_hits: citationHits,
    output_preview: outputText.slice(0, 1200),
    tool_names: toolNames,
    tool_call_count: toolNames.length,
    context_tool_call_count: toolNames.filter((tool) =>
      [
        "session_lookup",
        "session_detail",
        "message_detail",
        "session_tree",
        "blame_lookup",
      ].includes(tool),
    ).length,
    search_tool_call_count: toolNames.filter((tool) =>
      ["glob", "grep"].includes(tool),
    ).length,
    read_tool_call_count: toolNames.filter((tool) => tool === "read").length,
    task_tool_call_count: toolNames.filter((tool) => tool === "task").length,
    message_detail_call_count: toolNames.filter(
      (tool) => tool === "message_detail",
    ).length,
    blame_lookup_call_count: toolNames.filter((tool) => tool === "blame_lookup")
      .length,
    transcript_files_read: transcriptFilesRead,
    irrelevant_transcript_reads: irrelevantTranscriptReads,
    child_session_count: input.childMessages.length,
    parent_tokens: summarizeTokens(input.messages),
    child_tokens: summarizeTokens(childFlatMessages),
    tokens: summarizeTokens(allMessages),
    parent_models: modelIDs(input.messages),
    child_models: modelIDs(childFlatMessages),
    duration_ms: Date.now() - input.startedAt,
    relevant_session_id:
      input.seeded.relevantSessionID ?? input.fixture.relevant.sessionID,
    relevant_message_ids: input.seeded.relevantMessageIDs,
  };
}

function failedStats(
  fixture: Fixture,
  condition: ConditionID,
  startedAt: number,
  error: string,
): RunStats {
  return {
    fixture: fixture.id,
    condition,
    benchmark_passed: false,
    answer_passed: false,
    provenance_passed: false,
    tool_path_passed: false,
    tool_path_failures: ["run_error"],
    required_hits: [],
    missing_required: fixture.required.map((item) => item.id),
    forbidden_hits: [],
    citation_hits: [],
    output_preview: error.slice(0, 1200),
    tool_names: [],
    tool_call_count: 0,
    context_tool_call_count: 0,
    search_tool_call_count: 0,
    read_tool_call_count: 0,
    task_tool_call_count: 0,
    message_detail_call_count: 0,
    blame_lookup_call_count: 0,
    transcript_files_read: [],
    irrelevant_transcript_reads: [],
    child_session_count: 0,
    parent_tokens: emptyTokenBucket(),
    child_tokens: emptyTokenBucket(),
    tokens: emptyTokenBucket(),
    parent_models: [],
    child_models: [],
    duration_ms: Date.now() - startedAt,
    relevant_session_id: fixture.relevant.sessionID,
    relevant_message_ids: fixture.relevant.messages
      .filter((message) => message.supportsAnswer)
      .map((message) => message.id),
    error,
  };
}

function evaluateToolPath(
  condition: ConditionID,
  toolNames: string[],
  transcriptFilesRead: string[],
) {
  const failures: string[] = [];
  const has = (tool: string) => toolNames.includes(tool);
  const requireTools = (tools: string[]) => {
    for (const tool of tools) if (!has(tool)) failures.push(`missing:${tool}`);
  };
  const rejectTools = (tools: string[]) => {
    for (const tool of tools)
      if (has(tool)) failures.push(`disallowed:${tool}`);
  };
  const searchTools = ["glob", "grep", "read", "bash"];
  const contextTools = [
    "session_lookup",
    "session_detail",
    "message_detail",
    "session_tree",
    "blame_lookup",
  ];

  if (condition === "searchable-transcript") {
    requireTools(["glob", "grep", "read"]);
    rejectTools(["task", "bash", ...contextTools]);
  } else if (condition === "subagent-searchable-transcript") {
    requireTools(["task", "glob", "grep", "read"]);
    rejectTools(["bash", ...contextTools]);
  } else if (condition === "memmould-map-zoom") {
    requireTools(["session_lookup", "session_detail", "message_detail"]);
    rejectTools(["task", ...searchTools, "blame_lookup"]);
  } else if (condition === "subagent-map-zoom") {
    requireTools([
      "task",
      "session_lookup",
      "session_detail",
      "message_detail",
    ]);
    rejectTools(searchTools.concat("blame_lookup"));
  } else if (condition === "memmould-blame-lookup") {
    requireTools(["blame_lookup", "session_detail", "message_detail"]);
    rejectTools(["task", ...searchTools]);
  }

  if (condition.startsWith("memmould") || condition === "subagent-map-zoom") {
    if (transcriptFilesRead.length > 0) failures.push("transcript_read");
  }
  return { passed: failures.length === 0, failures };
}

function answerCorrectnessText(outputText: string) {
  const parsed = parseAnswer(outputText);
  if (!parsed) return outputText;
  return [parsed.answer, parsed.rationale, parsed.why_not_global_mutex]
    .filter((item): item is string => typeof item === "string")
    .join("\n");
}

function answerForbiddenText(outputText: string) {
  const parsed = parseAnswer(outputText);
  if (!parsed) return outputText;
  return typeof parsed.answer === "string" ? parsed.answer : outputText;
}

function parseAnswer(outputText: string) {
  try {
    return JSON.parse(outputText) as {
      answer?: unknown;
      rationale?: unknown;
      why_not_global_mutex?: unknown;
    };
  } catch {}
  const match = outputText.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]) as {
      answer?: unknown;
      rationale?: unknown;
      why_not_global_mutex?: unknown;
    };
  } catch {
    return undefined;
  }
}

function citationMatches(
  outputText: string,
  seeded: SeededSessions,
  fixture: Fixture,
) {
  const hits: string[] = [];
  const sessionID = seeded.relevantSessionID ?? fixture.relevant.sessionID;
  if (
    outputText.includes(sessionID) ||
    outputText.includes(fixture.relevant.title)
  )
    hits.push("session");
  if (seeded.relevantMessageIDs.some((id) => outputText.includes(id)))
    hits.push("message");
  if (/blob[_-]?id/i.test(outputText) && !/"blob_id"\s*:\s*""/.test(outputText))
    hits.push("blob");
  return hits;
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
      return typeof input.filePath === "string" ? input.filePath : "";
    })
    .filter((file) => file.includes("memory/transcripts"));
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

function summarizeTokens(messages: SessionMessage[]) {
  const bucket = emptyTokenBucket();
  for (const message of messages) {
    bucket.messages++;
    if ((message.info?.role ?? message.role) !== "assistant") continue;
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

function modelIDs(messages: SessionMessage[]) {
  return [
    ...new Set(
      messages
        .map(
          (message) =>
            `${message.info?.providerID ?? ""}/${message.info?.modelID ?? ""}`,
        )
        .filter((value) => value !== "/"),
    ),
  ];
}

async function analyzeRun(outDir: string): Promise<Analysis> {
  const rows: RunStats[] = [];
  await collectStats(path.join(outDir, "fixtures"), rows);
  return {
    outDir,
    generatedAt: new Date().toISOString(),
    rows: rows.sort((a, b) =>
      a.fixture === b.fixture
        ? a.condition.localeCompare(b.condition)
        : a.fixture.localeCompare(b.fixture),
    ),
  };
}

async function collectStats(dir: string, rows: RunStats[]) {
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectStats(file, rows);
    if (entry.isFile() && entry.name === "stats.json") {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as RunStats & {
        error?: unknown;
      };
      rows.push(normalizeRunStats(parsed));
    }
  }
}

function normalizeRunStats(input: Partial<RunStats>): RunStats {
  return {
    fixture: input.fixture ?? "unknown",
    condition: input.condition as ConditionID,
    benchmark_passed: input.benchmark_passed ?? false,
    answer_passed: input.answer_passed ?? false,
    provenance_passed: input.provenance_passed ?? false,
    tool_path_passed: input.tool_path_passed ?? false,
    tool_path_failures: input.tool_path_failures ?? [],
    required_hits: input.required_hits ?? [],
    missing_required: input.missing_required ?? [],
    forbidden_hits: input.forbidden_hits ?? [],
    citation_hits: input.citation_hits ?? [],
    output_preview: input.output_preview ?? String(input.error ?? ""),
    tool_names: input.tool_names ?? [],
    tool_call_count: input.tool_call_count ?? 0,
    context_tool_call_count: input.context_tool_call_count ?? 0,
    search_tool_call_count: input.search_tool_call_count ?? 0,
    read_tool_call_count: input.read_tool_call_count ?? 0,
    task_tool_call_count: input.task_tool_call_count ?? 0,
    message_detail_call_count: input.message_detail_call_count ?? 0,
    blame_lookup_call_count: input.blame_lookup_call_count ?? 0,
    transcript_files_read: input.transcript_files_read ?? [],
    irrelevant_transcript_reads: input.irrelevant_transcript_reads ?? [],
    child_session_count: input.child_session_count ?? 0,
    parent_tokens: input.parent_tokens ?? emptyTokenBucket(),
    child_tokens: input.child_tokens ?? emptyTokenBucket(),
    tokens: input.tokens ?? emptyTokenBucket(),
    parent_models: input.parent_models ?? [],
    child_models: input.child_models ?? [],
    duration_ms: input.duration_ms ?? 0,
    relevant_session_id: input.relevant_session_id ?? "",
    relevant_message_ids: input.relevant_message_ids ?? [],
    error: input.error,
  };
}

async function writeAnalysisFiles(outDir: string, analysis: Analysis) {
  await fs.writeFile(
    path.join(outDir, "analysis.json"),
    `${JSON.stringify(analysis, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(outDir, "analysis.md"),
    renderAnalysisMarkdown(analysis),
  );
  await fs.writeFile(
    path.join(outDir, "analysis.csv"),
    renderAnalysisCsv(analysis),
  );
  await writeEvidenceMarkdown(outDir, analysis);
  await writeCharts(outDir, analysis);
}

function renderAnalysisMarkdown(analysis: Analysis) {
  const rows = analysis.rows.map(
    (row) =>
      `| ${row.fixture} | ${row.condition} | ${String(row.benchmark_passed)} | ${String(row.answer_passed)} | ${String(row.provenance_passed)} | ${String(row.tool_path_passed)} | ${row.tool_path_failures.join("; ")} | ${row.tool_names.join(" -> ")} | ${row.tokens.input.toLocaleString()} | ${row.tokens.cacheRead.toLocaleString()} | ${formatPercent(cacheHitShare(row.tokens))} | ${row.parent_tokens.input.toLocaleString()} | ${row.child_tokens.input.toLocaleString()} | ${row.irrelevant_transcript_reads.length} |`,
  );
  return [
    "# Provenance Blog Benchmark Analysis",
    "",
    `- Run: ${analysis.outDir}`,
    `- Generated: ${analysis.generatedAt}`,
    `- Passed: ${analysis.rows.filter((row) => row.benchmark_passed).length}/${analysis.rows.length}`,
    "",
    "| Fixture | Condition | Pass | Answer | Provenance | Tool Policy | Tool Failures | Tool Path | Input Tok | Cache Read Tok | Cache Hit | Parent Input | Child Input | Irrelevant Reads |",
    "|---|---|---:|---:|---:|---:|---|---|---:|---:|---:|---:|---:|---:|",
    ...rows,
    "",
  ].join("\n");
}

function renderAnalysisCsv(analysis: Analysis) {
  const header = [
    "fixture",
    "condition",
    "pass",
    "answer_pass",
    "provenance_pass",
    "tool_path_pass",
    "tool_path_failures",
    "input_tokens",
    "cache_read_tokens",
    "cache_hit_share",
    "parent_input",
    "child_input",
    "tool_path",
    "irrelevant_reads",
  ].join(",");
  const rows = analysis.rows.map((row) =>
    [
      row.fixture,
      row.condition,
      row.benchmark_passed,
      row.answer_passed,
      row.provenance_passed,
      row.tool_path_passed,
      csvCell(row.tool_path_failures.join(";")),
      row.tokens.input,
      row.tokens.cacheRead,
      cacheHitShare(row.tokens) ?? "",
      row.parent_tokens.input,
      row.child_tokens.input,
      csvCell(row.tool_names.join(" -> ")),
      row.irrelevant_transcript_reads.length,
    ].join(","),
  );
  return `${header}\n${rows.join("\n")}\n`;
}

async function writeEvidenceMarkdown(outDir: string, analysis: Analysis) {
  const lines = ["# Evidence Snippets", ""];
  for (const row of analysis.rows) {
    lines.push(
      `## ${row.fixture} / ${row.condition}`,
      "",
      `- Pass: ${row.benchmark_passed}`,
      `- Tool policy: ${row.tool_path_passed}${row.tool_path_failures.length > 0 ? ` (${row.tool_path_failures.join(", ")})` : ""}`,
      `- Tool path: ${row.tool_names.join(" -> ") || "none"}`,
      `- Input tokens: ${row.tokens.input.toLocaleString()}`,
      `- Cache hit: ${formatPercent(cacheHitShare(row.tokens))}`,
      "",
      row.output_preview,
      "",
    );
  }
  await fs.writeFile(path.join(outDir, "evidence.md"), `${lines.join("\n")}\n`);
}

async function writeCharts(outDir: string, analysis: Analysis) {
  const chartDir = path.join(outDir, "charts");
  await fs.mkdir(chartDir, { recursive: true });
  await fs.writeFile(
    path.join(chartDir, "input-tokens.svg"),
    barChartSvg(
      "Input Tokens",
      analysis.rows.map((row) => ({
        label: `${row.fixture}/${row.condition}`,
        value: row.tokens.input,
      })),
    ),
  );
  await fs.writeFile(
    path.join(chartDir, "cache-hit.svg"),
    barChartSvg(
      "Cache Hit Share",
      analysis.rows.map((row) => ({
        label: `${row.fixture}/${row.condition}`,
        value: Math.round((cacheHitShare(row.tokens) ?? 0) * 100),
      })),
    ),
  );
  await fs.writeFile(
    path.join(chartDir, "parent-child-input.svg"),
    groupedBarSvg(
      "Parent vs Child Input",
      analysis.rows.map((row) => ({
        label: `${row.fixture}/${row.condition}`,
        a: row.parent_tokens.input,
        b: row.child_tokens.input,
      })),
    ),
  );
}

function barChartSvg(
  title: string,
  data: Array<{ label: string; value: number }>,
) {
  const width = 1200;
  const rowHeight = 28;
  const height = 70 + data.length * rowHeight;
  const max = Math.max(1, ...data.map((item) => item.value));
  const bars = data.map((item, index) => {
    const y = 45 + index * rowHeight;
    const w = Math.round((item.value / max) * 720);
    return `<text x="10" y="${y + 16}" font-size="11">${escapeXml(item.label)}</text><rect x="360" y="${y}" width="${w}" height="18" fill="#4f46e5"/><text x="${370 + w}" y="${y + 14}" font-size="11">${item.value.toLocaleString()}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="10" y="25" font-size="18" font-weight="bold">${escapeXml(title)}</text>${bars.join("")}</svg>`;
}

function groupedBarSvg(
  title: string,
  data: Array<{ label: string; a: number; b: number }>,
) {
  const width = 1200;
  const rowHeight = 32;
  const height = 70 + data.length * rowHeight;
  const max = Math.max(1, ...data.flatMap((item) => [item.a, item.b]));
  const bars = data.map((item, index) => {
    const y = 45 + index * rowHeight;
    const wa = Math.round((item.a / max) * 330);
    const wb = Math.round((item.b / max) * 330);
    return `<text x="10" y="${y + 19}" font-size="11">${escapeXml(item.label)}</text><rect x="360" y="${y}" width="${wa}" height="12" fill="#2563eb"/><rect x="360" y="${y + 14}" width="${wb}" height="12" fill="#16a34a"/><text x="${370 + Math.max(wa, wb)}" y="${y + 19}" font-size="11">p ${item.a.toLocaleString()} / c ${item.b.toLocaleString()}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="10" y="25" font-size="18" font-weight="bold">${escapeXml(title)}</text>${bars.join("")}</svg>`;
}

async function writeSummary(
  outDir: string,
  results: Array<{
    fixture: string;
    condition: ConditionID;
    statsPath: string;
    error?: string;
    pass?: boolean;
  }>,
  options: Options,
) {
  const rows = results.map(
    (result) =>
      `| ${result.fixture} | ${result.condition} | ${result.pass === undefined ? "" : String(result.pass)} | [stats](${path.relative(outDir, result.statsPath)}) | ${result.error ? result.error.split("\n")[0]?.replaceAll("|", "\\|") : ""} |`,
  );
  const lines = [
    "# Provenance Blog Benchmark Run",
    "",
    `- Model: ${options.modelSlug}`,
    `- Child model: ${options.childModelSlug ?? "inherits parent"}`,
    `- Fixtures: ${options.fixtures.join(", ")}`,
    `- Conditions: ${options.conditions.join(", ")}`,
    "",
    "| Fixture | Condition | Pass | Stats | Error |",
    "|---|---|---:|---|---|",
    ...rows,
    "",
  ];
  await fs.writeFile(path.join(outDir, "summary.md"), `${lines.join("\n")}\n`);
}

function cacheHitShare(bucket: TokenBucket) {
  const denominator = bucket.input + bucket.cacheRead;
  return denominator === 0 ? null : bucket.cacheRead / denominator;
}

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function formatPercent(value: number | null) {
  return value === null ? "" : `${(value * 100).toFixed(1)}%`;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

function timestampForPath(date: Date) {
  return date.toISOString().replaceAll(":", "").replaceAll(".", "-");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
