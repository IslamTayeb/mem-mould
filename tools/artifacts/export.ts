import fs from "node:fs/promises";
import path from "node:path";

type Manifest = {
  generatedAt: string;
  sourceRoot: string;
  artifactRoot: string;
  copiedFiles: number;
  skippedFiles: Array<{ path: string; reason: string }>;
  runs: Array<{
    benchmark: string;
    run: string;
    source: string;
    destination: string;
    copiedFiles: number;
  }>;
};

const repoRoot = path.resolve(process.cwd());
const artifactRoot = path.join(repoRoot, "artifacts", "benchmark-runs");
const benchmarkRuns = [
  path.join("benchmarks", "code-memory", "runs"),
  path.join("benchmarks", "context-canaries", "runs"),
  path.join("benchmarks", "provenance-qa", "runs"),
  path.join("benchmarks", "swebench-context", "runs"),
];

const publishedRuns = new Map([
  [
    "code-memory",
    new Set(["gpt55-ablation-combined", "gpt55-secondary-missing-20260515"]),
  ],
  [
    "context-canaries",
    new Set(["bedrock-opus46-all-hypotheses", "gpt55-all-hypotheses"]),
  ],
  [
    "provenance-qa",
    new Set([
      "gpt55-blog-full-matrix-final",
      "gpt55-parent-gpt54mini-child-subagents-fixed",
      "gpt55-rlm-hybrid",
    ]),
  ],
  [
    "swebench-context",
    new Set([
      "gpt55-cache-stable-boundary-final",
      "gpt55-cache-stable-hard-primary",
      "gpt55-secondary-missing-20260515",
    ]),
  ],
]);

const pathNameMap = new Map([
  [
    "scripts/benchmark-context-canaries.ts",
    "benchmarks/context-canaries/run.ts",
  ],
  [
    "scripts/benchmark-provenance-blog.ts",
    "benchmarks/provenance-qa/blog-run.ts",
  ],
  ["scripts/benchmark-provenance-qa.ts", "benchmarks/provenance-qa/run.ts"],
  [
    "scripts/benchmark-swebench-context.ts",
    "benchmarks/swebench-context/run.ts",
  ],
  ["scripts/evaluate-compaction.ts", "tools/validation/evaluate-compaction.ts"],
  ["scripts/export-benchmark-artifacts.ts", "tools/artifacts/export.ts"],
  [
    "scripts/generate-test-fixtures.ts",
    "tools/fixtures/generate-test-fixtures.ts",
  ],
  ["scripts/inspect-context.ts", "tools/inspect-context.ts"],
  ["scripts/setup-test-env.ts", "tools/fixtures/setup-test-env.ts"],
  [
    "scripts/validate-long-session.ts",
    "tools/validation/validate-long-session.ts",
  ],
  ["scripts/validate-sandbox.ts", "tools/validation/validate-sandbox.ts"],
]);

const skippedDirectoryNames = new Set([
  ".git",
  "node_modules",
  "opencode-root",
  "worktree",
]);

const skippedFileNames = new Set([
  "opencode.sqlite",
  "opencode.sqlite-shm",
  "opencode.sqlite-wal",
]);

const maxPortableFileBytes = 5 * 1024 * 1024;

const textExtensions = new Set([
  ".csv",
  ".diff",
  ".json",
  ".jsonl",
  ".md",
  ".svg",
  ".txt",
]);

const redactedJsonKeys = new Set(["reasoningEncryptedContent"]);

async function main() {
  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    sourceRoot: ".",
    artifactRoot: path.relative(repoRoot, artifactRoot),
    copiedFiles: 0,
    skippedFiles: [],
    runs: [],
  };

  await fs.rm(artifactRoot, { recursive: true, force: true });
  await fs.mkdir(artifactRoot, { recursive: true });

  for (const relativeRunsDir of benchmarkRuns) {
    const runsDir = path.join(repoRoot, relativeRunsDir);
    const benchmark = path.basename(path.dirname(runsDir));
    const publishableRuns = publishedRuns.get(benchmark) ?? new Set<string>();
    const runNames = (await directoryNames(runsDir)).filter((run) =>
      publishableRuns.has(run),
    );
    for (const run of runNames) {
      const source = path.join(runsDir, run);
      const destination = path.join(
        artifactRoot,
        benchmark,
        normalizePathSegment(run),
      );
      const before = manifest.copiedFiles;
      await copyPortableArtifacts(source, destination, source, manifest);
      const copiedFiles = manifest.copiedFiles - before;
      if (copiedFiles === 0) continue;
      manifest.runs.push({
        benchmark,
        run,
        source: path.relative(repoRoot, source),
        destination: path.relative(repoRoot, destination),
        copiedFiles,
      });
    }
  }

  await fs.writeFile(
    path.join(artifactRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  console.log(
    `Exported ${manifest.copiedFiles} files from ${manifest.runs.length} runs to ${path.relative(repoRoot, artifactRoot)}`,
  );
  if (manifest.skippedFiles.length > 0) {
    console.log(
      `Skipped ${manifest.skippedFiles.length} raw or oversized files`,
    );
  }
}

async function directoryNames(dir: string) {
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function copyPortableArtifacts(
  source: string,
  destination: string,
  runRoot: string,
  manifest: Manifest,
) {
  const entries = await fs
    .readdir(source, { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(
      destination,
      normalizePathSegment(entry.name),
    );
    if (entry.isDirectory()) {
      if (skippedDirectoryNames.has(entry.name)) {
        if (entry.name === "worktree") {
          await copyPortableWorktreeMemory(
            sourcePath,
            destinationPath,
            runRoot,
            manifest,
          );
        }
        skip(manifest, runRoot, sourcePath, "raw runtime directory");
        continue;
      }
      await copyPortableArtifacts(
        sourcePath,
        destinationPath,
        runRoot,
        manifest,
      );
      continue;
    }
    if (!entry.isFile()) continue;
    if (skippedFileNames.has(entry.name)) {
      skip(manifest, runRoot, sourcePath, "raw OpenCode database");
      continue;
    }
    const stat = await fs.stat(sourcePath);
    if (stat.size > maxPortableFileBytes) {
      skip(
        manifest,
        runRoot,
        sourcePath,
        "oversized portable artifact candidate",
      );
      continue;
    }
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    if (shouldNormalizeText(sourcePath)) {
      const content = await fs.readFile(sourcePath, "utf8");
      await fs.writeFile(
        destinationPath,
        portableTextContent(sourcePath, content),
      );
    } else {
      await fs.copyFile(sourcePath, destinationPath);
    }
    manifest.copiedFiles++;
  }
}

async function copyPortableWorktreeMemory(
  worktreePath: string,
  destinationPath: string,
  runRoot: string,
  manifest: Manifest,
) {
  const memoryPath = path.join(worktreePath, "memory");
  const stat = await fs.stat(memoryPath).catch(() => undefined);
  if (!stat?.isDirectory()) return;
  await copyPortableArtifacts(
    memoryPath,
    path.join(destinationPath, "memory"),
    runRoot,
    manifest,
  );
}

function skip(
  manifest: Manifest,
  runRoot: string,
  filePath: string,
  reason: string,
) {
  manifest.skippedFiles.push({
    path: normalizeRelativePath(path.relative(runRoot, filePath)),
    reason,
  });
}

function shouldNormalizeText(filePath: string) {
  return textExtensions.has(path.extname(filePath));
}

function portableTextContent(filePath: string, content: string) {
  const ext = path.extname(filePath);
  if (ext === ".json") {
    try {
      return `${normalizeReferences(JSON.stringify(redactJson(JSON.parse(content)), null, 2))}\n`;
    } catch {
      return normalizeReferences(content);
    }
  }
  if (ext === ".jsonl") {
    const lines = content.split("\n");
    const normalized = lines.map((line) => {
      if (line.trim() === "") return line;
      try {
        return normalizeReferences(
          JSON.stringify(redactJson(JSON.parse(line))),
        );
      } catch {
        return normalizeReferences(line);
      }
    });
    return normalized.join("\n");
  }
  return normalizeReferences(content);
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactJson(item));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (redactedJsonKeys.has(key)) continue;
    output[key] = redactJson(item);
  }
  return output;
}

function normalizePathSegment(segment: string) {
  return normalizeReferences(segment);
}

function normalizeRelativePath(relativePath: string) {
  return relativePath
    .split(path.sep)
    .map((segment) => normalizePathSegment(segment))
    .join("/");
}

function normalizeReferences(value: string) {
  let next = value.replaceAll(repoRoot, ".");
  for (const [oldName, newName] of pathNameMap) {
    next = next.replaceAll(oldName, newName);
  }
  return next;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
