import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { Message, Part } from "@opencode-ai/sdk/v2";

import { buildFallbackMapFromMessages } from "./core";
import { readContextMap, writeContextMap } from "./storage";
import type {
  BlobEntry,
  BlobFidelity,
  ContextMapFile,
  MessageEntry,
  MessageLike,
} from "./types";

const COLORS = [
  "primary",
  "secondary",
  "accent",
  "info",
  "success",
  "warning",
  "error",
] as const;

export type Section = {
  blobID?: string;
  label: string;
  fidelity?: BlobFidelity;
  count: number;
  tokens: number;
  messages: MessageEntry[];
};

export const USER_SELECTABLE_BLOB_FIDELITIES: BlobFidelity[] = [
  "full",
  "summary",
  "placeholder",
  "drop",
];

export const BLOB_FIDELITY_LABEL: Record<BlobFidelity, string> = {
  full: "Full",
  summary: "Summary",
  compressed: "Compressed",
  placeholder: "Placeholder",
  drop: "Hidden",
};

export const FIDELITY_SHORT: Record<BlobFidelity, string> = {
  full: "Full",
  summary: "Summ",
  compressed: "Comp",
  placeholder: "Plch",
  drop: "Hide",
};

export function color(api: TuiPluginApi, i: number) {
  return api.theme.current[COLORS[i % COLORS.length]];
}

export function orderedBlobs(map?: ContextMapFile): BlobEntry[] {
  if (!map) return [];
  return map.blobOrder.map((id) => map.blobs[id]).filter(Boolean);
}

export function orderedMessages(map?: ContextMapFile): MessageEntry[] {
  if (!map) return [];
  return Object.values(map.messages).sort((a, b) => a.createdAt - b.createdAt);
}

export function groupedSections(map?: ContextMapFile): Section[] {
  if (!map) return [];
  const byBlob = new Map<string, MessageEntry[]>();
  const loose: MessageEntry[] = [];
  for (const msg of orderedMessages(map)) {
    if (msg.blobID && map.blobs[msg.blobID]) {
      const list = byBlob.get(msg.blobID) ?? [];
      list.push(msg);
      byBlob.set(msg.blobID, list);
    } else {
      loose.push(msg);
    }
  }

  const sections: Section[] = map.blobOrder
    .map((id) => {
      const blob = map.blobs[id];
      if (!blob) return undefined;
      const messages = byBlob.get(id) ?? [];
      if (messages.length === 0) return undefined;
      return {
        blobID: id,
        label: blob.label,
        fidelity: blob.fidelity,
        count: messages.length,
        tokens: messages.reduce(
          (sum, message) => sum + message.tokenEstimate,
          0,
        ),
        messages,
      } satisfies Section;
    })
    .filter(Boolean) as Section[];

  if (loose.length > 0) {
    sections.push({
      label: "Unassigned",
      count: loose.length,
      tokens: loose.reduce((sum, message) => sum + message.tokenEstimate, 0),
      messages: loose,
    });
  }

  return sections;
}

export function flatMessages(sections: Section[]) {
  return sections.flatMap((section) => section.messages);
}

export function sectionColor(
  map: ContextMapFile | undefined,
  section: Section,
) {
  if (!map || !section.blobID) return 0;
  const index = map.blobOrder.indexOf(section.blobID);
  return index === -1 ? map.blobOrder.length : index;
}

export function relTime(timestamp?: number) {
  if (!timestamp) return "";
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.round(elapsed / 3_600_000)}h`;
  return `${Math.round(elapsed / 86_400_000)}d`;
}

export function trim(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

type SessionMessage = {
  info: Message;
  parts: Part[];
};

export function toMessageLikes(messages: SessionMessage[]): MessageLike[] {
  return messages.map((message) => ({
    info: {
      id: message.info.id,
      role: message.info.role,
      time: message.info.time,
      summary:
        message.info.role === "assistant" ? message.info.summary : undefined,
    },
    parts: message.parts,
  }));
}

export function keybindPrint(api: TuiPluginApi, key: string) {
  return api.keybind.print(key);
}

export async function loadMap(api: TuiPluginApi, sessionID: string) {
  return readContextMap({
    sessionID,
    directory: api.state.path.directory,
    worktree: api.state.path.worktree,
  });
}

export async function ensureHistorical(api: TuiPluginApi, sessionID: string) {
  let map = await loadMap(api, sessionID);
  if (map.blobOrder.length > 0 || Object.keys(map.messages).length > 0) {
    return map;
  }

  const raw =
    (
      await api.client.session.messages({
        sessionID,
        directory: api.state.path.directory,
        limit: 5000,
      })
    ).data ?? [];
  if (!Array.isArray(raw) || raw.length === 0) return map;

  map = buildFallbackMapFromMessages({
    sessionID,
    directory: api.state.path.directory,
    worktree: api.state.path.worktree,
    messages: toMessageLikes(raw),
  });
  await writeContextMap(map);
  return map;
}

export function currentSession(api: TuiPluginApi) {
  const current = api.route.current;
  return current?.name === "session" &&
    typeof current.params?.sessionID === "string"
    ? current.params.sessionID
    : undefined;
}
