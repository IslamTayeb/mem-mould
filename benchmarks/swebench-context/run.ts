import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
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

type SwebenchInstance = {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  version?: string;
  patch?: string;
  test_patch?: string;
  hints_text?: string;
  created_at?: string;
  environment_setup_commit?: string;
  difficulty?: string;
  fail_to_pass: string[];
  pass_to_pass: string[];
};

type SwebenchScore = {
  patch_applies: boolean | null;
  resolved: boolean | null;
  fail_to_pass_success: number;
  fail_to_pass_failure: number;
  fail_to_pass_total: number;
  fail_to_pass_score: number | null;
  pass_to_pass_success: number;
  pass_to_pass_failure: number;
  pass_to_pass_total: number;
  regression_penalty: number;
  quality_score: number | null;
};

type SessionMessage = {
  info?: {
    id?: string;
    role?: string;
    finish?: string;
    providerID?: string;
    modelID?: string;
    system?: string;
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
    state?: { status?: string; input?: unknown; output?: unknown };
  }>;
};

type ConditionID =
  | "clean-no-plugin"
  | "polluted-default-compact"
  | "polluted-memmould-compact"
  | "polluted-memmould-boundary-compact"
  | "polluted-memmould-cache-stable-boundary-compact"
  | "polluted-no-compact"
  | "polluted-memmould-tools-no-compact";

type ConditionConfig = {
  id: ConditionID;
  plugin: boolean;
  prelude: boolean;
  forceCompaction: boolean;
  contextCleanup: boolean;
  cleanupMode?: "standard" | "boundary";
  cacheStable?: boolean;
};

type Options = {
  dataset: string;
  split: string;
  instances: string[];
  conditions: ConditionID[];
  outDir: string;
  modelSlug: string;
  evalRunner: "python" | "uv";
  selectCandidates: boolean;
  maxCandidates: number;
  skipEval: boolean;
  prepareOnly: boolean;
  keepWorktrees: boolean;
  promptTimeoutMs: number;
  diagnosticAfterCompaction: boolean;
  analyzeRun?: string;
};

const repoRoot = path.resolve(process.cwd());
const defaultOutDir = path.join(
  repoRoot,
  "benchmarks",
  "swebench-context",
  "runs",
  timestampForPath(new Date()),
);

const conditionConfigs: Record<ConditionID, ConditionConfig> = {
  "clean-no-plugin": {
    id: "clean-no-plugin",
    plugin: false,
    prelude: false,
    forceCompaction: false,
    contextCleanup: false,
  },
  "polluted-default-compact": {
    id: "polluted-default-compact",
    plugin: false,
    prelude: true,
    forceCompaction: true,
    contextCleanup: false,
  },
  "polluted-memmould-compact": {
    id: "polluted-memmould-compact",
    plugin: true,
    prelude: true,
    forceCompaction: true,
    contextCleanup: true,
    cleanupMode: "standard",
  },
  "polluted-memmould-boundary-compact": {
    id: "polluted-memmould-boundary-compact",
    plugin: true,
    prelude: true,
    forceCompaction: true,
    contextCleanup: true,
    cleanupMode: "boundary",
  },
  "polluted-memmould-cache-stable-boundary-compact": {
    id: "polluted-memmould-cache-stable-boundary-compact",
    plugin: true,
    prelude: true,
    forceCompaction: true,
    contextCleanup: true,
    cleanupMode: "boundary",
    cacheStable: true,
  },
  "polluted-no-compact": {
    id: "polluted-no-compact",
    plugin: false,
    prelude: true,
    forceCompaction: false,
    contextCleanup: false,
  },
  "polluted-memmould-tools-no-compact": {
    id: "polluted-memmould-tools-no-compact",
    plugin: true,
    prelude: true,
    forceCompaction: false,
    contextCleanup: true,
    cleanupMode: "standard",
  },
};

async function main() {
  const options = await parseOptions();

  if (options.analyzeRun) {
    const report = await analyzeRun(options.analyzeRun);
    const markdown = runAnalysisMarkdown(report);
    await fs.writeFile(
      path.join(options.analyzeRun, "analysis.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await fs.writeFile(path.join(options.analyzeRun, "analysis.md"), markdown);
    console.log(markdown);
    console.log(
      `Analysis written to ${path.join(options.analyzeRun, "analysis.md")}`,
    );
    return;
  }

  await fs.mkdir(options.outDir, { recursive: true });

  if (options.selectCandidates) {
    const rows = await loadSwebenchDatasetRows(options.dataset, options.split);
    const candidates = rankCandidates(rows).slice(0, options.maxCandidates);
    await writeCandidateReport(options.outDir, options, candidates);
    console.log(candidateReportMarkdown(candidates, options));
    console.log(
      `Candidate report written to ${path.join(options.outDir, "candidates.md")}`,
    );
    return;
  }

  const model = parseModelSlug(options.modelSlug);
  const instances = await loadSwebenchInstances(
    options.dataset,
    options.split,
    options.instances,
  );
  await fs.writeFile(
    path.join(options.outDir, "config.json"),
    `${JSON.stringify({ ...options, instances }, null, 2)}\n`,
  );

  if (options.prepareOnly) {
    await writeSummary(options.outDir, [], options);
    console.log(`Prepared benchmark metadata at ${options.outDir}`);
    return;
  }

  const results: RunResult[] = [];
  for (const conditionID of options.conditions) {
    const condition = conditionConfigs[conditionID];
    for (const instance of instances) {
      const result = await runConditionInstance(
        condition,
        instance,
        model,
        options,
      );
      results.push(result);
      await writeSummary(options.outDir, results, options);
    }
  }

  await writeSummary(options.outDir, results, options);
  await writeRunAnalysis(options.outDir).catch((error) => {
    console.warn(`Could not write run analysis: ${String(error)}`);
  });
  console.log(`Benchmark artifacts written to ${options.outDir}`);
}

type RunResult = {
  condition: ConditionID;
  instanceID: string;
  sessionID?: string;
  patchPath: string;
  statsPath: string;
  predictionPath: string;
  resolved?: boolean | null;
  score?: SwebenchScore | null;
  error?: string;
};

async function runConditionInstance(
  condition: ConditionConfig,
  instance: SwebenchInstance,
  model: ModelRef,
  options: Options,
): Promise<RunResult> {
  const conditionDir = path.join(
    options.outDir,
    "conditions",
    condition.id,
    instance.instance_id,
  );
  const worktree = path.join(conditionDir, "worktree");
  await fs.mkdir(conditionDir, { recursive: true });

  const startedAt = Date.now();
  const resultBase = {
    condition: condition.id,
    instanceID: instance.instance_id,
    patchPath: path.join(conditionDir, "patch.diff"),
    statsPath: path.join(conditionDir, "stats.json"),
    predictionPath: path.join(conditionDir, "prediction.jsonl"),
  } satisfies Omit<RunResult, "sessionID" | "resolved" | "error">;

  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await prepareWorktree(instance, worktree);
    await fs.writeFile(
      path.join(conditionDir, "issue.md"),
      `# ${instance.instance_id}\n\n${instance.problem_statement}\n`,
    );

    const opencodeRoot = await resolveOpenCodeRoot(conditionDir);
    const env = await buildOpenCodeEnv({
      opencodeRoot,
      conditionDir,
      worktree,
      modelSlug: options.modelSlug,
      plugin: condition.plugin,
      cacheStable: condition.cacheStable,
      taskBoundary: condition.cleanupMode === "boundary",
    });
    server = await startServer(env, worktree);
    const client = createOpencodeClient({ baseUrl: server.url });
    await pickModel(client, worktree, options.modelSlug);

    const sessionID = await createSession(
      client,
      worktree,
      `${condition.id} ${instance.instance_id}`,
    );

    if (condition.prelude) {
      await playPrelude(client, worktree, sessionID, options.promptTimeoutMs);
    }
    if (condition.contextCleanup) {
      await requestContextCleanup(
        client,
        worktree,
        sessionID,
        options.promptTimeoutMs,
        condition.cleanupMode ?? "standard",
      );
    }
    if (condition.forceCompaction) {
      await forceCompaction(client, worktree, sessionID, model);
    }

    if (options.diagnosticAfterCompaction) {
      await prompt(
        client,
        worktree,
        sessionID,
        buildBoundaryDiagnosticPrompt(instance),
        "Answer with compact JSON only. Do not edit files and do not call tools.",
        {},
        options.promptTimeoutMs,
      );
    } else {
      await prompt(
        client,
        worktree,
        sessionID,
        buildIssuePrompt(instance),
        "You are solving a SWE-bench software engineering task. Edit the repository as needed. Run focused tests if useful. Do not commit. Do not mention unrelated prior auth, docs, or queue-helper work unless it is directly relevant to this repository issue.",
        undefined,
        options.promptTimeoutMs,
      );
    }

    const messages = await listSessionMessages(client, worktree, sessionID);
    await fs.writeFile(
      path.join(conditionDir, "messages.json"),
      `${JSON.stringify(messages, null, 2)}\n`,
    );
    await copyContextMapIfPresent(opencodeRoot.home, sessionID, conditionDir);

    const patch = await gitDiff(worktree);
    await fs.writeFile(resultBase.patchPath, patch);
    await writePrediction(
      resultBase.predictionPath,
      condition.id,
      instance,
      patch,
      options.modelSlug,
    );

    const evalResult =
      options.skipEval || options.diagnosticAfterCompaction
        ? { resolved: null, score: null, outputPath: undefined }
        : await runSwebenchEval(
            options,
            condition,
            instance,
            resultBase.predictionPath,
          );

    const stats = buildStats({
      condition,
      instance,
      sessionID,
      messages,
      patch,
      startedAt,
      evalResult,
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
      resolved: evalResult.resolved,
      score: evalResult.score,
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

async function parseOptions(): Promise<Options> {
  const args = process.argv.slice(2);
  const dataset = valueArg(args, "--dataset") ?? "SWE-bench/SWE-bench_Verified";
  const split = valueArg(args, "--split") ?? "test";
  const modelSlug = requiredModelSlug();
  const outDir = path.resolve(valueArg(args, "--out") ?? defaultOutDir);
  const analyzeRun = valueArg(args, "--analyze-run");
  const instanceArg =
    valueArg(args, "--instance") ?? valueArg(args, "--instances");
  const instances = instanceArg
    ? splitList(instanceArg)
    : await readDefaultInstances();
  const conditionArg = valueArg(args, "--conditions");
  const evalRunner = (valueArg(args, "--eval-runner") ??
    "python") as Options["evalRunner"];
  assert.ok(
    evalRunner === "python" || evalRunner === "uv",
    "--eval-runner must be python or uv",
  );
  const maxCandidates = Number(valueArg(args, "--max-candidates") ?? "20");
  assert.ok(Number.isFinite(maxCandidates) && maxCandidates > 0);
  const conditions = (
    conditionArg
      ? splitList(conditionArg)
      : [
          "clean-no-plugin",
          "polluted-default-compact",
          "polluted-memmould-compact",
        ]
  ) as ConditionID[];
  for (const condition of conditions) {
    assert.ok(
      condition in conditionConfigs,
      `unknown condition ${condition}; expected one of ${Object.keys(conditionConfigs).join(", ")}`,
    );
  }
  const timeoutMinutes = Number(
    valueArg(args, "--prompt-timeout-minutes") ?? "25",
  );
  assert.ok(Number.isFinite(timeoutMinutes) && timeoutMinutes > 0);
  return {
    dataset,
    split,
    instances,
    conditions,
    outDir,
    modelSlug,
    evalRunner,
    selectCandidates: hasArg(args, "--select-candidates"),
    maxCandidates,
    skipEval: hasArg(args, "--skip-eval"),
    prepareOnly: hasArg(args, "--prepare-only"),
    keepWorktrees: hasArg(args, "--keep-worktrees"),
    promptTimeoutMs: timeoutMinutes * 60_000,
    diagnosticAfterCompaction: hasArg(args, "--diagnostic-after-compaction"),
    analyzeRun: analyzeRun ? path.resolve(analyzeRun) : undefined,
  };
}

async function readDefaultInstances() {
  const file = path.join(
    repoRoot,
    "benchmarks",
    "swebench-context",
    "instances.json",
  );
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as {
    instances?: unknown;
  };
  assert.ok(
    Array.isArray(parsed.instances),
    "instances.json must contain an instances array",
  );
  return parsed.instances.map((item) => String(item));
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

async function loadSwebenchInstances(
  dataset: string,
  split: string,
  instanceIDs: string[],
) {
  const rows = await loadSwebenchDatasetRows(dataset, split);
  const found = new Map(rows.map((row) => [row.instance_id, row]));
  const missing = instanceIDs.filter((id) => !found.has(id));
  assert.equal(
    missing.length,
    0,
    `missing SWE-bench instances: ${missing.join(", ")}`,
  );
  return instanceIDs.map((id) => found.get(id)!);
}

async function loadSwebenchDatasetRows(dataset: string, split: string) {
  try {
    return await loadRowsFromHuggingFace(dataset, split);
  } catch (error) {
    console.warn(
      `Hugging Face rows API failed, trying python datasets fallback: ${String(error)}`,
    );
    return await loadRowsFromPythonDatasets(dataset, split);
  }
}

async function loadRowsFromHuggingFace(dataset: string, split: string) {
  const rows: SwebenchInstance[] = [];
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const url = new URL("https://datasets-server.huggingface.co/rows");
    url.searchParams.set("dataset", dataset);
    url.searchParams.set("config", "default");
    url.searchParams.set("split", split);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("length", String(pageSize));
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `${response.status} ${response.statusText} for ${url.toString()}`,
      );
    }
    const body = (await response.json()) as {
      rows?: Array<{ row?: unknown }>;
      num_rows_total?: number;
    };
    const page = body.rows ?? [];
    rows.push(...page.map((entry) => normalizeSwebenchRow(entry.row)));
    if (page.length === 0 || offset + pageSize >= (body.num_rows_total ?? 0)) {
      break;
    }
  }
  return rows;
}

async function loadRowsFromPythonDatasets(dataset: string, split: string) {
  const script = String.raw`
import json, sys
from datasets import load_dataset
dataset_name, split = sys.argv[1:3]
ds = load_dataset(dataset_name, split=split)
for row in ds:
    print(json.dumps(row))
`;
  const { stdout } = await execFileAsync(
    "python3",
    ["-c", script, dataset, split],
    { maxBuffer: 100 * 1024 * 1024 },
  );
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => normalizeSwebenchRow(JSON.parse(line) as unknown));
}

async function loadInstancesFromHuggingFaceRows(
  dataset: string,
  split: string,
  instanceIDs: string[],
  found: Map<string, SwebenchInstance>,
) {
  const wanted = new Set(instanceIDs);
  const pageSize = 100;
  for (let offset = 0; found.size < wanted.size; offset += pageSize) {
    const url = new URL("https://datasets-server.huggingface.co/rows");
    url.searchParams.set("dataset", dataset);
    url.searchParams.set("config", "default");
    url.searchParams.set("split", split);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("length", String(pageSize));
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `${response.status} ${response.statusText} for ${url.toString()}`,
      );
    }
    const body = (await response.json()) as {
      rows?: Array<{ row?: unknown }>;
      num_rows_total?: number;
    };
    const rows = body.rows ?? [];
    for (const entry of rows) {
      const row = normalizeSwebenchRow(entry.row);
      if (wanted.has(row.instance_id)) found.set(row.instance_id, row);
    }
    if (rows.length === 0 || offset + pageSize >= (body.num_rows_total ?? 0))
      break;
  }
}

async function loadInstancesFromPythonDatasets(
  dataset: string,
  split: string,
  instanceIDs: string[],
  found: Map<string, SwebenchInstance>,
) {
  const script = String.raw`
import json, sys
from datasets import load_dataset
dataset_name, split, ids_json = sys.argv[1:4]
wanted = set(json.loads(ids_json))
ds = load_dataset(dataset_name, split=split)
for row in ds:
    iid = row.get("instance_id")
    if iid in wanted:
        print(json.dumps(row))
`;
  const { stdout } = await execFileAsync(
    "python3",
    ["-c", script, dataset, split, JSON.stringify(instanceIDs)],
    { maxBuffer: 50 * 1024 * 1024 },
  );
  for (const line of stdout.split("\n").filter(Boolean)) {
    const row = normalizeSwebenchRow(JSON.parse(line) as unknown);
    found.set(row.instance_id, row);
  }
}

function normalizeSwebenchRow(row: unknown): SwebenchInstance {
  assert.ok(row && typeof row === "object", "invalid SWE-bench row");
  const record = row as Record<string, unknown>;
  const instance = {
    instance_id: String(record.instance_id ?? ""),
    repo: String(record.repo ?? ""),
    base_commit: String(record.base_commit ?? ""),
    problem_statement: String(record.problem_statement ?? ""),
    version: record.version === undefined ? undefined : String(record.version),
    patch: record.patch === undefined ? undefined : String(record.patch),
    test_patch:
      record.test_patch === undefined ? undefined : String(record.test_patch),
    hints_text:
      record.hints_text === undefined ? undefined : String(record.hints_text),
    created_at:
      record.created_at === undefined ? undefined : String(record.created_at),
    environment_setup_commit:
      record.environment_setup_commit === undefined
        ? undefined
        : String(record.environment_setup_commit),
    difficulty:
      record.difficulty === undefined ? undefined : String(record.difficulty),
    fail_to_pass: parseJsonStringList(record.FAIL_TO_PASS),
    pass_to_pass: parseJsonStringList(record.PASS_TO_PASS),
  } satisfies SwebenchInstance;
  assert.ok(instance.instance_id, "SWE-bench row missing instance_id");
  assert.ok(
    instance.repo.includes("/"),
    `SWE-bench row has invalid repo: ${instance.repo}`,
  );
  assert.ok(
    instance.base_commit,
    `SWE-bench row missing base_commit for ${instance.instance_id}`,
  );
  assert.ok(
    instance.problem_statement,
    `SWE-bench row missing problem_statement for ${instance.instance_id}`,
  );
  return instance;
}

function parseJsonStringList(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value !== "string" || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

type Candidate = {
  instance: SwebenchInstance;
  score: number;
  failToPassCount: number;
  passToPassCount: number;
  goldPatchBytes: number;
  testPatchBytes: number;
  problemBytes: number;
  touchedFiles: string[];
  reasons: string[];
  caveats: string[];
};

function rankCandidates(instances: SwebenchInstance[]): Candidate[] {
  return instances
    .map((instance) => scoreCandidate(instance))
    .sort((a, b) => b.score - a.score);
}

function scoreCandidate(instance: SwebenchInstance): Candidate {
  const failToPassCount = instance.fail_to_pass.length;
  const passToPassCount = instance.pass_to_pass.length;
  const goldPatchBytes = Buffer.byteLength(instance.patch ?? "");
  const testPatchBytes = Buffer.byteLength(instance.test_patch ?? "");
  const problemBytes = Buffer.byteLength(instance.problem_statement);
  const touchedFilePaths = touchedFiles(
    `${instance.patch ?? ""}\n${instance.test_patch ?? ""}`,
  );

  const difficultyScore = (() => {
    switch ((instance.difficulty ?? "").trim()) {
      case ">4 hours":
        return 260;
      case "1-4 hours":
        return 190;
      case "15 min - 1 hour":
        return 80;
      case "<15 min fix":
        return -40;
      default:
        return 0;
    }
  })();
  const f2pScore = Math.min(failToPassCount, 20) * 14;
  const patchScore = Math.min(goldPatchBytes / 120, 90);
  const testPatchScore = Math.min(testPatchBytes / 180, 90);
  const problemScore = Math.min(problemBytes / 300, 60);
  const fileScore = Math.min(touchedFilePaths.length, 8) * 9;
  const lowSignalPenalty = failToPassCount <= 1 ? 45 : 0;
  const hugeEnvPenalty = /liveserver|thread|oracle|postgres|mysql/i.test(
    `${instance.problem_statement}\n${instance.hints_text ?? ""}`,
  )
    ? 15
    : 0;

  const score =
    difficultyScore +
    f2pScore +
    patchScore +
    testPatchScore +
    problemScore +
    fileScore -
    lowSignalPenalty -
    hugeEnvPenalty;
  const reasons = [
    instance.difficulty ? `difficulty ${instance.difficulty}` : undefined,
    failToPassCount > 1 ? `${failToPassCount} target tests` : undefined,
    touchedFilePaths.length > 2
      ? `${touchedFilePaths.length} touched files`
      : undefined,
    goldPatchBytes > 2_000 ? "substantial gold patch" : undefined,
    testPatchBytes > 4_000 ? "substantial test patch" : undefined,
    problemBytes > 3_000 ? "long issue text" : undefined,
  ].filter((item): item is string => Boolean(item));
  const caveats = [
    failToPassCount <= 1 ? "binary target-test signal" : undefined,
    hugeEnvPenalty
      ? "may involve heavier DB/server environment behavior"
      : undefined,
    /generated|parser table/i.test(
      `${instance.patch ?? ""}\n${instance.test_patch ?? ""}`,
    )
      ? "may touch generated/parser files"
      : undefined,
  ].filter((item): item is string => Boolean(item));
  return {
    instance,
    score,
    failToPassCount,
    passToPassCount,
    goldPatchBytes,
    testPatchBytes,
    problemBytes,
    touchedFiles: touchedFilePaths,
    reasons,
    caveats,
  };
}

async function writeCandidateReport(
  outDir: string,
  options: Options,
  candidates: Candidate[],
) {
  await fs.writeFile(
    path.join(outDir, "candidates.md"),
    candidateReportMarkdown(candidates, options),
  );
  await fs.writeFile(
    path.join(outDir, "candidates.json"),
    `${JSON.stringify(candidates, null, 2)}\n`,
  );
}

function candidateReportMarkdown(candidates: Candidate[], options: Options) {
  return [
    "# SWE-Bench Context-Stress Candidates",
    "",
    `- Dataset: ${options.dataset}`,
    `- Split: ${options.split}`,
    `- Max candidates: ${options.maxCandidates}`,
    "",
    "| Rank | Instance | Repo | Difficulty | F2P | P2P | Score | Why | Caveats |",
    "|---:|---|---|---|---:|---:|---:|---|---|",
    ...candidates.map((candidate, index) => {
      const instance = candidate.instance;
      const why = candidate.reasons.join(", ").replaceAll("|", "\\|");
      const caveats = candidate.caveats.join(", ").replaceAll("|", "\\|");
      return `| ${index + 1} | \`${instance.instance_id}\` | ${instance.repo} | ${instance.difficulty ?? ""} | ${candidate.failToPassCount} | ${candidate.passToPassCount} | ${candidate.score.toFixed(1)} | ${why} | ${caveats} |`;
    }),
    "",
  ].join("\n");
}

async function prepareWorktree(instance: SwebenchInstance, worktree: string) {
  await fs.rm(worktree, { recursive: true, force: true });
  await fs.mkdir(path.dirname(worktree), { recursive: true });
  await execFileAsync(
    "git",
    [
      "clone",
      "--filter=blob:none",
      "--no-tags",
      `https://github.com/${instance.repo}.git`,
      worktree,
    ],
    {
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  await execFileAsync("git", ["checkout", instance.base_commit], {
    cwd: worktree,
    maxBuffer: 20 * 1024 * 1024,
  });
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
  const opencodeRoot = {
    home: path.join(root, "home"),
    data: path.join(root, "data"),
    config: path.join(root, "config"),
    state: path.join(root, "state"),
    cache: path.join(root, "cache"),
  };
  await Promise.all(
    Object.values(opencodeRoot).map((dir) =>
      fs.mkdir(dir, { recursive: true }),
    ),
  );
  return opencodeRoot;
}

async function buildOpenCodeEnv(input: {
  opencodeRoot: OpenCodeRoot;
  conditionDir: string;
  worktree: string;
  modelSlug: string;
  plugin: boolean;
  cacheStable?: boolean;
  taskBoundary?: boolean;
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
  return requested;
}

async function createSession(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  title: string,
) {
  const session = (((await client.session.create({ directory, title })) as any)
    ?.data ?? {}) as {
    id: string;
  };
  assert.ok(session.id, "failed to create session");
  return session.id;
}

async function playPrelude(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  sessionID: string,
  timeoutMs: number,
) {
  const turns = await readPreludeTurns();
  for (const turn of turns) {
    await prompt(
      client,
      directory,
      sessionID,
      turn,
      "This is pre-task conversation history for a benchmark. Do not edit files and do not call tools. Respond concisely while preserving important facts for later compaction.",
      {},
      timeoutMs,
    );
  }
}

async function readPreludeTurns() {
  const raw = await fs.readFile(
    path.join(repoRoot, "benchmarks", "swebench-context", "prelude.md"),
    "utf8",
  );
  return raw
    .split(/\n--- turn ---\n/g)
    .slice(1)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function requestContextCleanup(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  sessionID: string,
  timeoutMs: number,
  mode: "standard" | "boundary",
) {
  const text =
    mode === "boundary"
      ? "We are ending the old auth/docs/test planning work and switching to a wholly unrelated open-source repository issue. Call view_context exactly once. Then call set_fidelity with fidelity='drop' for every blob about auth, docs, onboarding, tests, stale hypotheses, queue helpers, mutexes, rollback flags, or prior planning. No prior blob is current for the next task. If a blob cannot be dropped safely, set it to placeholder and explain why in one short phrase. Then answer with only ok."
      : "Before we switch to a new software issue, call view_context exactly once. Then call set_fidelity for any completed or unrelated prior blobs so low-value docs, stale hypotheses, and old test-planning chatter are compressed, placeholder, or dropped. Keep only genuinely important current-task context high fidelity. Then answer with only ok.";
  await prompt(
    client,
    directory,
    sessionID,
    text,
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

function buildIssuePrompt(instance: SwebenchInstance) {
  return [
    `We are now solving SWE-bench instance ${instance.instance_id}.`,
    `Repository: ${instance.repo}`,
    `Base commit: ${instance.base_commit}`,
    "",
    "Problem statement:",
    instance.problem_statement,
    "",
    "Please modify the repository to resolve the issue. Keep the patch minimal and do not commit changes.",
  ].join("\n");
}

function buildBoundaryDiagnosticPrompt(instance: SwebenchInstance) {
  return [
    `We are about to solve SWE-bench instance ${instance.instance_id}.`,
    `Repository: ${instance.repo}`,
    "The prior auth/docs/test planning discussion is historical noise unless explicitly relevant.",
    "Do not solve the issue yet.",
    "Return JSON with keys current_task, irrelevant_prior_context, stale_terms_to_ignore, and ready_for_new_issue.",
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
  )) as any;
  const reply = raw?.data ?? raw ?? {};
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

async function gitDiff(worktree: string) {
  const { stdout } = await execFileAsync("git", ["diff", "--binary"], {
    cwd: worktree,
    maxBuffer: 100 * 1024 * 1024,
  });
  return stdout;
}

async function writePrediction(
  file: string,
  condition: ConditionID,
  instance: SwebenchInstance,
  patch: string,
  modelSlug: string,
) {
  const prediction = {
    instance_id: instance.instance_id,
    model_name_or_path: `${condition}-${modelSlug.replaceAll("/", "-")}-opencode`,
    model_patch: patch,
  };
  await fs.writeFile(file, `${JSON.stringify(prediction)}\n`);
}

async function runSwebenchEval(
  options: Options,
  condition: ConditionConfig,
  instance: SwebenchInstance,
  predictionPath: string,
) {
  const runID =
    `mem-mould-${condition.id}-${instance.instance_id}-${Date.now()}`.replaceAll(
      /[^a-zA-Z0-9_.-]/g,
      "-",
    );
  const evalDir = path.join(
    options.outDir,
    "swebench-evaluation",
    condition.id,
    instance.instance_id,
  );
  await fs.mkdir(evalDir, { recursive: true });
  try {
    const command = swebenchEvalCommand(
      options,
      predictionPath,
      instance.instance_id,
      runID,
    );
    const { stdout, stderr } = await execFileAsync(command.file, command.args, {
      cwd: evalDir,
      maxBuffer: 100 * 1024 * 1024,
    });
    await fs.writeFile(path.join(evalDir, "stdout.txt"), stdout);
    await fs.writeFile(path.join(evalDir, "stderr.txt"), stderr);
    const score = await inferScoreFromEvaluation(evalDir, instance.instance_id);
    return { resolved: score?.resolved ?? null, score, outputPath: evalDir };
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    await fs.writeFile(path.join(evalDir, "error.txt"), message);
    return { resolved: null, score: null, outputPath: evalDir, error: message };
  }
}

function swebenchEvalCommand(
  options: Options,
  predictionPath: string,
  instanceID: string,
  runID: string,
) {
  const moduleArgs = [
    "-m",
    "swebench.harness.run_evaluation",
    "--dataset_name",
    options.dataset,
    "--predictions_path",
    predictionPath,
    "--instance_ids",
    instanceID,
    "--max_workers",
    "1",
    "--run_id",
    runID,
  ];
  if (options.evalRunner === "uv") {
    return {
      file: "uv",
      args: [
        "run",
        "--python",
        "3.11",
        "--with",
        "swebench",
        "python",
        ...moduleArgs,
      ],
    };
  }
  return { file: "python3", args: moduleArgs };
}

async function inferScoreFromEvaluation(evalDir: string, instanceID: string) {
  const files = await listFilesRecursive(evalDir);
  for (const file of files.filter(
    (item) => item.endsWith(".json") || item.endsWith(".jsonl"),
  )) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    if (!text.includes(instanceID)) continue;
    for (const line of text.split("\n").filter(Boolean)) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const score = scoreFromParsedReport(parsed, instanceID);
        if (score) return score;
      } catch {
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          const score = scoreFromParsedReport(parsed, instanceID);
          if (score) return score;
        } catch {
          // Ignore non-result JSON.
        }
      }
    }
  }
  return undefined;
}

function scoreFromParsedReport(
  parsed: Record<string, unknown>,
  instanceID: string,
): SwebenchScore | undefined {
  const instanceReport = parsed[instanceID];
  if (instanceReport && typeof instanceReport === "object") {
    const report = instanceReport as Record<string, unknown>;
    const tests =
      report.tests_status && typeof report.tests_status === "object"
        ? (report.tests_status as Record<string, unknown>)
        : {};
    const failToPass = testStatusCounts(tests.FAIL_TO_PASS);
    const passToPass = testStatusCounts(tests.PASS_TO_PASS);
    const failToPassTotal = failToPass.success + failToPass.failure;
    const passToPassTotal = passToPass.success + passToPass.failure;
    const failToPassScore =
      failToPassTotal === 0 ? null : failToPass.success / failToPassTotal;
    const regressionPenalty =
      passToPassTotal === 0 ? 0 : passToPass.failure / passToPassTotal;
    return {
      patch_applies:
        typeof report.patch_successfully_applied === "boolean"
          ? report.patch_successfully_applied
          : null,
      resolved: typeof report.resolved === "boolean" ? report.resolved : null,
      fail_to_pass_success: failToPass.success,
      fail_to_pass_failure: failToPass.failure,
      fail_to_pass_total: failToPassTotal,
      fail_to_pass_score: failToPassScore,
      pass_to_pass_success: passToPass.success,
      pass_to_pass_failure: passToPass.failure,
      pass_to_pass_total: passToPassTotal,
      regression_penalty: regressionPenalty,
      quality_score:
        failToPassScore === null ? null : failToPassScore - regressionPenalty,
    };
  }
  if (typeof parsed.resolved === "boolean") {
    return {
      patch_applies: null,
      resolved: parsed.resolved,
      fail_to_pass_success: 0,
      fail_to_pass_failure: 0,
      fail_to_pass_total: 0,
      fail_to_pass_score: null,
      pass_to_pass_success: 0,
      pass_to_pass_failure: 0,
      pass_to_pass_total: 0,
      regression_penalty: 0,
      quality_score: null,
    };
  }
  return undefined;
}

function testStatusCounts(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { success: 0, failure: 0 };
  }
  const record = value as Record<string, unknown>;
  return {
    success: Array.isArray(record.success) ? record.success.length : 0,
    failure: Array.isArray(record.failure) ? record.failure.length : 0,
  };
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFilesRecursive(full)));
    else files.push(full);
  }
  return files;
}

function buildStats(input: {
  condition: ConditionConfig;
  instance: SwebenchInstance;
  sessionID: string;
  messages: SessionMessage[];
  patch: string;
  startedAt: number;
  evalResult: {
    resolved: boolean | null;
    score?: SwebenchScore | null;
    outputPath?: string;
    error?: string;
  };
}) {
  const toolCalls = input.messages.flatMap((message) =>
    toolParts(message.parts),
  );
  const toolNames = toolCalls
    .map((part) => part.tool)
    .filter((tool): tool is string => Boolean(tool));
  const text = input.messages
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  return {
    condition: input.condition.id,
    instance_id: input.instance.instance_id,
    repo: input.instance.repo,
    session_id: input.sessionID,
    duration_ms: Date.now() - input.startedAt,
    message_count: input.messages.length,
    assistant_message_count: input.messages.filter(
      (message) => (message.info?.role ?? message.role) === "assistant",
    ).length,
    tool_call_count: toolCalls.length,
    tool_names: toolNames,
    context_tool_call_count: toolNames.filter((tool) =>
      ["view_context", "set_fidelity"].includes(tool),
    ).length,
    approximate_transcript_tokens: Math.ceil(text.length / 4),
    expected_fail_to_pass_count: input.instance.fail_to_pass.length,
    expected_pass_to_pass_count: input.instance.pass_to_pass.length,
    patch_bytes: Buffer.byteLength(input.patch),
    patch_touched_files: touchedFiles(input.patch),
    stale_context_terms_in_patch: staleTermsInPatch(input.patch),
    swebench_resolved: input.evalResult.resolved,
    swebench_score: input.evalResult.score ?? null,
    swebench_eval_path: input.evalResult.outputPath,
    swebench_eval_error: input.evalResult.error,
  };
}

function toolParts(parts: SessionMessage["parts"]) {
  return (parts ?? []).filter((part) => part.type === "tool");
}

function touchedFiles(patch: string) {
  return Array.from(
    new Set(
      patch
        .split("\n")
        .filter((line) => line.startsWith("diff --git "))
        .map((line) => line.split(" ")[2]?.replace(/^a\//, ""))
        .filter((file): file is string => Boolean(file)),
    ),
  );
}

function staleTermsInPatch(patch: string) {
  const terms = [
    "rate_limiter",
    "MutexRefreshCoordinator",
    "FLAG_AUTH_QUEUE_ROLLBACK",
    "enqueueRefresh",
    "markdown parser",
    "quickstart",
  ];
  return terms.filter((term) =>
    patch.toLowerCase().includes(term.toLowerCase()),
  );
}

type TokenBucket = {
  messages: number;
  user: number;
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

type AnalysisRow = {
  condition: string;
  instance: string;
  resolved: boolean | null;
  failToPass: string;
  passToPassRegressions: number;
  patchBytes: number;
  toolCalls: number;
  contextToolCalls: number;
  approximateTranscriptTokens: number;
  tokens: TokenBucket;
  cacheHitShare: number | null;
  phases: Record<string, TokenBucket>;
  staleTermsInPatch: string[];
  compactionSummaryCount: number;
  sessionSummaryFidelity?: string;
  staleTermsInCompactionSummary: string[];
  staleTermsInVisibleCompactionSummary: string[];
  staleTermsAfterIssue: string[];
  trace?: {
    transforms: number;
    systemTransforms: number;
    cacheStableSystemTransforms: number;
    lastRawTokens?: number;
    lastEffectiveTokens?: number;
    lastMessagesRemoved?: number;
    maxEffectiveTokens?: number;
    maxAnnotationPromptLength?: number;
  };
};

type RunAnalysis = {
  outDir: string;
  generatedAt: string;
  rows: AnalysisRow[];
};

async function writeRunAnalysis(outDir: string) {
  const analysis = await analyzeRun(outDir);
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
  const conditions = await fs
    .readdir(conditionsDir, { withFileTypes: true })
    .catch(() => []);
  for (const conditionEntry of conditions) {
    if (!conditionEntry.isDirectory()) continue;
    const conditionDir = path.join(conditionsDir, conditionEntry.name);
    const instanceEntries = await fs
      .readdir(conditionDir, { withFileTypes: true })
      .catch(() => []);
    for (const instanceEntry of instanceEntries) {
      if (!instanceEntry.isDirectory()) continue;
      const instanceDir = path.join(conditionDir, instanceEntry.name);
      const statsPath = path.join(instanceDir, "stats.json");
      const messagesPath = path.join(instanceDir, "messages.json");
      const [statsRaw, messagesRaw] = await Promise.all([
        fs.readFile(statsPath, "utf8").catch(() => undefined),
        fs.readFile(messagesPath, "utf8").catch(() => undefined),
      ]);
      if (!statsRaw || !messagesRaw) continue;
      const stats = JSON.parse(statsRaw) as Record<string, any>;
      if (stats.error) continue;
      const messages = JSON.parse(messagesRaw) as SessionMessage[];
      const phases = analyzeMessageTokens(messages);
      const tokens = combineTokenBuckets(Object.values(phases));
      const trace = await analyzeTrace(instanceDir);
      const sessionSummaryFidelity =
        await readSessionSummaryFidelity(instanceDir);
      const staleSummaryTerms = staleTermsInText(
        compactionSummaries(messages).join("\n"),
      );
      const visibleStaleSummaryTerms =
        sessionSummaryFidelity === "drop" ||
        sessionSummaryFidelity === "placeholder"
          ? []
          : staleSummaryTerms;
      rows.push({
        condition: conditionEntry.name,
        instance: instanceEntry.name,
        resolved:
          typeof stats.swebench_resolved === "boolean"
            ? stats.swebench_resolved
            : null,
        failToPass: `${stats.swebench_score?.fail_to_pass_success ?? 0}/${stats.swebench_score?.fail_to_pass_total ?? 0}`,
        passToPassRegressions:
          Number(stats.swebench_score?.pass_to_pass_failure ?? 0) || 0,
        patchBytes: Number(stats.patch_bytes ?? 0) || 0,
        toolCalls: Number(stats.tool_call_count ?? 0) || 0,
        contextToolCalls: Number(stats.context_tool_call_count ?? 0) || 0,
        approximateTranscriptTokens:
          Number(stats.approximate_transcript_tokens ?? 0) || 0,
        tokens,
        cacheHitShare: cacheHitShare(tokens),
        phases,
        staleTermsInPatch: Array.isArray(stats.stale_context_terms_in_patch)
          ? stats.stale_context_terms_in_patch.map(String)
          : [],
        compactionSummaryCount: compactionSummaries(messages).length,
        sessionSummaryFidelity,
        staleTermsInCompactionSummary: staleSummaryTerms,
        staleTermsInVisibleCompactionSummary: visibleStaleSummaryTerms,
        staleTermsAfterIssue: staleTermsInText(
          postIssueAssistantText(messages),
        ),
        trace,
      });
    }
  }
  return {
    outDir,
    generatedAt: new Date().toISOString(),
    rows: rows.sort((a, b) =>
      a.condition === b.condition
        ? a.instance.localeCompare(b.instance)
        : a.condition.localeCompare(b.condition),
    ),
  };
}

async function readSessionSummaryFidelity(instanceDir: string) {
  const raw = await fs
    .readFile(path.join(instanceDir, "context-map.json"), "utf8")
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

function emptyTokenBucket(): TokenBucket {
  return {
    messages: 0,
    user: 0,
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

function analyzeMessageTokens(messages: SessionMessage[]) {
  const phases: Record<string, TokenBucket> = {};
  let phase = "unknown";
  for (const message of messages) {
    const role = message.info?.role ?? message.role ?? "unknown";
    if (role === "user") phase = classifyUserPhase(message);
    const bucket = (phases[phase] ??= emptyTokenBucket());
    bucket.messages++;
    if (role === "user") bucket.user++;
    if (role === "assistant") {
      bucket.assistant++;
      bucket.toolCalls += toolParts(message.parts).length;
      const tokens = message.info?.tokens;
      if (tokens) {
        bucket.input += tokens.input ?? 0;
        bucket.output += tokens.output ?? 0;
        bucket.total += tokens.total ?? 0;
        bucket.reasoning += tokens.reasoning ?? 0;
        bucket.cacheRead += tokens.cache?.read ?? 0;
        bucket.cacheWrite += tokens.cache?.write ?? 0;
        bucket.maxInput = Math.max(bucket.maxInput, tokens.input ?? 0);
      }
    }
  }
  return phases;
}

function classifyUserPhase(message: SessionMessage) {
  const system = message.info?.system ?? "";
  const text = messageText(message);
  if (system.startsWith("This is pre-task")) return "prelude";
  if (
    text.startsWith("Before we switch") ||
    text.startsWith("We are ending the old")
  ) {
    return "cleanup";
  }
  if (text.startsWith("We are now solving SWE-bench")) return "solve";
  if (text.startsWith("We are about to solve SWE-bench")) return "diagnostic";
  if (!text.trim()) return "compaction";
  return "other";
}

function combineTokenBuckets(buckets: TokenBucket[]) {
  const total = emptyTokenBucket();
  for (const bucket of buckets) {
    total.messages += bucket.messages;
    total.user += bucket.user;
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

function cacheHitShare(bucket: TokenBucket) {
  const denominator = bucket.input + bucket.cacheRead;
  return denominator === 0 ? null : bucket.cacheRead / denominator;
}

function messageText(message: SessionMessage) {
  return (message.parts ?? [])
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

function postIssueAssistantText(messages: SessionMessage[]) {
  let afterIssue = false;
  const chunks: string[] = [];
  for (const message of messages) {
    const role = message.info?.role ?? message.role;
    const text = messageText(message);
    if (role === "user" && text.startsWith("We are now solving SWE-bench")) {
      afterIssue = true;
      continue;
    }
    if (afterIssue && role === "assistant") chunks.push(text);
  }
  return chunks.join("\n");
}

function staleTermsInText(text: string) {
  const terms = [
    "auth rate limiter",
    "rate_limiter",
    "MutexRefreshCoordinator",
    "FLAG_AUTH_QUEUE_ROLLBACK",
    "enqueueRefresh",
    "src/auth/queue.ts",
    "markdown parser",
    "quickstart",
    "onboarding docs",
  ];
  const lowered = text.toLowerCase();
  return terms.filter((term) => lowered.includes(term.toLowerCase()));
}

async function analyzeTrace(
  instanceDir: string,
): Promise<AnalysisRow["trace"]> {
  const entries = await fs.readdir(instanceDir).catch(() => []);
  const traceFile = entries.find((entry) => entry.endsWith(".trace.jsonl"));
  if (!traceFile) return undefined;
  const raw = await fs.readFile(path.join(instanceDir, traceFile), "utf8");
  const events = raw
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, any>];
      } catch {
        return [];
      }
    });
  const transforms = events.filter(
    (event) => event.event === "messages.transform",
  );
  const systems = events.filter((event) => event.event === "system.transform");
  const last = transforms.at(-1);
  const effectiveTokens = transforms.map(
    (event) => Number(event.preview?.total_effective_tokens ?? 0) || 0,
  );
  return {
    transforms: transforms.length,
    systemTransforms: systems.length,
    cacheStableSystemTransforms: systems.filter((event) => event.cache_stable)
      .length,
    lastRawTokens:
      last?.preview?.total_raw_tokens === undefined
        ? undefined
        : Number(last.preview.total_raw_tokens),
    lastEffectiveTokens:
      last?.preview?.total_effective_tokens === undefined
        ? undefined
        : Number(last.preview.total_effective_tokens),
    lastMessagesRemoved:
      last?.messages_removed === undefined
        ? undefined
        : Number(last.messages_removed),
    maxEffectiveTokens:
      effectiveTokens.length === 0 ? undefined : Math.max(...effectiveTokens),
    maxAnnotationPromptLength:
      systems.length === 0
        ? undefined
        : Math.max(
            ...systems.map(
              (event) => Number(event.annotation_prompt_length ?? 0) || 0,
            ),
          ),
  };
}

function runAnalysisMarkdown(analysis: RunAnalysis) {
  const byCondition = new Map<string, AnalysisRow[]>();
  for (const row of analysis.rows) {
    const rows = byCondition.get(row.condition) ?? [];
    rows.push(row);
    byCondition.set(row.condition, rows);
  }
  const aggregateRows = Array.from(byCondition.entries()).map(
    ([condition, rows]) => {
      const tokens = combineTokenBuckets(rows.map((row) => row.tokens));
      const resolved = rows.filter((row) => row.resolved).length;
      const staleSummaries = rows.filter(
        (row) => row.staleTermsInVisibleCompactionSummary.length > 0,
      ).length;
      return `| ${condition} | ${resolved}/${rows.length} | ${sumF2p(rows)} | ${tokens.input.toLocaleString()} | ${tokens.cacheRead.toLocaleString()} | ${formatPercent(cacheHitShare(tokens))} | ${staleSummaries}/${rows.length} |`;
    },
  );
  return [
    "# SWE-Bench Context Stress Analysis",
    "",
    `- Run: ${analysis.outDir}`,
    `- Generated: ${analysis.generatedAt}`,
    "",
    "## Aggregate",
    "",
    "| Condition | Resolved | F2P | Input Tok | Cache Read Tok | Cache Hit Share | Stale Summaries |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...aggregateRows,
    "",
    "## Rows",
    "",
    "| Condition | Instance | Resolved | F2P | P2P Regr. | Input Tok | Cache Hit | Summary Fidelity | Eff. Tok Last | Removed Last | Visible Stale Summary Terms | Stale After Issue |",
    "|---|---|---:|---:|---:|---:|---:|---|---:|---:|---|---|",
    ...analysis.rows.map(
      (row) =>
        `| ${row.condition} | ${row.instance} | ${String(row.resolved)} | ${row.failToPass} | ${row.passToPassRegressions} | ${row.tokens.input.toLocaleString()} | ${formatPercent(row.cacheHitShare)} | ${row.sessionSummaryFidelity ?? ""} | ${row.trace?.lastEffectiveTokens ?? ""} | ${row.trace?.lastMessagesRemoved ?? ""} | ${row.staleTermsInVisibleCompactionSummary.join(", ").replaceAll("|", "\\|")} | ${row.staleTermsAfterIssue.join(", ").replaceAll("|", "\\|")} |`,
    ),
    "",
  ].join("\n");
}

function sumF2p(rows: AnalysisRow[]) {
  let success = 0;
  let total = 0;
  for (const row of rows) {
    const [passed, count] = row.failToPass.split("/").map(Number);
    success += Number.isFinite(passed) ? passed : 0;
    total += Number.isFinite(count) ? count : 0;
  }
  return `${success}/${total}`;
}

function formatPercent(value: number | null) {
  return value === null ? "" : `${(value * 100).toFixed(1)}%`;
}

async function writeSummary(
  outDir: string,
  results: RunResult[],
  options: Options,
) {
  const lines = [
    "# SWE-Bench Context Stress Run",
    "",
    `- Model: ${options.modelSlug}`,
    `- Dataset: ${options.dataset}`,
    `- Instances: ${options.instances.join(", ")}`,
    `- Conditions: ${options.conditions.join(", ")}`,
    `- Evaluation runner: ${options.evalRunner}`,
    `- SWE-bench evaluation: ${options.skipEval || options.diagnosticAfterCompaction ? "skipped" : "attempted"}`,
    `- Diagnostic after compaction: ${options.diagnosticAfterCompaction ? "yes" : "no"}`,
    "",
    "## Results",
    "",
    "| Condition | Instance | Resolved | F2P | P2P Regr. | Quality | Patch | Stats | Error |",
    "|---|---|---:|---:|---:|---:|---|---|---|",
    ...results.map((result) => {
      const relPatch = path.relative(outDir, result.patchPath);
      const relStats = path.relative(outDir, result.statsPath);
      const resolved =
        result.resolved === undefined ? "" : String(result.resolved);
      const error = result.error
        ? result.error.split("\n")[0]?.replaceAll("|", "\\|")
        : "";
      const score = result.score;
      const f2p = score
        ? `${score.fail_to_pass_success}/${score.fail_to_pass_total}`
        : "";
      const regressions = score ? String(score.pass_to_pass_failure) : "";
      const quality =
        score?.quality_score === null || score?.quality_score === undefined
          ? ""
          : score.quality_score.toFixed(3);
      return `| ${result.condition} | ${result.instanceID} | ${resolved} | ${f2p} | ${regressions} | ${quality} | [patch](${relPatch}) | [stats](${relStats}) | ${error} |`;
    }),
    "",
    "## Caveat",
    "",
    "This run uses SWE-bench tasks and grading as the substrate, but the context-stress setup is not leaderboard-comparable.",
    "",
  ];
  await fs.writeFile(path.join(outDir, "summary.md"), `${lines.join("\n")}\n`);
}

function timestampForPath(date: Date) {
  return date.toISOString().replaceAll(":", "").replaceAll(".", "-");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
