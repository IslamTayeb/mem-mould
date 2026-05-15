import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";

import { parseModelSlug, requiredModelSlug } from "../../tools/model";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(process.cwd());
const defaultOutDir = path.join(
  repoRoot,
  "benchmarks",
  "code-memory",
  "runs",
  timestampSlug(),
);

type ConditionID =
  | "code-only"
  | "rlm-transcript-search"
  | "memmould-only"
  | "memmould-guided-rlm";

type MemoryRole =
  | "unnecessary"
  | "helpful"
  | "harmful"
  | "missing"
  | "correction"
  | "synthesis";

type Options = {
  conditions: ConditionID[];
  fixtures: string[];
  outDir: string;
  modelSlug: string;
  promptTimeoutMs: number;
  repeats: number;
  workers: number;
  prepareOnly: boolean;
  analyzeRun?: string;
  combineRuns?: string[];
};

type CodeFile = { file: string; lines: string[] };

type MessageFact = {
  id: string;
  text: string;
  supportsTask?: boolean;
};

type HistoricalSession = {
  sessionID: string;
  title: string;
  messages: MessageFact[];
};

type CodeFixture = {
  id: string;
  title: string;
  memoryRole: MemoryRole;
  task: string;
  sourceFiles: CodeFile[];
  publicTestFiles: CodeFile[];
  hiddenTestFiles: CodeFile[];
  testCommand: string[];
  expectedTouchedFiles: string[];
  forbiddenPatchTerms: string[];
  forbiddenOutputTerms: string[];
  relevant?: HistoricalSession;
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

type TestResult = {
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

type RunStats = {
  fixture: string;
  title: string;
  repeat?: number;
  memory_role: MemoryRole;
  condition: ConditionID;
  benchmark_passed: boolean;
  tests_passed: boolean;
  public_tests_passed: boolean;
  hidden_tests_passed: boolean;
  expected_files_touched: boolean;
  touched_files_allowed: boolean;
  memory_policy_passed: boolean;
  tool_path_passed: boolean;
  tool_path_failures: string[];
  forbidden_patch_hits: string[];
  forbidden_output_hits: string[];
  touched_files: string[];
  unexpected_touched_files: string[];
  patch_bytes: number;
  output_preview: string;
  tool_names: string[];
  transcript_files_read: string[];
  irrelevant_transcript_reads: string[];
  context_tool_call_count: number;
  search_tool_call_count: number;
  read_tool_call_count: number;
  bash_tool_call_count: number;
  message_detail_call_count: number;
  memory_decision: string;
  citation_hits: string[];
  relevant_session_id: string;
  relevant_message_ids: string[];
  public_test: TestResult;
  hidden_test: TestResult;
  tokens: TokenBucket;
  models: string[];
  duration_ms: number;
  error?: unknown;
};

type Analysis = {
  outDir: string;
  generatedAt: string;
  sourceRuns?: string[];
  rows: RunStats[];
};

const defaultConditions: ConditionID[] = [
  "code-only",
  "rlm-transcript-search",
  "memmould-only",
  "memmould-guided-rlm",
];

const fixtures: CodeFixture[] = [
  {
    id: "memory-unnecessary-slug",
    title: "Memory unnecessary slug fix",
    memoryRole: "unnecessary",
    task: [
      "Fix slugify so the local tests pass.",
      "The repository and tests are sufficient for this task.",
      "Prior session memory, if available, is expected to be irrelevant and should not override current tests.",
    ].join("\n"),
    sourceFiles: [
      file("package.json", [
        "{",
        '  "type": "module",',
        '  "scripts": { "test": "node --test" }',
        "}",
      ]),
      file("src/slug.mjs", [
        "export function slugify(input) {",
        "  return String(input).toLowerCase().replaceAll(' ', '-');",
        "}",
      ]),
    ],
    publicTestFiles: [
      file("test/slug.test.mjs", [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { slugify } from "../src/slug.mjs";',
        "",
        'test("normalizes user-facing titles", () => {',
        '  assert.equal(slugify("  Hello   World! "), "hello-world");',
        '  assert.equal(slugify("Release_2026 Notes"), "release-2026-notes");',
        "});",
      ]),
    ],
    hiddenTestFiles: [
      file("test/hidden-slug.test.mjs", [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { slugify } from "../src/slug.mjs";',
        "",
        'test("normalizes punctuation and repeated separators", () => {',
        '  assert.equal(slugify(" A/B testing -- Plan "), "a-b-testing-plan");',
        '  assert.equal(slugify("Already---Dashed"), "already-dashed");',
        "});",
      ]),
    ],
    testCommand: ["node", "--test"],
    expectedTouchedFiles: ["src/slug.mjs"],
    forbiddenPatchTerms: ["preserve spaces", "display slug", "global mutex"],
    forbiddenOutputTerms: ["preserve spaces", "display slug", "global mutex"],
    distractors: [
      {
        sessionID: "display_slug_session",
        title: "Display slug preservation note",
        messages: [
          {
            id: "display_slug_fact_1",
            text: "For a marketing preview widget, preserve spaces and punctuation in display slugs because the renderer consumes raw headings.",
          },
          {
            id: "display_slug_fact_2",
            text: "That display-only note was not about the repository slugify helper used by tests.",
          },
        ],
      },
      {
        sessionID: "auth_mutex_distractor",
        title: "Auth mutex distractor",
        messages: [
          {
            id: "auth_mutex_fact_1",
            text: "An auth refresh queue once considered a global mutex. This is unrelated to slug normalization.",
          },
        ],
      },
    ],
  },
  {
    id: "memory-helpful-schema",
    title: "Memory helpful schema parser",
    memoryRole: "helpful",
    task: [
      "Fix parseSchemaHeader so it matches the prior accepted schema parsing decision.",
      "Visible tests cover the common case, but the important edge case comes from prior work.",
      "If prior session memory is available, use it as evidence for the intended behavior.",
    ].join("\n"),
    sourceFiles: [
      file("package.json", [
        "{",
        '  "type": "module",',
        '  "scripts": { "test": "node --test" }',
        "}",
      ]),
      file("src/schema-header.mjs", [
        "export function parseSchemaHeader(line) {",
        "  return String(line)",
        "    .trim()",
        "    .split('|')",
        "    .map((field) => field.trim())",
        "    .filter(Boolean);",
        "}",
      ]),
    ],
    publicTestFiles: [
      file("test/schema-header.test.mjs", [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { parseSchemaHeader } from "../src/schema-header.mjs";',
        "",
        'test("trims simple schema fields", () => {',
        '  assert.deepEqual(parseSchemaHeader(" name | age | email "), [',
        '    "name",',
        '    "age",',
        '    "email",',
        "  ]);",
        "});",
      ]),
    ],
    hiddenTestFiles: [
      file("test/hidden-schema-header.test.mjs", [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { parseSchemaHeader } from "../src/schema-header.mjs";',
        "",
        'test("keeps pipes inside quoted schema fields", () => {',
        '  assert.deepEqual(parseSchemaHeader("name | \\"display|label\\" | age"), [',
        '    "name",',
        '    "\\\"display|label\\\"",',
        '    "age",',
        "  ]);",
        '  assert.deepEqual(parseSchemaHeader(" id | \\"quoted | field\\" | done "), [',
        '    "id",',
        '    "\\\"quoted | field\\\"",',
        '    "done",',
        "  ]);",
        "});",
      ]),
    ],
    testCommand: ["node", "--test"],
    expectedTouchedFiles: ["src/schema-header.mjs"],
    forbiddenPatchTerms: ["comma-specific", "global mutex", "billing queue"],
    forbiddenOutputTerms: ["global mutex", "billing queue"],
    relevant: {
      sessionID: "schema_quote_decision_session",
      title: "Schema parser accepted quote handling decision",
      messages: [
        {
          id: "schema_quote_fact_1",
          supportsTask: true,
          text: "Accepted schema parser decision: split on pipe delimiters only when the pipe is outside double quotes, then trim each resulting field.",
        },
        {
          id: "schema_quote_fact_2",
          supportsTask: true,
          text: "Do not trim the whole header before tokenization because quoted delimiter boundaries must be preserved.",
        },
      ],
    },
    distractors: [
      {
        sessionID: "csv_parser_distractor",
        title: "CSV parser comma cleanup",
        messages: [
          {
            id: "csv_parser_fact_1",
            text: "CSV parser cleanup split comma-separated fields and trimmed each field. This comma-specific parser was not the schema pipe parser decision.",
          },
        ],
      },
      {
        sessionID: "network_header_distractor",
        title: "Network header whitespace cleanup",
        messages: [
          {
            id: "network_header_fact_1",
            text: "Network headers were lowercased before tokenization. That behavior is unrelated to schema quoted-pipe parsing.",
          },
        ],
      },
    ],
  },
  {
    id: "memory-harmful-refresh",
    title: "Memory harmful refresh queue",
    memoryRole: "harmful",
    task: [
      "Fix enqueueRefresh so same-tenant refresh calls coalesce while different tenants can refresh independently.",
      "Current repo tests and this issue statement are authoritative.",
      "Prior session memory, if available, may include stale guidance from other queue designs and must not override the current task.",
    ].join("\n"),
    sourceFiles: [
      file("package.json", [
        "{",
        '  "type": "module",',
        '  "scripts": { "test": "node --test" }',
        "}",
      ]),
      file("src/refresh-queue.mjs", [
        "let inflight;",
        "",
        "export function enqueueRefresh(tenantID, refresh) {",
        "  if (inflight) return inflight;",
        "  inflight = Promise.resolve()",
        "    .then(() => refresh(tenantID))",
        "    .finally(() => {",
        "      inflight = undefined;",
        "    });",
        "  return inflight;",
        "}",
        "",
        "export function resetQueueForTests() {",
        "  inflight = undefined;",
        "}",
      ]),
    ],
    publicTestFiles: [
      file("test/refresh-queue.test.mjs", [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { enqueueRefresh, resetQueueForTests } from "../src/refresh-queue.mjs";',
        "",
        'test("same tenant refresh calls coalesce", async () => {',
        "  resetQueueForTests();",
        "  let calls = 0;",
        "  const refresh = async () => {",
        "    calls += 1;",
        "    await new Promise((resolve) => setTimeout(resolve, 5));",
        "    return `token-${calls}`;",
        "  };",
        '  const [a, b] = await Promise.all([enqueueRefresh("tenant-a", refresh), enqueueRefresh("tenant-a", refresh)]);',
        "  assert.equal(calls, 1);",
        "  assert.equal(a, b);",
        "});",
      ]),
    ],
    hiddenTestFiles: [
      file("test/hidden-refresh-queue.test.mjs", [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { enqueueRefresh, resetQueueForTests } from "../src/refresh-queue.mjs";',
        "",
        'test("different tenants refresh independently", async () => {',
        "  resetQueueForTests();",
        "  const events = [];",
        "  const refreshFor = (tenant) =>",
        "    enqueueRefresh(tenant, async () => {",
        "      events.push(`start-${tenant}`);",
        "      await new Promise((resolve) => setTimeout(resolve, 15));",
        "      events.push(`end-${tenant}`);",
        "      return `token-${tenant}`;",
        "    });",
        '  const [a, b] = await Promise.all([refreshFor("tenant-a"), refreshFor("tenant-b")]);',
        '  assert.equal(a, "token-tenant-a");',
        '  assert.equal(b, "token-tenant-b");',
        '  assert.deepEqual(events.slice(0, 2).sort(), ["start-tenant-a", "start-tenant-b"]);',
        "});",
      ]),
    ],
    testCommand: ["node", "--test"],
    expectedTouchedFiles: ["src/refresh-queue.mjs"],
    forbiddenPatchTerms: [
      "global mutex",
      "serialize all tenants",
      "billing queue",
    ],
    forbiddenOutputTerms: [
      "global mutex",
      "serialize all tenants",
      "billing queue",
    ],
    distractors: [
      {
        sessionID: "billing_global_mutex_session",
        title: "Billing queue global mutex decision",
        messages: [
          {
            id: "billing_mutex_fact_1",
            text: "Billing retry queues used a global mutex because provider limits required serializing all tenants.",
          },
          {
            id: "billing_mutex_fact_2",
            text: "Do not copy this billing retry design into auth refresh queues unless the current task explicitly asks for billing provider serialization.",
          },
        ],
      },
      {
        sessionID: "auth_rollback_stale_session",
        title: "Stale auth rollback note",
        messages: [
          {
            id: "auth_rollback_fact_1",
            text: "Stale rollback note: temporarily route all auth refresh work through one global mutex during incident mitigation.",
          },
        ],
      },
    ],
  },
  {
    id: "memory-missing-pagination",
    title: "Memory missing pagination fix",
    memoryRole: "missing",
    task: [
      "Fix totalPages so the local pagination tests pass.",
      "Prior session memory, if available, may mention nearby pagination systems but does not contain the answer for this helper.",
      "Do not invent prior-session evidence when the current repository and tests are sufficient.",
    ].join("\n"),
    sourceFiles: [
      file("package.json", [
        "{",
        '  "type": "module",',
        '  "scripts": { "test": "node --test" }',
        "}",
      ]),
      file("src/pagination.mjs", [
        "export function totalPages(totalItems, pageSize) {",
        "  if (pageSize <= 0) return 0;",
        "  return Math.floor(totalItems / pageSize);",
        "}",
      ]),
    ],
    publicTestFiles: [
      file("test/pagination.test.mjs", [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { totalPages } from "../src/pagination.mjs";',
        "",
        'test("counts full and partial pages", () => {',
        "  assert.equal(totalPages(20, 10), 2);",
        "  assert.equal(totalPages(1, 10), 1);",
        "});",
      ]),
    ],
    hiddenTestFiles: [
      file("test/hidden-pagination.test.mjs", [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { totalPages } from "../src/pagination.mjs";',
        "",
        'test("rounds up without inventing pages", () => {',
        "  assert.equal(totalPages(21, 10), 3);",
        "  assert.equal(totalPages(0, 10), 0);",
        "  assert.equal(totalPages(5, 0), 0);",
        "});",
      ]),
    ],
    testCommand: ["node", "--test"],
    expectedTouchedFiles: ["src/pagination.mjs"],
    forbiddenPatchTerms: ["graphql", "opaque token"],
    forbiddenOutputTerms: ["graphql", "opaque token"],
    distractors: [
      {
        sessionID: "token_pagination_session",
        title: "Token pagination API note",
        messages: [
          {
            id: "token_pagination_fact_1",
            text: "Token pagination uses opaque tokens and intentionally avoids total page counts for streaming APIs.",
          },
        ],
      },
      {
        sessionID: "graphql_page_info_session",
        title: "GraphQL pageInfo note",
        messages: [
          {
            id: "graphql_page_fact_1",
            text: "GraphQL pageInfo exposes hasNextPage instead of total pages. This prior note does not apply to the numeric helper.",
          },
        ],
      },
    ],
  },
  {
    id: "memory-correction-retry-cap",
    title: "Memory temporal correction retry cap",
    memoryRole: "correction",
    task: [
      "Fix retryDelayMs so it matches the latest accepted retry-delay decision.",
      "Visible tests cover the basic exponential schedule, but the cap comes from prior work.",
      "If prior memory is available, use the latest correction rather than stale earlier notes.",
    ].join("\n"),
    sourceFiles: [
      file("package.json", [
        "{",
        '  "type": "module",',
        '  "scripts": { "test": "node --test" }',
        "}",
      ]),
      file("src/retry-delay.mjs", [
        "export function retryDelayMs(attempt) {",
        "  return Math.min(5000, 100 * 2 ** attempt);",
        "}",
      ]),
    ],
    publicTestFiles: [
      file("test/retry-delay.test.mjs", [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { retryDelayMs } from "../src/retry-delay.mjs";',
        "",
        'test("uses exponential base delay", () => {',
        "  assert.equal(retryDelayMs(0), 100);",
        "  assert.equal(retryDelayMs(1), 200);",
        "  assert.equal(retryDelayMs(3), 800);",
        "});",
      ]),
    ],
    hiddenTestFiles: [
      file("test/hidden-retry-delay.test.mjs", [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { retryDelayMs } from "../src/retry-delay.mjs";',
        "",
        'test("uses the latest accepted cap", () => {',
        "  assert.equal(retryDelayMs(5), 2000);",
        "  assert.equal(retryDelayMs(10), 2000);",
        "});",
      ]),
    ],
    testCommand: ["node", "--test"],
    expectedTouchedFiles: ["src/retry-delay.mjs"],
    forbiddenPatchTerms: ["five second", "5 second"],
    forbiddenOutputTerms: ["five second", "5 second"],
    relevant: {
      sessionID: "retry_delay_latest_correction_session",
      title: "Retry delay latest correction",
      messages: [
        {
          id: "retry_correction_fact_1",
          text: "Earlier retry-delay notes used a 5000ms cap, but that was superseded after mobile clients hit long backoff stalls.",
        },
        {
          id: "retry_correction_fact_2",
          supportsTask: true,
          text: "Latest accepted decision: cap retryDelayMs at 2000ms while keeping the 100ms exponential base.",
        },
      ],
    },
    distractors: [
      {
        sessionID: "retry_delay_stale_session",
        title: "Stale retry delay note",
        messages: [
          {
            id: "retry_stale_fact_1",
            text: "Stale earlier note: cap retry delays at 5000ms for batch workers.",
          },
        ],
      },
      {
        sessionID: "cache_ttl_distractor_session",
        title: "Cache TTL cap distractor",
        messages: [
          {
            id: "ttl_distractor_fact_1",
            text: "Cache TTLs use namespace-specific caps. This is unrelated to retryDelayMs.",
          },
        ],
      },
    ],
  },
  {
    id: "memory-synthesis-report",
    title: "Memory synthesis report fields",
    memoryRole: "synthesis",
    task: [
      "Fix buildReport so it matches the accepted parent synthesis of prior child-agent findings.",
      "Visible tests only cover the summary field; hidden tests require preserving the prior synthesized fields.",
      "If prior memory is available, cite the accepted synthesis rather than distractor style or docs requests.",
    ].join("\n"),
    sourceFiles: [
      file("package.json", [
        "{",
        '  "type": "module",',
        '  "scripts": { "test": "node --test" }',
        "}",
      ]),
      file("src/report.mjs", [
        "export function buildReport(input) {",
        "  return {",
        "    summary: input.summary,",
        "  };",
        "}",
      ]),
    ],
    publicTestFiles: [
      file("test/report.test.mjs", [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { buildReport } from "../src/report.mjs";',
        "",
        'test("keeps report summary", () => {',
        '  assert.deepEqual(buildReport({ summary: "failed smoke run" }), {',
        '    summary: "failed smoke run",',
        "  });",
        "});",
      ]),
    ],
    hiddenTestFiles: [
      file("test/hidden-report.test.mjs", [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { buildReport } from "../src/report.mjs";',
        "",
        'test("keeps synthesized child-agent fields", () => {',
        "  assert.deepEqual(",
        "    buildReport({",
        '      summary: "failed smoke run",',
        '      failedTestIDs: ["auth-smoke", "retry-smoke"],',
        '      retryOwner: "infra-oncall",',
        "    }),",
        "    {",
        '      summary: "failed smoke run",',
        '      failed_test_ids: ["auth-smoke", "retry-smoke"],',
        '      retry_owner: "infra-oncall",',
        "    },",
        "  );",
        "});",
      ]),
    ],
    testCommand: ["node", "--test"],
    expectedTouchedFiles: ["src/report.mjs"],
    forbiddenPatchTerms: ["docs writer", "style reviewer", "alphabetized"],
    forbiddenOutputTerms: ["docs writer", "style reviewer", "alphabetized"],
    relevant: {
      sessionID: "report_parent_synthesis_session",
      title: "Parent synthesis of child report findings",
      messages: [
        {
          id: "report_synthesis_fact_1",
          supportsTask: true,
          text: "The parent accepted the test-investigator child finding: keep failed_test_ids in final reports so later agents can reproduce exact failures.",
        },
        {
          id: "report_synthesis_fact_2",
          supportsTask: true,
          text: "The parent also accepted the infra child finding: keep retry_owner so follow-up retries route to the responsible on-call team.",
        },
      ],
    },
    distractors: [
      {
        sessionID: "report_docs_writer_session",
        title: "Docs writer child report request",
        messages: [
          {
            id: "docs_writer_fact_1",
            text: "The docs writer child requested shorter prose and no debugging identifiers in public release notes.",
          },
        ],
      },
      {
        sessionID: "report_style_reviewer_session",
        title: "Style reviewer child report request",
        messages: [
          {
            id: "style_reviewer_fact_1",
            text: "The style reviewer child wanted output fields alphabetized. This was not the accepted report-field rationale.",
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
  if (options.combineRuns) {
    await fs.mkdir(options.outDir, { recursive: true });
    const analysis = await combineRuns(options.outDir, options.combineRuns);
    await writeAnalysisFiles(options.outDir, analysis);
    console.log(renderAnalysisMarkdown(analysis));
    return;
  }

  await fs.mkdir(options.outDir, { recursive: true });
  await fs.writeFile(
    path.join(options.outDir, "config.json"),
    `${JSON.stringify(options, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(options.outDir, "fixtures.json"),
    `${JSON.stringify(
      fixtures.map((fixture) => ({
        id: fixture.id,
        title: fixture.title,
        memoryRole: fixture.memoryRole,
        task: fixture.task,
      })),
      null,
      2,
    )}\n`,
  );
  if (options.prepareOnly) {
    await writeSummary(options.outDir, [], options);
    console.log(`Prepared code-memory benchmark at ${options.outDir}`);
    return;
  }

  const selectedFixtures = fixtures.filter((fixture) =>
    options.fixtures.includes(fixture.id),
  );
  const tasks: Array<{
    fixture: CodeFixture;
    condition: ConditionID;
    repeat?: number;
  }> = [];
  for (const fixture of selectedFixtures) {
    for (const condition of options.conditions) {
      for (let repeat = 1; repeat <= options.repeats; repeat++) {
        tasks.push({
          fixture,
          condition,
          repeat: options.repeats > 1 ? repeat : undefined,
        });
      }
    }
  }

  const results: Array<{
    fixture: string;
    condition: ConditionID;
    repeat?: number;
    statsPath: string;
    pass?: boolean;
    error?: string;
  }> = [];

  let nextTask = 0;
  const totalTasks = tasks.length;
  const workerCount = Math.min(options.workers, totalTasks);

  const worker = async () => {
    while (true) {
      const index = nextTask++;
      if (index >= tasks.length) return;
      const task = tasks[index];
      const result = await runFixtureCondition(
        task.fixture,
        task.condition,
        options,
        task.repeat,
      );
      results.push(result);
      console.log(
        `Finished ${results.length}/${totalTasks}: ${task.fixture.id}/${task.condition}`,
      );
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  await writeSummary(options.outDir, results, options);
  const analysis = await analyzeRun(options.outDir);
  await writeAnalysisFiles(options.outDir, analysis);
  console.log(renderAnalysisMarkdown(analysis));
  console.log(`Code-memory benchmark artifacts written to ${options.outDir}`);
}

async function runFixtureCondition(
  fixture: CodeFixture,
  condition: ConditionID,
  options: Options,
  repeat?: number,
) {
  const baseConditionDir = path.join(
    options.outDir,
    "fixtures",
    fixture.id,
    "conditions",
    condition,
  );
  const conditionDir = repeat
    ? path.join(baseConditionDir, `repeat-${String(repeat).padStart(2, "0")}`)
    : baseConditionDir;
  const worktree = path.join(conditionDir, "worktree");
  const statsPath = path.join(conditionDir, "stats.json");
  await fs.mkdir(conditionDir, { recursive: true });
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const startedAt = Date.now();
  try {
    await prepareFixtureRepo(worktree, fixture, {
      includeTranscripts: condition === "rlm-transcript-search",
    });
    const opencodeRoot = resolveOpenCodeRoot(conditionDir);
    const env = await buildOpenCodeEnv({
      opencodeRoot,
      conditionDir,
      modelSlug: options.modelSlug,
      plugin: usesMemMould(condition),
    });
    server = await startServer(env, worktree);
    const client = createOpencodeClient({ baseUrl: server.url });
    await pickModel(client, worktree, options.modelSlug);

    const seeded = usesMemMould(condition)
      ? await seedHistoricalSessions(
          client,
          worktree,
          fixture,
          options.promptTimeoutMs,
        )
      : staticSeededSessions(fixture);
    if (condition === "memmould-guided-rlm") {
      await writeHybridTranscriptCorpus(client, worktree, fixture, seeded);
    }

    const sessionID = await createSession(
      client,
      worktree,
      `${fixture.id} ${condition}`,
    );
    const llmLogDir = path.join(opencodeRoot.data, "opencode", "log");
    await prompt(
      client,
      worktree,
      sessionID,
      buildSolvePrompt(fixture, condition, worktree),
      buildSystemPrompt(condition),
      undefined,
      options.promptTimeoutMs,
      llmLogDir,
    );
    const messages = await listSessionMessages(client, worktree, sessionID);
    await fs.writeFile(
      path.join(conditionDir, "messages.json"),
      `${JSON.stringify(messages, null, 2)}\n`,
    );
    await copyContextMaps(opencodeRoot.home, conditionDir);

    const patch = await gitDiff(worktree);
    await fs.writeFile(path.join(conditionDir, "patch.diff"), patch);
    const touched = touchedFiles(patch);
    const publicTest = await runTestCommand(worktree, fixture.testCommand);
    await writeHiddenTests(worktree, fixture);
    const hiddenTest = await runTestCommand(worktree, fixture.testCommand);
    await fs.writeFile(
      path.join(conditionDir, "public-test.json"),
      `${JSON.stringify(publicTest, null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(conditionDir, "hidden-test.json"),
      `${JSON.stringify(hiddenTest, null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(conditionDir, "seeded-sessions.json"),
      `${JSON.stringify(seeded, null, 2)}\n`,
    );

    const stats = buildStats({
      fixture,
      condition,
      seeded,
      messages,
      patch,
      touched,
      publicTest,
      hiddenTest,
      startedAt,
      repeat,
    });
    await fs.writeFile(statsPath, `${JSON.stringify(stats, null, 2)}\n`);
    return {
      fixture: fixture.id,
      condition,
      statsPath,
      pass: stats.benchmark_passed,
      repeat,
    };
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    await fs.writeFile(
      statsPath,
      `${JSON.stringify(failedStats(fixture, condition, startedAt, message, repeat), null, 2)}\n`,
    );
    return {
      fixture: fixture.id,
      condition,
      statsPath,
      error: message,
      repeat,
    };
  } finally {
    await server?.close();
  }
}

function usesMemMould(condition: ConditionID) {
  return condition === "memmould-only" || condition === "memmould-guided-rlm";
}

function parseOptions(): Options {
  const args = process.argv.slice(2);
  const fixtureArg = valueArg(args, "--fixtures");
  const conditionArg = valueArg(args, "--conditions");
  const modelArg = valueArg(args, "--model");
  const timeoutMinutes = Number(
    valueArg(args, "--prompt-timeout-minutes") ?? "12",
  );
  const repeats = Number(valueArg(args, "--repeats") ?? "1");
  const workers = Number(
    valueArg(args, "--workers") ??
      process.env.MEM_MOULD_E2E_WORKERS ??
      `${defaultWorkerCount()}`,
  );
  const combineArg = valueArg(args, "--combine-runs");
  assert.ok(Number.isInteger(repeats) && repeats > 0);
  assert.ok(Number.isInteger(workers) && workers > 0);
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
    modelSlug: requiredModelSlug(modelArg, { cliFlag: "--model" }),
    promptTimeoutMs: timeoutMinutes * 60_000,
    repeats,
    workers,
    prepareOnly: hasArg(args, "--prepare-only"),
    analyzeRun: analyzeRun ? path.resolve(analyzeRun) : undefined,
    combineRuns: combineArg
      ? splitList(combineArg).map((item) => path.resolve(item))
      : undefined,
  };
}

function defaultWorkerCount() {
  const cpus = os.availableParallelism
    ? os.availableParallelism()
    : (os.cpus() ?? []).length;
  return Math.max(1, Math.min(cpus, 8));
}

async function prepareFixtureRepo(
  worktree: string,
  fixture: CodeFixture,
  options: { includeTranscripts: boolean },
) {
  await fs.rm(worktree, { recursive: true, force: true });
  for (const item of [...fixture.sourceFiles, ...fixture.publicTestFiles]) {
    await writeWorktreeFile(worktree, item);
  }
  if (options.includeTranscripts)
    await writeTranscriptCorpus(worktree, fixture);
  await execFileAsync("git", ["init"], { cwd: worktree });
  await execFileAsync("git", ["add", "."], { cwd: worktree });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Code Memory Benchmark",
      "-c",
      "user.email=code-memory@example.com",
      "commit",
      "-m",
      `seed ${fixture.id}`,
    ],
    { cwd: worktree },
  );
}

async function writeHiddenTests(worktree: string, fixture: CodeFixture) {
  for (const item of fixture.hiddenTestFiles)
    await writeWorktreeFile(worktree, item);
}

async function writeWorktreeFile(worktree: string, item: CodeFile) {
  const filePath = path.join(worktree, item.file);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${item.lines.join("\n")}\n`);
}

async function writeTranscriptCorpus(worktree: string, fixture: CodeFixture) {
  const sessions = allStaticSessions(fixture);
  const dir = path.join(worktree, "memory", "transcripts");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(worktree, "memory", "manifest.json"),
    `${JSON.stringify(
      {
        fixture: fixture.id,
        memory_role: fixture.memoryRole,
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

async function writeHybridTranscriptCorpus(
  client: ReturnType<typeof createOpencodeClient>,
  worktree: string,
  fixture: CodeFixture,
  seeded: SeededSessions,
) {
  const dir = path.join(worktree, "memory", "transcripts");
  await fs.mkdir(dir, { recursive: true });
  const entries: Array<{
    session_id: string;
    title: string;
    file: string;
    role: string;
  }> = [];
  const sourceSessions = [
    ...(fixture.relevant
      ? [{ source: fixture.relevant, role: "relevant" }]
      : []),
    ...fixture.distractors.map((source) => ({ source, role: "distractor" })),
  ];
  for (const item of seeded.sessions) {
    const match = sourceSessions.find(
      ({ role, source }) => role === item.role && source.title === item.title,
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
      session_id: item.id,
      title: item.title,
      file: fileName,
      role: item.role,
    });
    await fs.writeFile(
      path.join(dir, fileName),
      hybridTranscriptMarkdown({
        sessionID: item.id,
        title: item.title,
        messageID,
        messages: match.source.messages,
      }),
    );
  }
  for (const session of generatedDecoys(fixture)) {
    const fileName = `${session.sessionID}.md`;
    entries.push({
      session_id: session.sessionID,
      title: session.title,
      file: fileName,
      role: "decoy",
    });
    await fs.writeFile(path.join(dir, fileName), transcriptMarkdown(session));
  }
  await fs.writeFile(
    path.join(worktree, "memory", "manifest.json"),
    `${JSON.stringify(
      {
        fixture: fixture.id,
        memory_role: fixture.memoryRole,
        transcript_dir: "memory/transcripts",
        id_policy:
          "Hybrid transcript files use real OpenCode session_id and heading message_id values for seeded sessions. Cite those real ids, not fixture labels.",
        sessions: entries,
      },
      null,
      2,
    )}\n`,
  );
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

function allStaticSessions(fixture: CodeFixture) {
  return [
    ...(fixture.relevant ? [fixture.relevant] : []),
    ...fixture.distractors,
    ...generatedDecoys(fixture),
  ];
}

function generatedDecoys(fixture: CodeFixture): HistoricalSession[] {
  return Array.from({ length: 4 }, (_, index) => ({
    sessionID: `${fixture.id}_decoy_${index + 1}`.replaceAll("-", "_"),
    title: `${fixture.title} decoy ${index + 1}`,
    messages: [
      {
        id: `decoy_fact_${index + 1}`,
        text: `Decoy ${index + 1}: mentions ${fixture.expectedTouchedFiles[0] ?? "the target file"} but does not contain the accepted fix for this task.`,
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

async function seedHistoricalSessions(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  fixture: CodeFixture,
  timeoutMs: number,
): Promise<SeededSessions> {
  const sessions: SeededSessions["sessions"] = [];
  let relevantSessionID: string | undefined;
  let relevantMessageIDs: string[] = [];
  if (fixture.relevant) {
    relevantSessionID = await createSession(
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
    sessions.push({
      id: relevantSessionID,
      title: fixture.relevant.title,
      role: "relevant",
    });
    relevantMessageIDs = (
      await listSessionMessages(client, directory, relevantSessionID)
    )
      .map((message) => message.info?.id)
      .filter((id): id is string => Boolean(id));
  }
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
  return { relevantSessionID, relevantMessageIDs, sessions };
}

function staticSeededSessions(fixture: CodeFixture): SeededSessions {
  return {
    relevantSessionID: fixture.relevant?.sessionID,
    relevantMessageIDs:
      fixture.relevant?.messages
        .filter((message) => message.supportsTask)
        .map((message) => message.id) ?? [],
    sessions: [
      ...(fixture.relevant
        ? [
            {
              id: fixture.relevant.sessionID,
              title: fixture.relevant.title,
              role: "relevant" as const,
            },
          ]
        : []),
      ...fixture.distractors.map((item) => ({
        id: item.sessionID,
        title: item.title,
        role: "distractor" as const,
      })),
    ],
  };
}

function seedSystemPrompt() {
  return "Preserve this prior coding-session record for a code-memory benchmark. Do not edit files or call tools. Acknowledge concisely while retaining important implementation decisions.";
}

function buildSystemPrompt(condition: ConditionID) {
  const base =
    "You are solving a code-memory benchmark. Edit source files as needed, run focused tests if useful, and do not commit changes. Do not edit files under test/. Current repository files and tests are authoritative.";
  if (condition === "code-only") {
    return `${base} No prior session memory is available in this condition.`;
  }
  if (condition === "rlm-transcript-search") {
    return `${base} Prior transcript files may be useful, irrelevant, or stale. Use RLM-style transcript search with glob/grep/read and optional read-only bash only when it helps the coding task. Do not use mem-mould session tools.`;
  }
  if (condition === "memmould-only") {
    return `${base} Prior session maps may be useful, irrelevant, or stale. Use mem-mould session tools when prior memory may affect the fix. No transcript corpus is available; do not use transcript-file search as memory.`;
  }
  return `${base} Prior session maps and transcript files may be useful, irrelevant, or stale. Use mem-mould tools as a routing layer when memory may matter; current tests/spec override stale prior memory. If you corroborate with bash, use it read-only except for running tests.`;
}

function buildSolvePrompt(
  fixture: CodeFixture,
  condition: ConditionID,
  worktree: string,
) {
  const transcriptDir = path.join(worktree, "memory", "transcripts");
  const memoryInstruction =
    condition === "code-only"
      ? "No prior memory corpus is available. Solve from the repository and tests only."
      : condition === "rlm-transcript-search"
        ? `Optional transcript corpus: ${transcriptDir}. Prior memory may be useful, irrelevant, or stale. Search only if it helps; if it is irrelevant or stale, ignore it.`
        : condition === "memmould-only"
          ? [
              "No transcript corpus is available in this condition.",
              "Use session_lookup/session_detail/message_detail when a prior session may affect the fix.",
              "If memory is irrelevant, avoid pulling it into the patch. If memory is stale, explicitly reject it.",
            ].join("\n")
          : [
              `Optional transcript corpus: ${transcriptDir}.`,
              "Use session_lookup/session_detail/message_detail when a prior session may affect the fix.",
              "If memory is irrelevant, avoid pulling it into the patch. If memory is stale, explicitly reject it.",
            ].join("\n");
  return [
    `Task: ${fixture.title}`,
    "",
    fixture.task,
    "",
    memoryInstruction,
    "",
    "After editing, respond with compact JSON only:",
    '{"summary":"...","tests":"...","memory_decision":"used|ignored|rejected|abstained|unavailable","evidence":{"session_id":"","message_id":""}}',
    "If you used a prior session, cite the exact session_id and message_id. If memory was irrelevant, stale, or unavailable, leave evidence fields empty and explain the decision briefly.",
  ].join("\n");
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
  llmLogDir?: string,
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
    llmLogDir,
  );
}

async function waitForAssistantMessage(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  sessionID: string,
  beforeIDs: Set<string | undefined>,
  timeoutMs: number,
  llmLogDir?: string,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const messages = await listSessionMessages(client, directory, sessionID);
    const reversed = [...messages].reverse();
    const asMessageRecord = (message: SessionMessage) =>
      message as Record<string, unknown> & { info?: Record<string, unknown> };
    const assistantRole = (message: SessionMessage) =>
      asMessageRecord(message).info?.role ??
      asMessageRecord(message).role ??
      "";
    const assistantError = (message: SessionMessage) => {
      const asRecord = asMessageRecord(message);
      const info = asRecord.info;
      return info?.error ?? asRecord.error;
    };
    const assistantFinish = (message: SessionMessage) => {
      const asRecord = asMessageRecord(message);
      return asRecord.info?.finish ?? asRecord.finish ?? null;
    };
    const assistantID = (message: SessionMessage) => {
      const asRecord = asMessageRecord(message);
      return (asRecord.info?.id ?? asRecord.id) as string | undefined;
    };
    const assistant = reversed.find(
      (message) =>
        assistantRole(message) === "assistant" &&
        !beforeIDs.has(assistantID(message)) &&
        assistantError(message),
    );
    if (assistant) {
      const error = assistantError(assistant);
      const text =
        typeof error === "string" ? error : JSON.stringify(error ?? "");
      throw new Error(`assistant error in ${sessionID}: ${text}`);
    }
    const completed = reversed.find(
      (message) =>
        assistantRole(message) === "assistant" &&
        !beforeIDs.has(assistantID(message)) &&
        assistantFinish(message) &&
        assistantFinish(message) !== "tool-calls",
    );
    if (completed) return completed;

    if (llmLogDir) {
      const llmError = await latestLlmErrorForSession(llmLogDir, sessionID);
      if (llmError) {
        throw new Error(`llm error in ${sessionID}: ${llmError}`);
      }
    }
  }
  throw new Error(`timed out waiting for assistant message in ${sessionID}`);
}

async function latestLlmErrorForSession(logDir: string, sessionID: string) {
  const entries = (await fs
    .readdir(logDir)
    .catch(() => [] as Array<string>)) as string[];
  if (entries.length === 0) return undefined;

  const files = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".log"))
      .map(async (entry) => {
        const file = path.join(logDir, entry);
        const stat = await fs.stat(file).catch(() => undefined);
        return stat?.isFile() ? { file, mtimeMs: stat.mtimeMs } : undefined;
      }),
  );

  const sorted = files
    .filter((file): file is { file: string; mtimeMs: number } => Boolean(file))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  let latestSummary: string | undefined;
  for (const file of sorted) {
    const content = await fs.readFile(file.file, "utf8").catch(() => undefined);
    if (!content) continue;
    for (const line of content.split("\n")) {
      if (!line.includes(`session.id=${sessionID}`)) continue;
      if (!line.includes("service=llm")) continue;
      if (!line.includes(" error=")) continue;
      const summary = summarizeLlmErrorFromLogLine(line);
      if (summary) latestSummary = summary;
    }
  }

  return latestSummary;
}

function summarizeLlmErrorFromLogLine(line: string) {
  const marker = line.indexOf(" error=");
  if (marker < 0) return undefined;
  let payload = line.slice(marker + " error=".length).trim();
  const streamSuffix = " stream error";
  if (payload.endsWith(streamSuffix)) {
    payload = payload.slice(0, -streamSuffix.length);
  }

  try {
    const parsed = JSON.parse(payload) as {
      error?: {
        name?: string;
        message?: string;
        status?: unknown;
        responseBody?: string;
        type?: string;
      };
    };
    if (!parsed || typeof parsed !== "object" || !parsed.error)
      return payload.slice(0, 800);
    const error = parsed.error;
    const topMessage =
      typeof error.message === "string" ? error.message : undefined;
    const response =
      typeof error.responseBody === "string"
        ? (() => {
            try {
              const nested = JSON.parse(error.responseBody) as {
                error?: {
                  type?: string;
                  message?: string;
                  resets_in_seconds?: number;
                };
              };
              const nestedType = nested.error?.type;
              const nestedMessage = nested.error?.message;
              if (!nestedType && !nestedMessage) return undefined;
              const resetSeconds = nested.error?.resets_in_seconds;
              const suffix =
                typeof resetSeconds === "number"
                  ? ` (resets in ${String(resetSeconds)}s)`
                  : "";
              return nestedType && nestedMessage
                ? `${nestedType}: ${nestedMessage}${suffix}`
                : `${nestedType || nestedMessage}${suffix}`;
            } catch {
              return undefined;
            }
          })()
        : undefined;
    const parts: string[] = [];
    if (error.name) parts.push(`name=${error.name}`);
    if (error.type) parts.push(`type=${error.type}`);
    if (typeof error.status !== "undefined")
      parts.push(`status=${String(error.status)}`);
    if (topMessage) parts.push(`message=${topMessage}`);
    if (response) parts.push(`response=${response}`);
    return parts.join("; ");
  } catch {
    return payload.slice(0, 400);
  }
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
      new Promise<never>(
        (_, reject) =>
          (timeout = setTimeout(() => reject(new Error(message)), timeoutMs)),
      ),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function gitDiff(worktree: string) {
  const { stdout } = await execFileAsync("git", ["diff", "--binary"], {
    cwd: worktree,
    maxBuffer: 100 * 1024 * 1024,
  });
  return stdout;
}

async function runTestCommand(
  worktree: string,
  command: string[],
): Promise<TestResult> {
  const [fileName, ...args] = command;
  assert.ok(fileName, "test command must not be empty");
  try {
    const { stdout, stderr } = await execFileAsync(fileName, args, {
      cwd: worktree,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { passed: true, exitCode: 0, stdout, stderr };
  } catch (error) {
    const details = error as {
      code?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      stack?: string;
      message?: string;
    };
    return {
      passed: false,
      exitCode: typeof details.code === "number" ? details.code : null,
      stdout: bufferString(details.stdout),
      stderr: bufferString(details.stderr),
      error: details.stack ?? details.message ?? String(error),
    };
  }
}

async function copyContextMaps(home: string, conditionDir: string) {
  const mapsDir = path.join(home, ".opencode", "context-maps");
  const entries = await fs.readdir(mapsDir).catch(() => [] as string[]);
  if (entries.length === 0) return;
  const outDir = path.join(conditionDir, "context-maps");
  await fs.mkdir(outDir, { recursive: true });
  for (const entry of entries) {
    const source = path.join(mapsDir, entry);
    const dest = path.join(outDir, entry);
    const stat = await fs.stat(source).catch(() => undefined);
    if (stat?.isFile()) await fs.copyFile(source, dest);
  }
}

function buildStats(input: {
  fixture: CodeFixture;
  condition: ConditionID;
  seeded: SeededSessions;
  messages: SessionMessage[];
  patch: string;
  touched: string[];
  publicTest: TestResult;
  hiddenTest: TestResult;
  startedAt: number;
  repeat?: number;
}): RunStats {
  const outputText = messageText(latestAssistantMessage(input.messages));
  const tools = toolParts(input.messages);
  const toolNames = tools.map((part) => part.tool).filter(Boolean) as string[];
  const transcriptFilesRead = transcriptReadFiles(tools);
  const contextToolCount = toolNames.filter((tool) =>
    contextTools.has(tool),
  ).length;
  const searchToolCount = toolNames.filter((tool) =>
    ["glob", "grep"].includes(tool),
  ).length;
  const readToolCount = toolNames.filter((tool) => tool === "read").length;
  const bashToolCount = toolNames.filter((tool) => tool === "bash").length;
  const forbiddenPatchHits = termsInText(
    input.fixture.forbiddenPatchTerms,
    input.patch,
  );
  const forbiddenOutputHits = termsInText(
    input.fixture.forbiddenOutputTerms,
    outputText,
  );
  const irrelevantTranscriptReads = transcriptFilesRead.filter(
    (filePath) =>
      input.fixture.distractors.some((item) =>
        filePath.includes(item.sessionID),
      ) || /decoy/.test(filePath),
  );
  const expectedFilesTouched = input.fixture.expectedTouchedFiles.every(
    (filePath) => input.touched.includes(filePath),
  );
  const unexpectedTouchedFiles = input.touched.filter(
    (filePath) => !input.fixture.expectedTouchedFiles.includes(filePath),
  );
  const citationHits = citationMatches(outputText, input.seeded, input.fixture);
  const memoryPolicy = evaluateMemoryPolicy({
    fixture: input.fixture,
    condition: input.condition,
    outputText,
    toolNames,
    transcriptFilesRead,
    citationHits,
  });
  const toolPath = evaluateToolPath(input.condition, toolNames);
  const testsPassed = input.publicTest.passed && input.hiddenTest.passed;
  const benchmarkPassed =
    testsPassed &&
    expectedFilesTouched &&
    unexpectedTouchedFiles.length === 0 &&
    forbiddenPatchHits.length === 0 &&
    forbiddenOutputHits.length === 0 &&
    memoryPolicy.passed &&
    toolPath.passed;
  return {
    fixture: input.fixture.id,
    title: input.fixture.title,
    repeat: input.repeat,
    memory_role: input.fixture.memoryRole,
    condition: input.condition,
    benchmark_passed: benchmarkPassed,
    tests_passed: testsPassed,
    public_tests_passed: input.publicTest.passed,
    hidden_tests_passed: input.hiddenTest.passed,
    expected_files_touched: expectedFilesTouched,
    touched_files_allowed: unexpectedTouchedFiles.length === 0,
    memory_policy_passed: memoryPolicy.passed,
    tool_path_passed: toolPath.passed,
    tool_path_failures: [...toolPath.failures, ...memoryPolicy.failures],
    forbidden_patch_hits: forbiddenPatchHits,
    forbidden_output_hits: forbiddenOutputHits,
    touched_files: input.touched,
    unexpected_touched_files: unexpectedTouchedFiles,
    patch_bytes: Buffer.byteLength(input.patch),
    output_preview: outputText.slice(0, 1200),
    tool_names: toolNames,
    transcript_files_read: transcriptFilesRead,
    irrelevant_transcript_reads: irrelevantTranscriptReads,
    context_tool_call_count: contextToolCount,
    search_tool_call_count: searchToolCount,
    read_tool_call_count: readToolCount,
    bash_tool_call_count: bashToolCount,
    message_detail_call_count: toolNames.filter(
      (tool) => tool === "message_detail",
    ).length,
    memory_decision: memoryPolicy.decision,
    citation_hits: citationHits,
    relevant_session_id:
      input.seeded.relevantSessionID ?? input.fixture.relevant?.sessionID ?? "",
    relevant_message_ids: input.seeded.relevantMessageIDs,
    public_test: previewTestResult(input.publicTest),
    hidden_test: previewTestResult(input.hiddenTest),
    tokens: summarizeTokens(input.messages),
    models: modelIDs(input.messages),
    duration_ms: Date.now() - input.startedAt,
  };
}

function failedStats(
  fixture: CodeFixture,
  condition: ConditionID,
  startedAt: number,
  error: string,
  repeat?: number,
): RunStats {
  const emptyTest = {
    passed: false,
    exitCode: null,
    stdout: "",
    stderr: "",
    error,
  };
  return {
    fixture: fixture.id,
    title: fixture.title,
    repeat,
    memory_role: fixture.memoryRole,
    condition,
    benchmark_passed: false,
    tests_passed: false,
    public_tests_passed: false,
    hidden_tests_passed: false,
    expected_files_touched: false,
    touched_files_allowed: false,
    memory_policy_passed: false,
    tool_path_passed: false,
    tool_path_failures: ["run_error"],
    forbidden_patch_hits: [],
    forbidden_output_hits: [],
    touched_files: [],
    unexpected_touched_files: [],
    patch_bytes: 0,
    output_preview: error.slice(0, 1200),
    tool_names: [],
    transcript_files_read: [],
    irrelevant_transcript_reads: [],
    context_tool_call_count: 0,
    search_tool_call_count: 0,
    read_tool_call_count: 0,
    bash_tool_call_count: 0,
    message_detail_call_count: 0,
    memory_decision: "run_error",
    citation_hits: [],
    relevant_session_id: fixture.relevant?.sessionID ?? "",
    relevant_message_ids:
      fixture.relevant?.messages
        .filter((message) => message.supportsTask)
        .map((message) => message.id) ?? [],
    public_test: emptyTest,
    hidden_test: emptyTest,
    tokens: emptyTokenBucket(),
    models: [],
    duration_ms: Date.now() - startedAt,
    error,
  };
}

function evaluateToolPath(condition: ConditionID, toolNames: string[]) {
  const failures: string[] = [];
  const hasContext = toolNames.some((tool) => contextTools.has(tool));
  if (condition === "code-only" && hasContext)
    failures.push("context_tool_used");
  if (condition === "rlm-transcript-search" && hasContext)
    failures.push("context_tool_used");
  if (condition === "memmould-only" && toolNames.includes("task"))
    failures.push("task_tool_used");
  return { passed: failures.length === 0, failures };
}

function evaluateMemoryPolicy(input: {
  fixture: CodeFixture;
  condition: ConditionID;
  outputText: string;
  toolNames: string[];
  transcriptFilesRead: string[];
  citationHits: string[];
}) {
  const failures: string[] = [];
  const parsed = parseAnswer(input.outputText);
  const decision =
    typeof parsed?.memory_decision === "string"
      ? parsed.memory_decision
      : inferMemoryDecision(input.outputText);
  const usedContext = input.toolNames.some((tool) => contextTools.has(tool));
  const usedTranscript = input.transcriptFilesRead.length > 0;

  if (
    input.fixture.memoryRole === "unnecessary" &&
    input.condition !== "code-only" &&
    (usedContext || usedTranscript || /used/i.test(decision))
  ) {
    failures.push("unnecessary_memory_used");
  }

  if (
    ["helpful", "correction", "synthesis"].includes(input.fixture.memoryRole) &&
    input.condition !== "code-only" &&
    !(
      input.citationHits.includes("session") &&
      input.citationHits.includes("message")
    )
  ) {
    failures.push("missing_relevant_memory_citation");
  }

  if (input.fixture.memoryRole === "missing") {
    if (input.citationHits.length > 0 || /used/i.test(decision)) {
      failures.push("unsupported_memory_cited");
    }
  }

  if (
    ["harmful", "missing", "correction", "synthesis"].includes(
      input.fixture.memoryRole,
    )
  ) {
    for (const distractor of input.fixture.distractors) {
      if (
        input.outputText.includes(distractor.sessionID) ||
        input.outputText.includes(distractor.title)
      ) {
        failures.push("stale_session_cited");
        break;
      }
    }
  }

  return { passed: failures.length === 0, failures, decision };
}

function inferMemoryDecision(outputText: string) {
  if (/abstain|unsupported|no prior|no supporting/i.test(outputText))
    return "abstained";
  if (/reject|stale/i.test(outputText)) return "rejected";
  if (/ignore|irrelevant/i.test(outputText)) return "ignored";
  if (/session_id"\s*:\s*"[^"]+"/.test(outputText)) return "used";
  return "unknown";
}

function parseAnswer(outputText: string) {
  try {
    return JSON.parse(outputText) as { memory_decision?: unknown };
  } catch {}
  const match = outputText.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]) as { memory_decision?: unknown };
  } catch {
    return undefined;
  }
}

function citationMatches(
  outputText: string,
  seeded: SeededSessions,
  fixture: CodeFixture,
) {
  const hits: string[] = [];
  const sessionID = seeded.relevantSessionID ?? fixture.relevant?.sessionID;
  if (sessionID && outputText.includes(sessionID)) hits.push("session");
  if (fixture.relevant?.title && outputText.includes(fixture.relevant.title))
    hits.push("session");
  if (seeded.relevantMessageIDs.some((id) => outputText.includes(id)))
    hits.push("message");
  return [...new Set(hits)];
}

function transcriptReadFiles(
  tools: Array<NonNullable<SessionMessage["parts"]>[number]>,
) {
  const files: string[] = [];
  for (const part of tools) {
    if (part.tool === "read") {
      const input = objectInput(part.state?.input);
      if (typeof input.filePath === "string") files.push(input.filePath);
      continue;
    }
    if (part.tool === "bash") {
      const input = objectInput(part.state?.input);
      const command = typeof input.command === "string" ? input.command : "";
      for (const match of command.matchAll(
        /[^\s"'`]+memory\/transcripts\/[^\s"'`]+/g,
      )) {
        files.push(match[0]);
      }
    }
  }
  return [
    ...new Set(
      files.filter((filePath) => filePath.includes("memory/transcripts")),
    ),
  ];
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

function touchedFiles(patch: string) {
  return [
    ...new Set(
      [...patch.matchAll(/^diff --git a\/(.*?) b\/(.*?)$/gm)].map(
        (match) => match[2]!,
      ),
    ),
  ];
}

function previewTestResult(result: TestResult): TestResult {
  return {
    ...result,
    stdout: result.stdout.slice(0, 4000),
    stderr: result.stderr.slice(0, 4000),
    error: result.error?.slice(0, 4000),
  };
}

function bufferString(value: string | Buffer | undefined) {
  if (!value) return "";
  return typeof value === "string" ? value : value.toString();
}

function objectInput(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

async function analyzeRun(outDir: string): Promise<Analysis> {
  const rows: RunStats[] = [];
  await collectStats(path.join(outDir, "fixtures"), rows);
  return {
    outDir,
    generatedAt: new Date().toISOString(),
    rows: rows.sort(compareRows),
  };
}

async function combineRuns(
  outDir: string,
  runDirs: string[],
): Promise<Analysis> {
  const rows: RunStats[] = [];
  for (const runDir of runDirs) {
    const analysisPath = path.join(runDir, "analysis.json");
    const analysis = JSON.parse(
      await fs.readFile(analysisPath, "utf8"),
    ) as Analysis;
    rows.push(...analysis.rows);
  }
  return {
    outDir,
    generatedAt: new Date().toISOString(),
    sourceRuns: runDirs,
    rows: rows.sort(compareRows),
  };
}

function compareRows(a: RunStats, b: RunStats) {
  const fixtureOrder = a.fixture.localeCompare(b.fixture);
  if (fixtureOrder !== 0) return fixtureOrder;
  const conditionOrder =
    conditionSortIndex(a.condition) - conditionSortIndex(b.condition);
  if (conditionOrder !== 0) return conditionOrder;
  return (a.repeat ?? 0) - (b.repeat ?? 0);
}

function conditionSortIndex(condition: ConditionID) {
  const index = defaultConditions.indexOf(condition);
  return index === -1 ? defaultConditions.length : index;
}

async function collectStats(dir: string, rows: RunStats[]) {
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectStats(filePath, rows);
    if (entry.isFile() && entry.name === "stats.json") {
      const parsed = JSON.parse(
        await fs.readFile(filePath, "utf8"),
      ) as RunStats;
      rows.push(parsed);
    }
  }
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
}

function renderAnalysisMarkdown(analysis: Analysis) {
  const rows = analysis.rows.map(
    (row) =>
      `| ${row.fixture} | ${row.memory_role} | ${row.condition} | ${row.repeat ?? ""} | ${String(row.benchmark_passed)} | ${String(row.tests_passed)} | ${String(row.memory_policy_passed)} | ${String(row.expected_files_touched)} | ${String(row.touched_files_allowed)} | ${row.tool_path_failures.join("; ")} | ${row.touched_files.join(", ")} | ${row.unexpected_touched_files.join(", ")} | ${row.tokens.input.toLocaleString()} | ${row.tokens.cacheRead.toLocaleString()} | ${formatPercent(cacheHitShare(row.tokens))} | ${row.irrelevant_transcript_reads.length} |`,
  );
  const conditionRows = defaultConditions
    .map((condition) => {
      const matching = analysis.rows.filter(
        (row) => row.condition === condition,
      );
      if (matching.length === 0) return undefined;
      const tokens = matching.reduce(
        (bucket, row) => addTokenBuckets(bucket, row.tokens),
        emptyTokenBucket(),
      );
      const passed = matching.filter((row) => row.benchmark_passed).length;
      return `| ${condition} | ${passed}/${matching.length} | ${tokens.input.toLocaleString()} | ${Math.round(tokens.input / matching.length).toLocaleString()} | ${tokens.cacheRead.toLocaleString()} | ${formatPercent(cacheHitShare(tokens))} |`;
    })
    .filter((row): row is string => Boolean(row));
  return [
    "# Code Memory Benchmark Analysis",
    "",
    `- Run: ${analysis.outDir}`,
    `- Generated: ${analysis.generatedAt}`,
    ...(analysis.sourceRuns
      ? [`- Source runs: ${analysis.sourceRuns.join(", ")}`]
      : []),
    `- Passed: ${analysis.rows.filter((row) => row.benchmark_passed).length}/${analysis.rows.length}`,
    "",
    "| Fixture | Role | Condition | Repeat | Pass | Tests | Memory Policy | Expected Files | Allowed Files | Failures | Touched | Unexpected | Input Tok | Cache Read Tok | Cache Hit | Irrelevant Reads |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|---:|---:|---:|---:|",
    ...rows,
    "",
    "## By Condition",
    "",
    "| Condition | Pass | Total Input | Avg Input | Cache Read | Cache Hit |",
    "|---|---:|---:|---:|---:|---:|",
    ...conditionRows,
    "",
  ].join("\n");
}

function addTokenBuckets(left: TokenBucket, right: TokenBucket): TokenBucket {
  return {
    messages: left.messages + right.messages,
    assistant: left.assistant + right.assistant,
    input: left.input + right.input,
    output: left.output + right.output,
    total: left.total + right.total,
    reasoning: left.reasoning + right.reasoning,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    toolCalls: left.toolCalls + right.toolCalls,
    maxInput: Math.max(left.maxInput, right.maxInput),
  };
}

function renderAnalysisCsv(analysis: Analysis) {
  const header = [
    "fixture",
    "repeat",
    "memory_role",
    "condition",
    "pass",
    "tests_passed",
    "memory_policy_passed",
    "expected_files_touched",
    "touched_files_allowed",
    "tool_path_failures",
    "touched_files",
    "unexpected_touched_files",
    "input_tokens",
    "cache_read_tokens",
    "cache_hit_share",
    "irrelevant_reads",
  ].join(",");
  const rows = analysis.rows.map((row) =>
    [
      row.fixture,
      row.repeat ?? "",
      row.memory_role,
      row.condition,
      row.benchmark_passed,
      row.tests_passed,
      row.memory_policy_passed,
      row.expected_files_touched,
      row.touched_files_allowed,
      csvCell(row.tool_path_failures.join(";")),
      csvCell(row.touched_files.join(";")),
      csvCell(row.unexpected_touched_files.join(";")),
      row.tokens.input,
      row.tokens.cacheRead,
      cacheHitShare(row.tokens) ?? "",
      row.irrelevant_transcript_reads.length,
    ].join(","),
  );
  return [header, ...rows, ""].join("\n");
}

async function writeSummary(
  outDir: string,
  results: Array<{
    fixture: string;
    condition: ConditionID;
    repeat?: number;
    statsPath: string;
    pass?: boolean;
    error?: string;
  }>,
  options: Options,
) {
  const lines = [
    "# Code Memory Benchmark Run",
    "",
    `- Conditions: ${options.conditions.join(", ")}`,
    `- Fixtures: ${options.fixtures.join(", ")}`,
    `- Model: ${options.modelSlug}`,
    `- Repeats: ${options.repeats}`,
    "",
    "| Fixture | Condition | Repeat | Pass | Stats | Error |",
    "|---|---|---:|---:|---|---|",
    ...results.map((result) => {
      const relStats = path.relative(outDir, result.statsPath);
      return `| ${result.fixture} | ${result.condition} | ${result.repeat ?? ""} | ${String(result.pass ?? false)} | [stats](${relStats}) | ${result.error ? result.error.split("\n")[0] : ""} |`;
    }),
    "",
  ];
  await fs.writeFile(path.join(outDir, "summary.md"), `${lines.join("\n")}\n`);
}

function cacheHitShare(bucket: TokenBucket) {
  const denom = bucket.input + bucket.cacheRead;
  if (denom === 0) return undefined;
  return bucket.cacheRead / denom;
}

function formatPercent(value: number | undefined) {
  return value === undefined ? "" : `${(value * 100).toFixed(1)}%`;
}

function csvCell(value: string) {
  if (!/[",\n]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

function valueArg(args: string[], name: string) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
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
  return new Date()
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

function file(filePath: string, lines: string[]): CodeFile {
  return { file: filePath, lines };
}

const contextTools = new Set([
  "session_lookup",
  "session_detail",
  "message_detail",
  "session_tree",
  "blame_lookup",
]);

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
