import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  BlobEntry,
  CommitMapEntry,
  CommitMapFile,
  ContextMapFile,
  ContextPreview,
  MessageEntry,
} from "./types";
import { computeEffectiveTreatment } from "./core";

const MAP_VERSION = 1 as const;

function homeDir() {
  return os.homedir();
}

export function contextMapRoot() {
  return path.join(homeDir(), ".opencode", "context-maps");
}

export function sessionMapPath(sessionID: string) {
  return path.join(contextMapRoot(), `${sessionID}.json`);
}

export function commitMapPath() {
  return path.join(contextMapRoot(), "_commits.json");
}

export function compactionArchivePath(sessionID: string, compactedAt: number) {
  return path.join(
    contextMapRoot(),
    "archive",
    sessionID,
    `${compactedAt}.json`,
  );
}

export async function ensureContextMapRoot() {
  await fs.mkdir(contextMapRoot(), { recursive: true });
}

export function createEmptyContextMap(input: {
  sessionID: string;
  directory?: string;
  worktree?: string;
  now?: number;
}): ContextMapFile {
  const now = input.now ?? Date.now();
  return {
    version: MAP_VERSION,
    sessionID: input.sessionID,
    directory: input.directory,
    worktree: input.worktree,
    createdAt: now,
    updatedAt: now,
    totalTokenEstimate: 0,
    settings: {
      placeholderIncludesKeyFacts: true,
      placeholderIncludesKeyFactsSource: "default",
      toolHistoryCleanup: true,
      stablePlaceholders: false,
      stablePlaceholdersSource: "default",
      stableAnchors: false,
      stableAnchorsSource: "default",
    },
    blobOrder: [],
    blobs: {},
    messages: {},
    pendingRetroactive: {},
  };
}

export async function readContextMap(input: {
  sessionID: string;
  directory?: string;
  worktree?: string;
}): Promise<ContextMapFile> {
  try {
    const raw = await fs.readFile(sessionMapPath(input.sessionID), "utf8");
    const parsed = JSON.parse(raw) as Partial<ContextMapFile>;
    const fallback = createEmptyContextMap(input);
    return {
      ...fallback,
      ...parsed,
      settings: {
        ...fallback.settings,
        ...(parsed.settings ?? {}),
      },
      blobOrder: Array.isArray(parsed.blobOrder) ? parsed.blobOrder : [],
      blobs:
        parsed.blobs && typeof parsed.blobs === "object" ? parsed.blobs : {},
      messages:
        parsed.messages && typeof parsed.messages === "object"
          ? parsed.messages
          : {},
      pendingRetroactive:
        parsed.pendingRetroactive &&
        typeof parsed.pendingRetroactive === "object"
          ? parsed.pendingRetroactive
          : {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return createEmptyContextMap(input);
  }
}

export async function writeContextMap(map: ContextMapFile) {
  await ensureContextMapRoot();
  await writeJsonAtomic(sessionMapPath(map.sessionID), map);
}

export async function archiveContextMapForCompaction(input: {
  map: ContextMapFile;
  compactedAt: number;
  summaryMessageID: string;
  summaryText: string;
  includeMessageID?: string;
}) {
  await ensureContextMapRoot();
  const archivePath = compactionArchivePath(
    input.map.sessionID,
    input.compactedAt,
  );
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await writeJsonAtomic(archivePath, {
    version: 1,
    reason: "compaction",
    archivedAt: Date.now(),
    sessionID: input.map.sessionID,
    compaction: {
      compactedAt: input.compactedAt,
      summaryMessageID: input.summaryMessageID,
      summaryText: input.summaryText,
      includeMessageID: input.includeMessageID,
    },
    map: input.map,
  });
  return archivePath;
}

export async function readCommitMap(): Promise<CommitMapFile> {
  try {
    const raw = await fs.readFile(commitMapPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<CommitMapFile>;
    return {
      version: MAP_VERSION,
      updatedAt:
        typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      entries:
        parsed.entries && typeof parsed.entries === "object"
          ? parsed.entries
          : {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      version: MAP_VERSION,
      updatedAt: Date.now(),
      entries: {},
    };
  }
}

export async function writeCommitMap(file: CommitMapFile) {
  await ensureContextMapRoot();
  await writeJsonAtomic(commitMapPath(), file);
}

export async function recordCommitMapEntry(entry: CommitMapEntry) {
  const file = await readCommitMap();
  file.entries[entry.commitHash] = entry;
  file.updatedAt = Date.now();
  await writeCommitMap(file);
}

export async function removeContextMap(sessionID: string) {
  await fs.rm(sessionMapPath(sessionID), { force: true });
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(value, null, 2));
  await fs.rename(tmpPath, filePath);
}

// ── Debug log ─────────────────────────────────────────────────────────

export function debugLogPath(sessionID: string) {
  return path.join(contextMapRoot(), `${sessionID}.debug.json`);
}

export async function writeDebugLog(
  map: ContextMapFile,
  preview: ContextPreview,
) {
  await ensureContextMapRoot();
  const logPath = debugLogPath(map.sessionID);

  const messages = Object.values(map.messages)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((m) => {
      const blob = m.blobID ? map.blobs[m.blobID] : undefined;
      return {
        id: m.id,
        role: m.role,
        blob_id: m.blobID,
        blob_label: blob?.label,
        blob_fidelity: blob?.fidelity,
        summary: m.summary,
        hidden: m.hidden,
        hidden_source: m.hiddenSource,
        fidelity_override: m.fidelityOverride,
        fidelity_source: m.fidelitySource,
        token_estimate: m.tokenEstimate,
        source: m.source,
        effective_treatment: computeEffectiveTreatment(m, blob),
      };
    });

  const log = {
    timestamp: new Date().toISOString(),
    session_id: map.sessionID,
    blobs: preview.blobs.map((b) => ({
      id: b.id,
      label: b.label,
      fidelity: b.fidelity,
      raw_tokens: b.rawTokens,
      effective_tokens: b.effectiveTokens,
      message_count: b.messageCount,
      effective_label: b.effectiveLabel,
    })),
    messages,
    totals: {
      raw_tokens: preview.totalRaw,
      effective_tokens: preview.totalEffective,
    },
  };

  await writeJsonAtomic(logPath, log);
}

// ── Trace log (append-only JSONL per session) ─────────────────────────

export function traceLogPath(sessionID: string) {
  return path.join(contextMapRoot(), `${sessionID}.trace.jsonl`);
}

export async function appendTrace(
  sessionID: string,
  event: string,
  data: Record<string, unknown>,
) {
  try {
    await ensureContextMapRoot();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      sessionID,
      ...data,
    });
    await fs.appendFile(traceLogPath(sessionID), `${line}\n`);
  } catch {
    // trace logging is best-effort, never block the main flow
  }
}
