import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { buildHistoricalOverview } from "./core";
import { readCommitMap } from "./storage";
import { ensureHistorical } from "./tui-helpers";
import type { HistoricalSessionOverview } from "./types";

const execFileAsync = promisify(execFile);

export type HistoryState = {
  file: string;
  line: number;
  commitHash?: string;
  sessionID: string;
  overview: HistoricalSessionOverview;
};

export async function askAgentAboutBlame(
  api: TuiPluginApi,
  currentSessionID: string | undefined,
  history: HistoryState,
) {
  if (!currentSessionID) throw new Error("No active chat session to update.");
  await api.client.session.promptAsync({
    sessionID: currentSessionID,
    directory: api.state.path.directory,
    tools: {
      task: true,
      blame_lookup: true,
      session_lookup: true,
      session_detail: true,
      message_detail: true,
    },
    parts: [{ type: "text", text: buildBlameAgentPrompt(history) }],
  });
}

export async function runBlame(
  api: TuiPluginApi,
  input: string,
): Promise<HistoryState> {
  const [file, lineText] = input.split(":");
  const line = Number.parseInt(lineText ?? "", 10);
  if (!file || !Number.isFinite(line) || line < 1) {
    throw new Error("Use file:line, for example src/auth.ts:42");
  }

  const { stdout } = await execFileAsync(
    "git",
    ["blame", "-L", `${line},${line}`, "--", file],
    { cwd: api.state.path.worktree },
  );
  const hash = stdout.trim().split(/\s+/)[0];
  if (!hash) throw new Error(`Could not resolve git blame for ${input}`);

  const commits = await readCommitMap();
  const entry = commits.entries[hash];
  if (!entry) throw new Error(`No session mapping for commit ${hash}`);

  const map = await ensureHistorical(api, entry.sessionID);
  const session =
    (
      await api.client.session.get({
        sessionID: entry.sessionID,
        directory: api.state.path.directory,
      })
    )?.data ?? {};

  return {
    file,
    line,
    commitHash: hash,
    sessionID: entry.sessionID,
    overview: buildHistoricalOverview({
      map,
      session: { id: entry.sessionID, ...session },
      commitEntry: entry,
      matchedBlobIDs: entry.activeBlobID ? [entry.activeBlobID] : [],
    }),
  };
}

function buildBlameAgentPrompt(history: HistoryState) {
  const active = history.overview.blobs
    .filter((blob) => blob.activeForCommit)
    .map((blob) => `${blob.id} (${blob.label})`)
    .join(", ");
  return [
    `Use blame provenance to relate ${history.file}:${history.line} to the current task in this chat.`,
    "Treat the current chat history as the task context. Do not edit files.",
    "Investigate the historical context behind the blamed line, preferably by delegating a focused Task sub-agent so the current chat does not absorb the old transcript.",
    "The investigation path should use blame_lookup on the file and line, then session_detail with detail='messages' on the relevant blob, then message_detail for one supporting message if needed.",
    "Return one concise paragraph explaining how the historical change is related or not related to the current task, followed by a short evidence citation with session_id, blob_id, and message_id when available.",
    "Known /blame UI hint:",
    `- file: ${history.file}`,
    `- line: ${history.line}`,
    `- commit: ${history.commitHash ?? "unknown"}`,
    `- mapped_session_id: ${history.sessionID}`,
    `- active_blob_hint: ${active || "unknown"}`,
  ].join("\n");
}
