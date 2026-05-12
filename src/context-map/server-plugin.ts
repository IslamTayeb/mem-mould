import fs from "node:fs/promises";

import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";

import {
  applyAnnotationEnvelope,
  buildAnnotationSystemPrompt,
  buildBlobMessageSummaries,
  buildCompactionPrompt,
  buildContextMapToolView,
  buildHistoricalOverview,
  buildMessageDetail,
  buildPluginGuidanceSystemPrompt,
  buildSessionZoomText,
  computeEffectiveTreatment,
  capturePendingRetroactiveMessage,
  computeContextPreview,
  filterMessagesForActiveContext,
  getMessageCreatedAt,
  mergeContextMaps,
  matchBlobIDsForQuery,
  parseAnnotationBlock,
  resetMapAfterCompaction,
  sortMessagesChronologically,
  transformMessagesForContext,
  updateBlobFidelity,
} from "./core";
import { ensureContextMapGitHook } from "./git";
import {
  ensureContextMapRoot,
  readCommitMap,
  readContextMap,
  sessionMapPath,
  writeContextMap,
  writeDebugLog,
  appendTrace,
  archiveContextMapForCompaction,
} from "./storage";
import { buildFallbackMapFromMessages } from "./core";
import type {
  ContextMapFile,
  HistoricalSessionOverview,
  MessageLike,
  SessionLike,
} from "./types";

const PLUGIN_ID = "mem-mould.context-map";

function tracePayloadEnabled() {
  return ["1", "true", "yes", "on"].includes(
    (process.env.MEM_MOULD_TRACE_CONTEXT_PAYLOAD ?? "").toLowerCase(),
  );
}

function envFlag(name: string) {
  return ["1", "true", "yes", "on"].includes(
    (process.env[name] ?? "").toLowerCase(),
  );
}

function cacheStableModeEnabled() {
  return envFlag("MEM_MOULD_CACHE_STABLE");
}

function staticPluginGuidanceSystemPrompt() {
  return [
    "Context map plugin is active.",
    "Use view_context and set_fidelity only when older context is clearly stale or large enough to justify reshaping the prompt.",
    "User controls are authoritative: do not override user-set fidelity or hidden-message choices unless the user explicitly asks.",
  ].join("\n");
}

function partPayloadSnapshot(part: MessageLike["parts"][number]) {
  const base = {
    id: part.id,
    type: part.type,
  };
  if (part.type === "text") {
    return {
      ...base,
      text: part.text ?? "",
    };
  }
  if (part.type === "tool") {
    return {
      ...base,
      tool: part.tool,
      title: part.state?.title,
      status: part.state?.status,
      output: part.state?.output,
    };
  }
  return {
    ...base,
    filename: part.filename,
    url: part.url,
  };
}

function messagePayloadSnapshot(messages: MessageLike[], map: ContextMapFile) {
  return messages.map((message) => {
    const entry = map.messages[message.info.id];
    const blob = entry?.blobID ? map.blobs[entry.blobID] : undefined;
    return {
      id: message.info.id,
      role: message.info.role,
      blob_id: entry?.blobID,
      blob_label: blob?.label,
      blob_fidelity: blob?.fidelity,
      fidelity_override: entry?.fidelityOverride,
      effective_treatment: entry
        ? computeEffectiveTreatment(entry, blob)
        : "unassigned",
      parts: message.parts.map(partPayloadSnapshot),
    };
  });
}

function isCompactionSystemPrompt(system: string[]) {
  return system.some((text) =>
    text.includes(
      "You are an anchored context summarization assistant for coding sessions.",
    ),
  );
}

const server: Plugin = async (ctx) => {
  await ensureContextMapRoot().catch(() => undefined);
  if (process.env.MEM_MOULD_DISABLE_GIT_HOOK_INSTALL !== "1") {
    await ensureContextMapGitHook({
      $: ctx.$ as never,
      worktree: ctx.worktree,
      directory: ctx.directory,
    }).catch(() => undefined);
  }

  const childSessionCache = new Map<string, boolean>();
  const handledCompactions = new Set<string>();
  const compactingSessions = new Set<string>();

  async function responseData<Value>(
    promise: Promise<unknown>,
  ): Promise<Value> {
    const value = (await promise) as { data?: Value };
    return (value?.data ?? value) as Value;
  }

  async function getSession(sessionID: string) {
    return responseData<SessionLike>(
      ctx.client.session.get({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      } as never),
    );
  }

  async function listSessions() {
    return responseData<SessionLike[]>(
      ctx.client.session.list({ query: { directory: ctx.directory } } as never),
    );
  }

  async function getChildSessions(sessionID: string) {
    return responseData<SessionLike[]>(
      ctx.client.session.children({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      } as never),
    ).catch(() => []);
  }

  async function getMessages(sessionID: string, limit = 5000) {
    const rows = await responseData<MessageLike[]>(
      ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory, limit },
      } as never),
    );
    return sortMessagesChronologically(rows);
  }

  function textFromMessage(message: MessageLike) {
    return message.parts
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text?.trim())
      .filter(Boolean)
      .join("\n");
  }

  async function latestCompactionSummary(sessionID: string) {
    const messages = await getMessages(sessionID);
    const message = [...messages]
      .reverse()
      .find(
        (item) =>
          item.info.role === "assistant" &&
          item.info.summary === true &&
          textFromMessage(item),
      );
    if (!message) return undefined;
    return {
      messageID: message.info.id,
      text: textFromMessage(message),
      createdAt: getMessageCreatedAt(message),
    };
  }

  async function resetMapForCompaction(input: {
    sessionID: string;
    summaryText?: string;
    summaryMessageID?: string;
    compactedAt?: number;
    includeMessageID?: string;
  }) {
    if (!input.sessionID) return;
    if (await isChildSession(input.sessionID)) return;
    let summaryText = input.summaryText?.trim() ?? "";
    let summaryMessageID = input.summaryMessageID;
    let compactedAt = input.compactedAt;
    if (!summaryText || !summaryMessageID || !compactedAt) {
      const latest = await latestCompactionSummary(input.sessionID);
      summaryText ||= latest?.text ?? "";
      summaryMessageID ||= latest?.messageID;
      compactedAt ||= latest?.createdAt;
    }
    if (!summaryMessageID) return;
    summaryText ||= "Conversation compacted.";
    compactedAt ||= Date.now();

    const key = `${input.sessionID}:${summaryMessageID}`;
    if (handledCompactions.has(key)) return;
    handledCompactions.add(key);

    const map = await getMap(input.sessionID);
    if (map.compaction?.summaryMessageID === summaryMessageID) return;

    const archivePath = await archiveContextMapForCompaction({
      map,
      compactedAt,
      summaryMessageID,
      summaryText,
      includeMessageID: input.includeMessageID,
    });
    const reset = resetMapAfterCompaction({
      map,
      summaryText,
      summaryMessageID,
      compactedAt,
      includeMessageID: input.includeMessageID,
      archivePath,
      summaryFidelity: envFlag("MEM_MOULD_TASK_BOUNDARY")
        ? "placeholder"
        : undefined,
    });
    await writeContextMap(reset);
    const preview = computeContextPreview(reset);
    await writeDebugLog(reset, preview).catch(() => undefined);
    await appendTrace(input.sessionID, "session.compacted", {
      summary_message_id: summaryMessageID,
      include_message_id: input.includeMessageID,
      archive_path: archivePath,
      summary_length: summaryText.length,
    });
  }

  function findMessageForToolCall(messages: MessageLike[], callID: string) {
    return [...messages]
      .reverse()
      .find((message) =>
        message.parts.some(
          (part) => part.type === "tool" && part.callID === callID,
        ),
      );
  }

  async function getMap(sessionID: string, directory?: string) {
    const map = await readContextMap({
      sessionID,
      directory: directory ?? ctx.directory,
      worktree: ctx.worktree,
    });
    if (cacheStableModeEnabled() || envFlag("MEM_MOULD_STABLE_PLACEHOLDERS")) {
      map.settings.stablePlaceholders = true;
      map.settings.stablePlaceholdersSource = "system";
    }
    if (cacheStableModeEnabled() || envFlag("MEM_MOULD_STABLE_ANCHORS")) {
      map.settings.stableAnchors = true;
      map.settings.stableAnchorsSource = "system";
    }
    return map;
  }

  async function ensureHistoricalMap(sessionID: string) {
    const session = await getSession(sessionID);
    let map = await getMap(sessionID, session.directory);
    if (map.blobOrder.length > 0 || Object.keys(map.messages).length > 0)
      return { session, map };
    const messages = await getMessages(sessionID);
    if (messages.length === 0) return { session, map };
    map = buildFallbackMapFromMessages({
      sessionID,
      directory: session.directory,
      worktree: ctx.worktree,
      messages,
    });
    await writeContextMap(map);
    return { session, map };
  }

  async function isChildSession(sessionID: string) {
    if (childSessionCache.has(sessionID))
      return childSessionCache.get(sessionID)!;
    const session = await getSession(sessionID).catch(() => undefined);
    const child = Boolean(session && "parentID" in session && session.parentID);
    childSessionCache.set(sessionID, child);
    return child;
  }

  async function persistCoverage(sessionID: string, messages: MessageLike[]) {
    if (!sessionID || messages.length === 0) return undefined;
    const map = await getMap(sessionID);
    const activeMessages = filterMessagesForActiveContext(map, messages, {
      includeSummary: false,
    });
    if (activeMessages.length === 0) return map;
    const next = mergeContextMaps(
      map,
      buildFallbackMapFromMessages({
        sessionID,
        directory: ctx.directory,
        worktree: ctx.worktree,
        messages: activeMessages,
      }),
    );
    await writeContextMap(next);
    return next;
  }

  async function currentMapToolView(sessionID: string) {
    const messages = await getMessages(sessionID);
    const map =
      (await persistCoverage(sessionID, messages)) ?? (await getMap(sessionID));
    return buildContextMapToolView(map);
  }

  async function sessionLookup(query: string, limit: number) {
    const sessions = await listSessions();
    const lowered = query.trim().toLowerCase();
    const results: HistoricalSessionOverview[] = [];

    for (const session of sessions) {
      if (results.length >= limit) break;
      const titleMatch = (session.title ?? "").toLowerCase().includes(lowered);
      const hasMapFile = await fs
        .access(sessionMapPath(session.id))
        .then(() => true)
        .catch(() => false);

      if (!titleMatch && !hasMapFile) continue;

      const { map } = await ensureHistoricalMap(session.id);
      const matchedBlobIDs = titleMatch ? [] : matchBlobIDsForQuery(map, query);
      if (!titleMatch && matchedBlobIDs.length === 0) continue;
      results.push(buildHistoricalOverview({ map, session, matchedBlobIDs }));
    }

    return results;
  }

  async function sessionTree(
    sessionID: string,
    depth: number,
  ): Promise<Record<string, unknown>> {
    const session = await getSession(sessionID);
    const { map } = await ensureHistoricalMap(sessionID);
    const messages = await getMessages(sessionID).catch(() => []);
    const children = depth > 0 ? await getChildSessions(sessionID) : [];
    const childNodes = [];
    for (const child of children) {
      childNodes.push(await sessionTree(child.id, depth - 1));
    }

    return {
      session_id: session.id,
      title: session.title ?? session.id,
      parent_id: session.parentID,
      updated_at: session.time?.updated,
      blob_count: map.blobOrder.length,
      blobs: buildHistoricalOverview({ map, session }).blobs.map((blob) => ({
        id: blob.id,
        label: blob.label,
        compressed_summary: blob.compressedSummary,
        message_count: blob.messageCount,
        key_facts: blob.keyFacts,
      })),
      task_links: extractTaskLinks(messages),
      children: childNodes,
    };
  }

  function extractTaskLinks(messages: MessageLike[]) {
    return messages.flatMap((message) =>
      message.parts
        .filter((part) => part.type === "tool" && part.tool === "task")
        .map((part) => {
          const output =
            typeof part.state?.output === "string" ? part.state.output : "";
          const outputSessionID = output.match(/task_id:\s*(\S+)/)?.[1];
          return {
            message_id: message.info.id,
            tool_call_id: part.callID,
            description:
              typeof part.state?.input?.description === "string"
                ? part.state.input.description
                : undefined,
            subagent_type:
              typeof part.state?.input?.subagent_type === "string"
                ? part.state.input.subagent_type
                : undefined,
            child_session_id:
              typeof part.state?.metadata?.sessionId === "string"
                ? part.state.metadata.sessionId
                : outputSessionID,
          };
        }),
    );
  }

  async function blameLookup(file: string, line: number) {
    const blame = await ctx.$.cwd(
      ctx.worktree,
    ).nothrow()`git blame -L ${line},${line} -- ${file}`
      .quiet()
      .text();
    const commitHash = blame.trim().split(/\s+/)[0];
    if (!commitHash) {
      return {
        commit_hash: undefined,
        mapped: false,
        error: `Could not resolve git blame for ${file}:${line}`,
      };
    }

    const commits = await readCommitMap();
    const entry = commits.entries[commitHash];
    if (!entry) {
      return {
        commit_hash: commitHash,
        mapped: false,
        error: `No session mapping found for commit ${commitHash}.`,
      };
    }

    const { session, map } = await ensureHistoricalMap(entry.sessionID);
    return {
      commit_hash: commitHash,
      mapped: true,
      session_id: entry.sessionID,
      active_blob_id: entry.activeBlobID,
      active_blob_label: entry.activeBlobLabel,
      overview: buildHistoricalOverview({
        map,
        session,
        commitEntry: entry,
        matchedBlobIDs: entry.activeBlobID ? [entry.activeBlobID] : [],
      }),
      next_steps: [
        "Inspect overview.blobs[].compressedSummary to choose relevant blobs.",
        "Call session_detail with detail='messages' to see message summaries for a blob.",
        "Call message_detail with a message_id to fetch the full historical message only when needed.",
      ],
    };
  }

  async function applyMapFidelity(input: {
    sessionID: string;
    blobID: string;
    fidelity: Parameters<typeof updateBlobFidelity>[0]["fidelity"];
    source: Parameters<typeof updateBlobFidelity>[0]["source"];
    force?: boolean;
  }) {
    const map = await getMap(input.sessionID);
    const result = updateBlobFidelity({
      map,
      blobID: input.blobID,
      fidelity: input.fidelity,
      source: input.source,
      force: input.force,
    });
    if (result.ok) await writeContextMap(map);
    return { map, result };
  }

  return {
    event: async (input) => {
      const event = input.event as {
        id?: string;
        type?: string;
        properties?: Record<string, unknown>;
      };
      const properties = event.properties ?? {};
      if (event.type === "session.next.compaction.ended") {
        compactingSessions.delete(String(properties.sessionID ?? ""));
        await resetMapForCompaction({
          sessionID: String(properties.sessionID ?? ""),
          summaryText:
            typeof properties.text === "string" ? properties.text : undefined,
          compactedAt:
            typeof properties.timestamp === "number"
              ? properties.timestamp
              : undefined,
          includeMessageID:
            typeof properties.include === "string"
              ? properties.include
              : undefined,
        });
      }
      if (event.type === "session.compacted") {
        compactingSessions.delete(String(properties.sessionID ?? ""));
        await resetMapForCompaction({
          sessionID: String(properties.sessionID ?? ""),
        });
      }
      if (event.type === "session.error" || event.type === "session.idle") {
        compactingSessions.delete(String(properties.sessionID ?? ""));
      }
    },
    tool: {
      view_context: tool({
        description:
          "View the current context blobs, fidelity settings, and token usage",
        args: {},
        async execute(_args, toolCtx) {
          toolCtx.metadata({ title: "View context" });
          return JSON.stringify(
            await currentMapToolView(toolCtx.sessionID),
            null,
            2,
          );
        },
      }),
      set_fidelity: tool({
        description:
          "Set how much detail to keep for a blob (full, summary, placeholder, drop). Use for stale or large blobs; avoid frequent small edits because prompt reshaping can reduce provider prompt-cache hits.",
        args: {
          blob_id: tool.schema.string().describe("Blob ID (snake_case label)"),
          fidelity: tool.schema
            .enum(["full", "summary", "placeholder", "drop"])
            .describe(
              "Detail level: full (keep everything), summary (one-line per message), placeholder (short stub), drop (remove from context)",
            ),
          force_user_override: tool.schema
            .boolean()
            .optional()
            .describe("Override a user-set fidelity (use only if user asks)"),
        },
        async execute(args, toolCtx) {
          toolCtx.metadata({
            title: `Set fidelity: ${args.blob_id} → ${args.fidelity === "drop" ? "hide" : args.fidelity}`,
          });
          const { result, map } = await applyMapFidelity({
            sessionID: toolCtx.sessionID,
            blobID: args.blob_id,
            fidelity: args.fidelity,
            source: "agent",
            force: args.force_user_override,
          });
          return JSON.stringify(
            {
              ok: result.ok,
              message: result.message,
              user_controls_are_authoritative: true,
              blob: map.blobs[args.blob_id],
            },
            null,
            2,
          );
        },
      }),
      session_lookup: tool({
        description: "Search past sessions by keyword",
        args: {
          query: tool.schema
            .string()
            .describe("Search text to match against session titles and blobs"),
          limit: tool.schema
            .number()
            .int()
            .min(1)
            .max(10)
            .optional()
            .describe("Max sessions to return"),
        },
        async execute(args, toolCtx) {
          toolCtx.metadata({ title: `Session lookup: ${args.query}` });
          const sessions = await sessionLookup(args.query, args.limit ?? 5);
          return JSON.stringify(
            {
              query: args.query,
              hint:
                sessions.length > 0
                  ? "Use session_detail in a sub-agent (Task tool) for deeper investigation."
                  : "No matching sessions found.",
              sessions,
            },
            null,
            2,
          );
        },
      }),
      session_tree: tool({
        description:
          "Inspect parent/sub-agent session lineage as a low-fidelity tree with child task links and blob summaries",
        args: {
          session_id: tool.schema
            .string()
            .optional()
            .describe("Root session ID. Defaults to the current session."),
          depth: tool.schema
            .number()
            .int()
            .min(0)
            .max(3)
            .optional()
            .describe("How many child-session levels to include"),
        },
        async execute(args, toolCtx) {
          const rootSessionID = args.session_id ?? toolCtx.sessionID;
          toolCtx.metadata({ title: `Session tree: ${rootSessionID}` });
          return JSON.stringify(
            {
              root_session_id: rootSessionID,
              depth: args.depth ?? 1,
              tree: await sessionTree(rootSessionID, args.depth ?? 1),
              next_steps: [
                "Use session_detail on a promising blob for message summaries.",
                "Use message_detail for one exact message or tool call only when needed.",
              ],
            },
            null,
            2,
          );
        },
      }),
      session_detail: tool({
        description:
          "Get progressive detail from a past session blob: compressed summary, message summaries, or full blob transcript",
        args: {
          session_id: tool.schema.string().describe("Session ID to look up"),
          blob_id: tool.schema.string().describe("Blob ID within that session"),
          detail: tool.schema
            .enum(["summary", "messages", "full"])
            .describe(
              "Detail level: summary (compressed blob overview), messages (per-message summaries), or full (complete blob transcript)",
            ),
        },
        async execute(args, toolCtx) {
          toolCtx.metadata({
            title: `Session detail: ${args.blob_id}`,
          });
          const { map } = await ensureHistoricalMap(args.session_id);
          if (args.detail === "messages") {
            return JSON.stringify(
              {
                session_id: args.session_id,
                blob_id: args.blob_id,
                detail: args.detail,
                ...buildBlobMessageSummaries({
                  map,
                  blobID: args.blob_id,
                }),
                next_step:
                  "Call message_detail with one message_id to fetch a full message only if needed.",
              },
              null,
              2,
            );
          }
          const messages =
            args.detail === "full"
              ? await getMessages(args.session_id)
              : undefined;
          return JSON.stringify(
            {
              session_id: args.session_id,
              blob_id: args.blob_id,
              detail: args.detail,
              content: buildSessionZoomText({
                map,
                blobID: args.blob_id,
                fidelity: args.detail === "full" ? "full" : "compressed",
                messages,
              }),
            },
            null,
            2,
          );
        },
      }),
      message_detail: tool({
        description:
          "Fetch one full historical message after session_detail detail='messages' identifies the relevant message_id",
        args: {
          session_id: tool.schema.string().describe("Session ID to look up"),
          message_id: tool.schema
            .string()
            .describe("Message ID to fetch in full"),
        },
        async execute(args, toolCtx) {
          toolCtx.metadata({ title: `Message detail: ${args.message_id}` });
          const { map } = await ensureHistoricalMap(args.session_id);
          const messages = await getMessages(args.session_id);
          return JSON.stringify(
            {
              session_id: args.session_id,
              message_id: args.message_id,
              ...buildMessageDetail({
                map,
                messageID: args.message_id,
                messages,
              }),
            },
            null,
            2,
          );
        },
      }),
      blame_lookup: tool({
        description:
          "Find which session produced a specific line of code (via git blame)",
        args: {
          file: tool.schema
            .string()
            .describe("File path relative to the project root"),
          line: tool.schema
            .number()
            .int()
            .min(1)
            .describe("Line number (1-indexed)"),
        },
        async execute(args, toolCtx) {
          toolCtx.metadata({
            title: `Blame: ${args.file}:${args.line}`,
          });
          return JSON.stringify(
            await blameLookup(args.file, args.line),
            null,
            2,
          );
        },
      }),
    },
    "shell.env": async (input, output) => {
      if (!input.sessionID) return;
      output.env.OPENCODE_SESSION_ID = input.sessionID;
    },
    "tool.execute.after": async (input) => {
      if (await isChildSession(input.sessionID)) return;
      const messages = await getMessages(input.sessionID);
      const toolMessage = findMessageForToolCall(messages, input.callID);
      if (!toolMessage || toolMessage.info.role !== "assistant") return;
      const currentMap = await getMap(input.sessionID);
      const activeMessages = filterMessagesForActiveContext(
        currentMap,
        messages,
        { includeSummary: false },
      );

      const fallback = buildFallbackMapFromMessages({
        sessionID: input.sessionID,
        directory: ctx.directory,
        worktree: ctx.worktree,
        messages: activeMessages,
      });
      const suggestedBlobID = fallback.messages[toolMessage.info.id]?.blobID;
      const map = capturePendingRetroactiveMessage({
        map: mergeContextMaps(currentMap, fallback),
        messages: activeMessages,
        messageID: toolMessage.info.id,
        suggestedBlobID,
      });
      await writeContextMap(map);
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      if (isCompactionSystemPrompt(output.system)) {
        await appendTrace(input.sessionID, "system.transform", {
          skipped: "compaction",
          system_count: output.system.length,
        });
        return;
      }
      const map = await getMap(input.sessionID);
      const child = await isChildSession(input.sessionID);
      if (child) {
        output.system.unshift(
          "This is a sub-agent session. Do not build a context map for this session. Keep the investigation focused and use session_detail/message_detail for historical details when needed.",
        );
        return;
      }
      const guidance = buildPluginGuidanceSystemPrompt(map);
      const cacheStable = cacheStableModeEnabled();
      const annotation = cacheStable
        ? undefined
        : buildAnnotationSystemPrompt(map);
      output.system.unshift(
        cacheStable ? staticPluginGuidanceSystemPrompt() : guidance,
      );
      if (annotation) output.system.unshift(annotation);

      await appendTrace(input.sessionID, "system.transform", {
        cache_stable: cacheStable,
        blob_count: map.blobOrder.length,
        total_tokens: map.totalTokenEstimate,
        guidance_length: (cacheStable
          ? staticPluginGuidanceSystemPrompt()
          : guidance
        ).length,
        annotation_prompt_length: annotation?.length ?? 0,
        guidance_preview: (cacheStable
          ? staticPluginGuidanceSystemPrompt()
          : guidance
        ).slice(0, 300),
        ...(tracePayloadEnabled()
          ? {
              system_prompts: output.system.map((text, index) => ({
                index,
                length: text.length,
                text,
              })),
            }
          : {}),
      });
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      const sessionID = resolveSessionID(output.messages as MessageLike[]);
      if (!sessionID) return;
      if (await isChildSession(sessionID)) return;
      const beforeCount = output.messages.length;
      const currentMessages = sortMessagesChronologically(
        output.messages as MessageLike[],
      );
      const map = compactingSessions.has(sessionID)
        ? await getMap(sessionID)
        : ((await persistCoverage(sessionID, currentMessages)) ??
          (await getMap(sessionID)));

      // Snapshot blob fidelities before transform
      const blobFidelities = Object.fromEntries(
        map.blobOrder.map((id) => [id, map.blobs[id]?.fidelity]),
      );

      const preview = computeContextPreview(map);
      const transformedMessages = transformMessagesForContext(
        output.messages as MessageLike[],
        map,
      );
      output.messages = transformedMessages as never;
      await writeContextMap(map);

      const afterCount = output.messages.length;
      await appendTrace(sessionID, "messages.transform", {
        before_count: beforeCount,
        after_count: afterCount,
        messages_removed: beforeCount - afterCount,
        preview: {
          total_raw_tokens: preview.totalRaw,
          total_effective_tokens: preview.totalEffective,
          blobs: preview.blobs.map((b) => ({
            id: b.id,
            label: b.label,
            fidelity: b.fidelity,
            raw_tokens: b.rawTokens,
            effective_tokens: b.effectiveTokens,
            effective_label: b.effectiveLabel,
            message_count: b.messageCount,
          })),
        },
        blob_fidelities: blobFidelities,
        surviving_messages: (output.messages as MessageLike[]).map((m) => ({
          id: m.info.id,
          role: m.info.role,
          text_length: m.parts
            .filter((p) => p.type === "text")
            .reduce((s, p) => s + (p.text?.length ?? 0), 0),
          is_stub:
            m.parts.some((p) => p.type === "text" && p.text?.startsWith("[")) ??
            false,
        })),
        ...(tracePayloadEnabled()
          ? {
              payload_messages: messagePayloadSnapshot(
                transformedMessages,
                map,
              ),
            }
          : {}),
      });
    },
    "experimental.text.complete": async (input, output) => {
      if (await isChildSession(input.sessionID)) return;
      const parsed = parseAnnotationBlock(output.text);
      output.text = parsed.cleanText;
      const messages = await getMessages(input.sessionID);
      let map = await getMap(input.sessionID);
      const activeMessages = filterMessagesForActiveContext(map, messages, {
        includeSummary: false,
      });
      if (parsed.annotation) {
        map = applyAnnotationEnvelope({
          map,
          messages: activeMessages,
          assistantMessageID: input.messageID,
          annotation: parsed.annotation,
        });
      } else {
        const fallback = buildFallbackMapFromMessages({
          sessionID: input.sessionID,
          directory: ctx.directory,
          worktree: ctx.worktree,
          messages: activeMessages,
        });
        map = mergeContextMaps(map, fallback);
        for (const messageID of Object.keys(map.pendingRetroactive)) {
          if (fallback.messages[messageID])
            delete map.pendingRetroactive[messageID];
        }
      }
      await writeContextMap(map);
      const preview = computeContextPreview(map);
      await writeDebugLog(map, preview).catch(() => undefined);

      await appendTrace(input.sessionID, "text.complete", {
        had_annotation: !!parsed.annotation,
        annotation_blob: parsed.annotation?.current?.blob,
        annotation_is_new_blob: parsed.annotation?.current?.is_new_blob,
        annotation_summary: parsed.annotation?.current?.message_summary?.slice(
          0,
          100,
        ),
        retroactive_count: parsed.annotation?.retroactive?.length ?? 0,
        fallback_used: !parsed.annotation,
        blob_count: map.blobOrder.length,
        total_tokens: map.totalTokenEstimate,
        effective_tokens: preview.totalEffective,
      });
    },
    "experimental.session.compacting": async (input, output) => {
      compactingSessions.add(input.sessionID);
      const map = await getMap(input.sessionID);
      const prompt = buildCompactionPrompt(map);
      output.prompt = prompt;

      await appendTrace(input.sessionID, "session.compacting", {
        blob_count: map.blobOrder.length,
        blob_policies: map.blobOrder.map((id) => ({
          id,
          label: map.blobs[id]?.label,
          fidelity: map.blobs[id]?.fidelity,
          source: map.blobs[id]?.fidelitySource,
          tokens: map.blobs[id]?.tokenEstimate,
        })),
        prompt_length: prompt.length,
        prompt_preview: prompt.slice(0, 500),
      });
    },
  };
};

function resolveSessionID(messages: MessageLike[]) {
  const last = messages[messages.length - 1];
  if (!last) return undefined;
  const info = last.info as {
    sessionID?: string;
    metadata?: { sessionID?: string };
  };
  return info.sessionID ?? info.metadata?.sessionID;
}

const plugin: PluginModule = {
  id: PLUGIN_ID,
  server,
};

export default plugin;
