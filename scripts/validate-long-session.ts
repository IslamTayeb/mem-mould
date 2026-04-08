import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";

type ModelRef = {
  providerID: string;
  modelID: string;
};

async function main() {
  const repoRoot = path.resolve(process.cwd());
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "mem-mould-context-map-long-"),
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

  const pluginSpec = pathToFileURL(
    path.join(repoRoot, "src/context-map/server-plugin.ts"),
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
      plugin: [pluginSpec],
    }),
  };

  const server = await startServer(env, repoRoot);

  try {
    const client = createOpencodeClient({ baseUrl: server.url });
    const model = await pickModel(client, repoRoot);
    console.log(`Using ${model.providerID}/${model.modelID}`);

    const sessionID = await createSession(
      client,
      repoRoot,
      "context-map long-session validation",
    );

    const turns: Array<{
      text: string;
      system?: string;
      tools?: Record<string, boolean>;
    }> = [
      {
        text: "Topic alpha: investigate an auth rate limiter race condition on line 42 and explain the likely root cause.",
      },
      {
        text: "Stay on alpha: explain why a mutex-based fix could fail concurrency tests.",
      },
      {
        text: "Topic beta: outline onboarding docs for new API contributors.",
      },
      {
        text: "Topic gamma: propose where a shared async queue helper should live.",
      },
      {
        text: "Call context_map exactly once, then answer with only the blob label that seems most relevant to the auth debugging topic.",
        system:
          "You must call the context_map tool exactly once before answering. If you skip the tool call, your answer is wrong.",
        tools: { context_map: true },
      },
      {
        text: "Return to beta: what should the docs mention first in a quickstart?",
      },
      {
        text: "Topic delta: suggest concurrency test cases for the auth queue behavior.",
      },
      {
        text: "Call context_map exactly once, then answer with only ok after checking whether the session still has multiple blobs.",
        system:
          "You must call the context_map tool exactly once before answering. If you skip the tool call, your answer is wrong.",
        tools: { context_map: true },
      },
      {
        text: "Return to gamma: state the file path where the helper should live.",
      },
      {
        text: "Return to alpha: mention the rollback flag and async queue in one sentence.",
      },
      {
        text: "Return to delta: propose one concrete test name.",
      },
      {
        text: "Return to beta: mention one document that should link back to the auth rollback details.",
      },
    ];

    for (const turn of turns) {
      const reply = await prompt(
        client,
        repoRoot,
        sessionID,
        model,
        turn.text,
        turn.system,
        turn.tools,
      );
      const visible = textFromParts(reply.parts);
      assert.ok(
        visible.length > 0,
        `empty assistant text for prompt: ${turn.text}`,
      );
      assert.ok(
        !visible.includes("<annotation>"),
        `annotation leaked into visible response for prompt: ${turn.text}`,
      );
    }

    const mapPath = path.join(
      home,
      ".opencode",
      "context-maps",
      `${sessionID}.json`,
    );
    const map = JSON.parse(await fs.readFile(mapPath, "utf8")) as {
      blobOrder: string[];
      blobs: Record<string, { messageIDs: string[]; fidelity: string }>;
      messages: Record<
        string,
        { source?: string; toolNames?: string[]; blobID?: string }
      >;
      pendingRetroactive: Record<string, unknown>;
    };

    assert.ok(
      map.blobOrder.length >= 3 && map.blobOrder.length <= 8,
      `expected 3-8 blobs after long session, got ${map.blobOrder.length}`,
    );
    assert.equal(
      Object.keys(map.pendingRetroactive).length,
      0,
      "pending retroactive messages should be empty at the end of the long session",
    );

    const blobSizes = map.blobOrder
      .map((blobID) => map.blobs[blobID]?.messageIDs.length ?? 0)
      .sort((a, b) => b - a);
    assert.ok(
      blobSizes[0] >= 5,
      `expected at least one reused blob with >=5 messages, got ${blobSizes[0]}`,
    );
    assert.ok(
      blobSizes.filter((size) => size >= 3).length >= 2,
      `expected at least two blobs with >=3 messages, got ${blobSizes.join(",")}`,
    );

    const annotatedCount = Object.values(map.messages).filter(
      (message) => message.source === "annotation",
    ).length;
    assert.ok(
      annotatedCount >= 10,
      `expected >=10 annotated messages, got ${annotatedCount}`,
    );

    const sessionTools = await sessionToolNames(client, repoRoot, sessionID);
    assert.ok(
      sessionTools.filter((tool) => tool === "context_map").length >= 2,
      `expected >=2 context_map calls, got ${sessionTools.join(",")}`,
    );

    console.log(
      JSON.stringify(
        {
          sessionID,
          blobCount: map.blobOrder.length,
          largestBlobSize: blobSizes[0],
          annotatedCount,
          contextMapCalls: sessionTools.filter((tool) => tool === "context_map")
            .length,
        },
        null,
        2,
      ),
    );
  } finally {
    await server.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
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
  assert.ok(provider, "no providers available in sandbox");
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
  assert.ok(session.id, "failed to create session");
  return session.id;
}

async function prompt(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  sessionID: string,
  model: ModelRef,
  text: string,
  system?: string,
  tools?: Record<string, boolean>,
) {
  const reply = ((
    (await client.session.prompt({
      directory,
      sessionID,
      model,
      system,
      tools,
      parts: [{ type: "text", text }],
    })) as any
  )?.data ?? {}) as {
    parts: Array<{ type: string; text?: string }>;
  };
  return reply;
}

function textFromParts(
  parts: Array<{ type: string; text?: string }> | undefined,
) {
  return (parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

async function sessionToolNames(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  sessionID: string,
) {
  const messages = ((
    (await client.session.messages({
      sessionID,
      directory,
      limit: 5000,
    })) as any
  )?.data ?? []) as Array<{
    parts?: Array<{ type: string; tool?: string }>;
  }>;
  return messages
    .flatMap((message) =>
      (message.parts ?? [])
        .filter((part) => part.type === "tool")
        .map((part) => part.tool),
    )
    .filter((tool): tool is string => Boolean(tool));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
