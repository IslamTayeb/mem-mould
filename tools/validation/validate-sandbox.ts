import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";

import { parseModelSlug, requiredModelSlug, type ModelRef } from "../model";

const execFileAsync = promisify(execFile);

type SessionMessage = {
  info?: {
    id?: string;
    role?: string;
    finish?: string;
    providerID?: string;
    modelID?: string;
  };
  role?: string;
  parts?: Array<{
    type: string;
    text?: string;
    tool?: string;
    state?: { status?: string; input?: unknown; output?: unknown };
  }>;
};

const validationModelSlug = requiredModelSlug();

async function main() {
  const repoRoot = path.resolve(process.cwd());
  const providedTempRoot = process.env.MEM_MOULD_E2E_TEMP_ROOT;
  const tempRoot =
    providedTempRoot ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "mem-mould-context-map-")));
  if (providedTempRoot) await fs.mkdir(tempRoot, { recursive: true });
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

  const pluginSpec = pathToFileURL(
    path.join(repoRoot, "src/server-plugin.ts"),
  ).href;
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: cache,
    OPENCODE_DB: path.join(tempRoot, "opencode.sqlite"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    MEM_MOULD_DISABLE_GIT_HOOK_INSTALL: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: validationModelSlug,
      plugin: [pluginSpec],
    }),
  };

  const server = await startServer(env, repoRoot);

  let passed = false;
  try {
    const client = createOpencodeClient({ baseUrl: server.url });
    const model = await pickModel(client, repoRoot, validationModelSlug);
    console.log(`Using selected model ${model.providerID}/${model.modelID}`);

    const toolList = ((
      (await client.tool.list({
        directory: repoRoot,
        provider: model.providerID,
        model: model.modelID,
      })) as any
    )?.data ?? []) as Array<{ id: string }>;
    const toolIDs = new Set(toolList.map((tool) => tool.id));
    for (const required of [
      "view_context",
      "set_fidelity",
      "session_lookup",
      "session_detail",
      "message_detail",
      "blame_lookup",
    ]) {
      assert.ok(toolIDs.has(required), `missing tool ${required}`);
    }

    const firstSession = await createSession(
      client,
      repoRoot,
      "context-map integration",
    );
    await prompt(
      client,
      repoRoot,
      firstSession,
      "Investigate an auth rate limiter race condition on line 42 and explain why an async queue may be safer than a mutex.",
    );
    await prompt(
      client,
      repoRoot,
      firstSession,
      "Now switch topics and outline onboarding docs for API contributors.",
    );
    const returnReply = await prompt(
      client,
      repoRoot,
      firstSession,
      "Return to the auth topic and mention the failed mutex attempt.",
    );
    const returnText = textFromParts(returnReply.parts);
    if (returnText.length === 0) {
      await dumpSessionDiagnostics(client, repoRoot, firstSession, home);
    }
    assert.ok(returnText.length > 0, "assistant returned no visible text");
    assert.ok(
      !returnText.includes("<annotation>"),
      "annotation block leaked into visible assistant text",
    );

    const mapRoot = path.join(home, ".opencode", "context-maps");
    const mapPath = path.join(mapRoot, `${firstSession}.json`);
    const map = JSON.parse(await fs.readFile(mapPath, "utf8")) as {
      blobOrder: string[];
      blobs: Record<string, { id: string; fidelity: string; summary: string }>;
      messages: Record<
        string,
        { source?: string; blobID?: string; toolNames?: string[] }
      >;
      pendingRetroactive: Record<string, unknown>;
    };
    assert.ok(
      map.blobOrder.length >= 2,
      "expected at least two blobs in the map",
    );
    assert.ok(
      Object.keys(map.messages).length >= 3,
      "expected multiple mapped messages",
    );

    const authBlobID =
      map.blobOrder.find((blobID) => blobID.includes("auth")) ??
      map.blobOrder[0];
    const docsBlobID =
      map.blobOrder.find((blobID) => blobID.includes("doc")) ??
      map.blobOrder[1];
    assert.ok(authBlobID, "missing auth-like blob");
    assert.ok(docsBlobID, "missing docs-like blob");

    const contextToolReply = await prompt(
      client,
      repoRoot,
      firstSession,
      "Call view_context exactly once, then answer with only the session_id value from the tool output.",
      "You must call the view_context tool exactly once before answering. If you skip the tool call, your answer is wrong. Avoid unrelated tools.",
      { view_context: true },
    );
    assert.ok(
      (await sessionToolNames(client, repoRoot, firstSession)).includes(
        "view_context",
      ),
      "model did not call view_context",
    );
    const postContextToolMap = JSON.parse(
      await fs.readFile(mapPath, "utf8"),
    ) as typeof map;
    assert.equal(
      Object.keys(postContextToolMap.pendingRetroactive).length,
      0,
      "pending retroactive messages should be cleared after a tool-assisted text reply",
    );

    const compressReply = await prompt(
      client,
      repoRoot,
      firstSession,
      `Call set_fidelity exactly once with blob_id ${docsBlobID} and fidelity placeholder, then answer with only ok.`,
      "You must call the set_fidelity tool exactly once before answering. If you skip the tool call, your answer is wrong. Avoid unrelated tools.",
      { set_fidelity: true },
    );
    assert.ok(
      (await sessionToolNames(client, repoRoot, firstSession)).includes(
        "set_fidelity",
      ),
      "model did not call set_fidelity",
    );
    const updatedMap = JSON.parse(
      await fs.readFile(mapPath, "utf8"),
    ) as typeof map;
    assert.equal(
      updatedMap.blobs[docsBlobID!]?.fidelity,
      "placeholder",
      "set_fidelity did not persist blob fidelity",
    );

    const secondSession = await createSession(
      client,
      repoRoot,
      "context-map historical lookup",
    );
    const lookupReply = await prompt(
      client,
      repoRoot,
      secondSession,
      `Call session_lookup exactly once to find the earlier auth investigation session for ${authBlobID}, then call session_detail exactly once on the matching blob with detail summary, then answer with one fact.`,
      "You must call session_lookup exactly once and session_detail exactly once before answering. If you skip either tool call, your answer is wrong. Avoid unrelated tools.",
      { session_lookup: true, session_detail: true },
    );
    const lookupTools = await sessionToolNames(client, repoRoot, secondSession);
    assert.ok(
      lookupTools.includes("session_lookup"),
      "model did not call session_lookup",
    );
    assert.ok(
      lookupTools.includes("session_detail"),
      "model did not call session_detail",
    );

    const blameHash = await blameHashForLine(repoRoot, "README.md", 1);
    await fs.mkdir(mapRoot, { recursive: true });
    await fs.writeFile(
      path.join(mapRoot, "_commits.json"),
      JSON.stringify(
        {
          version: 1,
          updatedAt: Date.now(),
          entries: {
            [blameHash]: {
              commitHash: blameHash,
              sessionID: firstSession,
              timestamp: Date.now(),
              directory: repoRoot,
              worktree: repoRoot,
              activeBlobID: authBlobID,
              activeBlobLabel: authBlobID,
              activeBlobIDs: authBlobID ? [authBlobID] : [],
            },
          },
        },
        null,
        2,
      ),
    );

    const thirdSession = await createSession(
      client,
      repoRoot,
      "context-map blame lookup",
    );
    const blameReply = await prompt(
      client,
      repoRoot,
      thirdSession,
      "Call blame_lookup exactly once on README.md line 1. From the returned overview.blobs compressed summaries, choose the matching blob. Then call session_detail exactly once on that blob with detail messages. From those per-message summaries, choose one relevant message_id and call message_detail exactly once. Then answer with only the mapped session id.",
      "You must call blame_lookup, then session_detail with detail='messages', then message_detail before answering. If you skip any step, your answer is wrong. Avoid unrelated tools.",
      { blame_lookup: true, session_detail: true, message_detail: true },
    );
    const blameToolCalls = await sessionToolCalls(
      client,
      repoRoot,
      thirdSession,
    );
    assert.ok(
      hasToolCall(blameToolCalls, "blame_lookup"),
      "model did not call blame_lookup",
    );
    assert.ok(
      hasToolCall(blameToolCalls, "session_detail"),
      "model did not call session_detail after blame_lookup",
    );
    assert.ok(
      hasToolCall(blameToolCalls, "message_detail"),
      "model did not call message_detail after session_detail messages",
    );
    assert.ok(
      blameToolCalls.some(
        (call) =>
          call.tool === "session_detail" &&
          toolInputValue(call, "detail") === "messages",
      ),
      "model did not request session_detail detail='messages'",
    );
    assert.ok(
      blameToolCalls.some(
        (call) =>
          call.tool === "message_detail" &&
          typeof toolInputValue(call, "message_id") === "string",
      ),
      "model did not request a full historical message by message_id",
    );

    passed = true;
    console.log("Sandbox validation passed");
  } finally {
    await server.close();
    if (
      passed &&
      !providedTempRoot &&
      process.env.MEM_MOULD_KEEP_E2E_TEMP !== "1"
    ) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    } else {
      console.error(`Preserved E2E temp root: ${tempRoot}`);
    }
  }
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

async function createSession(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  title: string,
) {
  const session = (((await client.session.create({ directory, title })) as any)
    ?.data ?? {}) as { id: string };
  assert.ok(session.id, "failed to create session");
  return session.id;
}

async function prompt(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  sessionID: string,
  text: string,
  system?: string,
  tools?: Record<string, boolean>,
) {
  const before = await listSessionMessages(client, directory, sessionID);
  const beforeIDs = new Set(before.map((message) => message.info?.id));
  const raw = (await client.session.promptAsync({
    directory,
    sessionID,
    system,
    tools,
    parts: [{ type: "text", text }],
  })) as any;
  const reply = raw?.data ?? raw ?? {};
  if (reply.error) throw new Error(JSON.stringify(reply.error));
  const assistant = await waitForAssistantMessage(
    client,
    directory,
    sessionID,
    beforeIDs,
  );
  return { parts: assistant?.parts ?? [] };
}

async function waitForAssistantMessage(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  sessionID: string,
  beforeIDs: Set<string | undefined>,
) {
  const deadline = Date.now() + 300_000;
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

async function dumpSessionDiagnostics(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  sessionID: string,
  home: string,
) {
  const messages = await listSessionMessages(client, directory, sessionID);
  console.error("Session diagnostics:");
  for (const message of messages.slice(-6)) {
    const text = textFromParts(message.parts).slice(0, 300);
    const tools = toolParts(message.parts)
      .map((part) => part.tool)
      .join(",");
    console.error(
      JSON.stringify({
        id: message.info?.id,
        role: message.info?.role,
        providerID: message.info?.providerID,
        modelID: message.info?.modelID,
        text,
        tools,
        partTypes: (message.parts ?? []).map((part) => part.type),
      }),
    );
  }
  const tracePath = path.join(
    home,
    ".opencode",
    "context-maps",
    `${sessionID}.trace.jsonl`,
  );
  const trace = await fs.readFile(tracePath, "utf8").catch(() => "");
  if (trace) {
    console.error("Trace tail:");
    for (const line of trace.trim().split("\n").slice(-6)) console.error(line);
  }
}

function textFromParts(
  parts: Array<{ type: string; text?: string }> | undefined,
) {
  return (parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function toolParts(
  parts:
    | Array<{
        type: string;
        tool?: string;
        state?: { status?: string; input?: unknown; output?: unknown };
      }>
    | undefined,
) {
  return (parts ?? []).filter((part) => part.type === "tool");
}

async function sessionToolCalls(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  sessionID: string,
) {
  const messages = await listSessionMessages(client, directory, sessionID);
  return messages.flatMap((message) =>
    toolParts(message.parts)
      .filter((part): part is typeof part & { tool: string } =>
        Boolean(part.tool),
      )
      .map((part) => ({
        tool: part.tool,
        input: part.state?.input,
        output: part.state?.output,
      })),
  );
}

function hasToolCall(
  calls: Array<{ tool: string; input?: unknown; output?: unknown }>,
  tool: string,
) {
  return calls.some((call) => call.tool === tool);
}

function toolInputValue(call: { input?: unknown }, key: string) {
  const input = call.input;
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  return (input as Record<string, unknown>)[key];
}

async function sessionToolNames(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  sessionID: string,
) {
  const messages = await listSessionMessages(client, directory, sessionID);
  return messages
    .flatMap((message) => toolParts(message.parts).map((part) => part.tool))
    .filter((tool): tool is string => Boolean(tool));
}

async function blameHashForLine(cwd: string, file: string, line: number) {
  const { stdout } = await execFileAsync(
    "git",
    ["blame", "-L", `${line},${line}`, "--", file],
    { cwd },
  );
  const hash = stdout.trim().split(/\s+/)[0];
  assert.ok(hash, `failed to resolve blame hash for ${file}:${line}`);
  return hash;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
