import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";

import { buildCompactionPrompt } from "../src/context-map/core";
import type { ContextMapFile } from "../src/context-map/types";

const DEFAULT_COMPACTION_PROMPT = `Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.
The summary that you construct will be used so that another agent can read it and continue the work.
Do not call any tools. Respond only with the summary text.

When constructing the summary, try to stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---`;

type ModelRef = {
  providerID: string;
  modelID: string;
};

const validationModelSlug = process.env.MEM_MOULD_E2E_MODEL ?? "openai/gpt-5.5";

async function main() {
  const repoRoot = path.resolve(process.cwd());
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "mem-mould-compaction-"),
  );
  const home = path.join(tempRoot, "home");
  const data = path.join(tempRoot, "data");
  const config = path.join(tempRoot, "config");
  const state = path.join(tempRoot, "state");
  const cache = path.join(tempRoot, "cache");
  await Promise.all(
    [home, data, config, state, cache].map((dir) =>
      fs.mkdir(dir, { recursive: true }),
    ),
  );

  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: cache,
    OPENCODE_DB: path.join(tempRoot, "opencode.sqlite"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: validationModelSlug,
    }),
  };

  const server = await startServer(env, repoRoot);

  try {
    const client = createOpencodeClient({ baseUrl: server.url });
    const model = await pickModel(client, repoRoot, validationModelSlug);
    console.log(`Using selected model ${model.providerID}/${model.modelID}`);

    const transcript = buildTranscript();
    const map = buildSyntheticMap();
    const mapPrompt = buildCompactionPrompt(map);

    const defaultSummary = await summarize(
      client,
      repoRoot,
      transcript,
      DEFAULT_COMPACTION_PROMPT,
    );
    const mapSummary = await summarize(client, repoRoot, transcript, mapPrompt);

    const defaultRecall = await recall(client, repoRoot, defaultSummary);
    const mapRecall = await recall(client, repoRoot, mapSummary);

    const defaultScore = scoreRecall(defaultRecall);
    const mapScore = scoreRecall(mapRecall);
    const defaultDocsMention = mentionsDocsChatter(defaultSummary);
    const mapDocsMention = mentionsDocsChatter(mapSummary);

    console.log(
      JSON.stringify(
        {
          defaultScore,
          mapScore,
          defaultLength: defaultSummary.length,
          mapLength: mapSummary.length,
          defaultDocsMention,
          mapDocsMention,
          defaultRecall,
          mapRecall,
        },
        null,
        2,
      ),
    );
    assert.ok(
      mapScore >= defaultScore,
      `expected map-guided score >= default score (${mapScore} < ${defaultScore})`,
    );
  } finally {
    await server.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function buildTranscript() {
  const docsNoise = Array.from(
    { length: 18 },
    (_, index) =>
      `Assistant: renamed docs heading variant ${index + 1} from "Setup" to "Quickstart".`,
  ).join("\n");
  return [
    "User: Diagnose the auth rate limiter race condition and preserve the real fix details.",
    "Assistant: Opened rate_limiter.ts and found the race at rate_limiter.ts:42 in the token refresh path.",
    "User: Try a mutex first, but keep note of whether the tests fail.",
    "Assistant: Implemented a mutex guard and the concurrent auth tests failed immediately.",
    "Assistant: Key fact: the mutex approach failed tests under concurrent load.",
    "User: Move on from the mutex and use the async queue approach instead.",
    "Assistant: Replaced the mutex with an async queue and kept the rollback gate FLAG_AUTH_QUEUE_ROLLBACK.",
    "Assistant: Key fact: final fix uses an async queue and rollback stays behind FLAG_AUTH_QUEUE_ROLLBACK.",
    "User: Also clean up onboarding docs while you are here.",
    docsNoise,
    "User: Extract the queue helper into a shared module so auth middleware can reuse it.",
    "Assistant: Extracted the queue helper into src/auth/queue.ts for reuse.",
    "Assistant: Key fact: shared helper lives in src/auth/queue.ts.",
  ].join("\n");
}

function buildSyntheticMap(): ContextMapFile {
  const now = Date.now();
  return {
    version: 1,
    sessionID: "synthetic",
    createdAt: now,
    updatedAt: now,
    totalTokenEstimate: 4000,
    lastActiveBlobID: "refactor_queue_helper",
    settings: {
      placeholderIncludesKeyFacts: true,
      placeholderIncludesKeyFactsSource: "user",
      toolHistoryCleanup: true,
      stablePlaceholders: false,
      stablePlaceholdersSource: "default",
      stableAnchors: false,
      stableAnchorsSource: "default",
    },
    blobOrder: ["auth_debugging", "docs_chatter", "refactor_queue_helper"],
    blobs: {
      auth_debugging: {
        id: "auth_debugging",
        label: "auth_debugging",
        summary:
          "Investigated the auth rate limiter race at rate_limiter.ts:42. The mutex attempt failed tests, so the final fix switched to an async queue and kept rollback under FLAG_AUTH_QUEUE_ROLLBACK.",
        placeholder: "Auth race condition and queue fix",
        keyFacts: [
          "rate_limiter.ts:42",
          "mutex failed tests",
          "async queue final fix",
          "FLAG_AUTH_QUEUE_ROLLBACK",
        ],
        fidelity: "full",
        fidelitySource: "user",
        messageIDs: ["m1", "m2", "m3"],
        tokenEstimate: 1800,
        createdAt: now,
        lastActiveAt: now,
        commitHashes: [],
      },
      docs_chatter: {
        id: "docs_chatter",
        label: "docs_chatter",
        summary: "Repeated onboarding docs heading cleanup and wording tweaks.",
        placeholder: "Docs heading cleanup chatter",
        keyFacts: ["docs cleanup low priority"],
        fidelity: "drop",
        fidelitySource: "user",
        messageIDs: ["m4"],
        tokenEstimate: 1600,
        createdAt: now,
        lastActiveAt: now,
        commitHashes: [],
      },
      refactor_queue_helper: {
        id: "refactor_queue_helper",
        label: "refactor_queue_helper",
        summary:
          "Extracted the async queue helper into src/auth/queue.ts for reuse.",
        placeholder: "Extracted shared queue helper",
        keyFacts: ["src/auth/queue.ts"],
        fidelity: "compressed",
        fidelitySource: "user",
        messageIDs: ["m5"],
        tokenEstimate: 600,
        createdAt: now,
        lastActiveAt: now,
        commitHashes: [],
      },
    },
    messages: {},
    pendingRetroactive: {},
  };
}

async function summarize(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  transcript: string,
  prompt: string,
) {
  const session = ((
    (await client.session.create({
      directory,
      title: "compaction-eval",
    })) as any
  )?.data ?? {}) as { id: string };
  const reply = ((
    (await client.session.prompt({
      directory,
      sessionID: session.id,
      system:
        "You are compacting a coding-agent conversation. Do not call tools. Output only the compacted summary text.",
      tools: {},
      parts: [
        {
          type: "text",
          text: `Conversation transcript:\n${transcript}\n\nCompaction instructions:\n${prompt}`,
        },
      ],
    })) as any
  )?.data ?? {}) as { parts: Array<{ type: string; text?: string }> };
  return reply.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

async function recall(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  summary: string,
) {
  const session = ((
    (await client.session.create({
      directory,
      title: "compaction-recall",
    })) as any
  )?.data ?? {}) as { id: string };
  const reply = ((
    (await client.session.prompt({
      directory,
      sessionID: session.id,
      system:
        "You are evaluating a compaction summary. Answer in strict JSON with keys race_location, failed_fix, final_fix, rollback_flag, queue_helper_path. Use null if the summary does not preserve the fact.",
      tools: {},
      parts: [{ type: "text", text: `Summary:\n${summary}` }],
    })) as any
  )?.data ?? {}) as { parts: Array<{ type: string; text?: string }> };

  const text = reply.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  return JSON.parse(extractJson(text)) as Record<string, string | null>;
}

function scoreRecall(recall: Record<string, string | null>) {
  let score = 0;
  if ((recall.race_location ?? "").includes("rate_limiter.ts:42")) score += 1;
  if ((recall.failed_fix ?? "").toLowerCase().includes("mutex")) score += 1;
  if ((recall.final_fix ?? "").toLowerCase().includes("async queue"))
    score += 1;
  if ((recall.rollback_flag ?? "").includes("FLAG_AUTH_QUEUE_ROLLBACK"))
    score += 1;
  if ((recall.queue_helper_path ?? "").includes("src/auth/queue.ts"))
    score += 1;
  return score;
}

function mentionsDocsChatter(summary: string) {
  return /quickstart|onboarding docs|heading/i.test(summary);
}

function extractJson(text: string) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) return fence[1]!;
  return text.trim();
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
  modelSlug: string,
): Promise<ModelRef> {
  const requested = parseModelSlug(modelSlug);
  const providers = (((await client.provider.list({ directory })) as any)
    ?.data ?? {}) as {
    all?: Array<{ id: string; models: Record<string, unknown> }>;
    connected?: string[];
  };
  const all = providers.all ?? [];
  const provider = all.find((item) => item.id === requested.providerID);
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

function parseModelSlug(modelSlug: string): ModelRef {
  const index = modelSlug.indexOf("/");
  assert.ok(index > 0, `model must be provider/model, got: ${modelSlug}`);
  return {
    providerID: modelSlug.slice(0, index),
    modelID: modelSlug.slice(index + 1),
  };
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
