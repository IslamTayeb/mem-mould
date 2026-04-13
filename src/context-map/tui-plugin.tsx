/** @jsxImportSource @opentui/solid */

import { useKeyboard } from "@opentui/solid";
import type {
  TuiKeybindSet,
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import {
  buildHistoricalOverview,
  buildPlaceholderText,
  buildSessionZoomText,
  buildFallbackMapFromMessages,
  computeContextPreview,
  formatTokens,
  updateBlobFidelity,
  updateMessageControls,
} from "./core";
import { readCommitMap, readContextMap, writeContextMap } from "./storage";
import type {
  BlobEntry,
  BlobFidelity,
  ContextMapFile,
  ContextPreview,
  HistoricalSessionOverview,
  MessageEntry,
  MessageLike,
} from "./types";

const PLUGIN_ID = "mem-mould.context-map-tui";
const execFileAsync = promisify(execFile);

const COLORS = [
  "primary",
  "secondary",
  "accent",
  "info",
  "success",
  "warning",
  "error",
] as const;

type Tab = "blobs" | "messages";

// ── Fidelity labels (user-facing) ──────────────────────────────────────

const BLOB_FIDELITY_KEYS: BlobFidelity[] = [
  "full",
  "summary",
  "compressed",
  "placeholder",
  "drop",
];
const BLOB_FIDELITY_LABEL: Record<BlobFidelity, string> = {
  full: "Full",
  summary: "Summaries",
  compressed: "Compressed",
  placeholder: "Placeholder",
  drop: "Drop",
};
const FIDELITY_SHORT: Record<BlobFidelity, string> = {
  full: "Full",
  summary: "Summ",
  compressed: "Comp",
  placeholder: "Plch",
  drop: "Drop",
};

// ── Helpers ────────────────────────────────────────────────────────────

function color(api: TuiPluginApi, i: number) {
  return api.theme.current[COLORS[i % COLORS.length]];
}

function orderedBlobs(map?: ContextMapFile): BlobEntry[] {
  if (!map) return [];
  return map.blobOrder.map((id) => map.blobs[id]).filter(Boolean);
}

function orderedMessages(map?: ContextMapFile): MessageEntry[] {
  if (!map) return [];
  return Object.values(map.messages).sort((a, b) => a.createdAt - b.createdAt);
}

type Section = {
  blobID?: string;
  label: string;
  fidelity?: BlobFidelity;
  count: number;
  tokens: number;
  messages: MessageEntry[];
};

function groupedSections(map?: ContextMapFile): Section[] {
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
      const msgs = byBlob.get(id) ?? [];
      if (msgs.length === 0) return undefined;
      return {
        blobID: id,
        label: blob.label,
        fidelity: blob.fidelity,
        count: msgs.length,
        tokens: msgs.reduce((s, m) => s + m.tokenEstimate, 0),
        messages: msgs,
      } satisfies Section;
    })
    .filter(Boolean) as Section[];
  if (loose.length > 0) {
    sections.push({
      label: "Unassigned",
      count: loose.length,
      tokens: loose.reduce((s, m) => s + m.tokenEstimate, 0),
      messages: loose,
    });
  }
  return sections;
}

function flatMessages(sections: Section[]) {
  return sections.flatMap((s) => s.messages);
}

function sectionColor(map: ContextMapFile | undefined, s: Section) {
  if (!map || !s.blobID) return 0;
  const i = map.blobOrder.indexOf(s.blobID);
  return i === -1 ? map.blobOrder.length : i;
}

function relTime(ts?: number) {
  if (!ts) return "";
  const d = Math.max(0, Date.now() - ts);
  if (d < 60_000) return "now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h`;
  return `${Math.round(d / 86_400_000)}d`;
}

function trim(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}

async function loadMap(api: TuiPluginApi, sessionID: string) {
  return readContextMap({
    sessionID,
    directory: api.state.path.directory,
    worktree: api.state.path.worktree,
  });
}

async function ensureHistorical(api: TuiPluginApi, sessionID: string) {
  let map = await readContextMap({
    sessionID,
    directory: api.state.path.directory,
    worktree: api.state.path.worktree,
  });
  if (map.blobOrder.length > 0 || Object.keys(map.messages).length > 0)
    return map;
  const raw =
    (
      (await api.client.session.messages({
        sessionID,
        directory: api.state.path.directory,
        limit: 5000,
      })) as any
    )?.data ?? [];
  if (!Array.isArray(raw) || raw.length === 0) return map;
  map = buildFallbackMapFromMessages({
    sessionID,
    directory: api.state.path.directory,
    worktree: api.state.path.worktree,
    messages: raw as MessageLike[],
  });
  await writeContextMap(map);
  return map;
}

// ── Context bar (shared between sidebar and dialogs) ──────────────────

function ContextBar(props: { api: TuiPluginApi; map?: ContextMapFile }) {
  const blobs = createMemo(() => orderedBlobs(props.map));
  const total = createMemo(() =>
    Math.max(
      1,
      blobs().reduce((s, b) => s + b.tokenEstimate, 0),
    ),
  );
  const W = 50;
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <For each={blobs()}>
          {(b, i) => (
            <text fg={color(props.api, i())}>
              {"\u2588".repeat(
                Math.max(1, Math.round((b.tokenEstimate / total()) * W)),
              )}
            </text>
          )}
        </For>
      </box>
      <For each={blobs()}>
        {(b, i) => (
          <text fg={props.api.theme.current.textMuted}>
            <span style={{ fg: color(props.api, i()) }}>{"\u25A0"}</span>{" "}
            {b.label} {Math.round((b.tokenEstimate / total()) * 100)}% [
            {BLOB_FIDELITY_LABEL[b.fidelity]}]
          </text>
        )}
      </For>
    </box>
  );
}

// ── Sidebar widget ────────────────────────────────────────────────────

function SidebarView(props: { api: TuiPluginApi; sessionID: string }) {
  const [map, setMap] = createSignal<ContextMapFile>();
  const mc = createMemo(
    () => props.api.state.session.messages(props.sessionID).length,
  );
  createEffect(() => {
    mc();
    void loadMap(props.api, props.sessionID).then(setMap);
  });

  const preview = createMemo(() => {
    const m = map();
    return m ? computeContextPreview(m) : undefined;
  });

  const contextLimit = createMemo(() => {
    const msgs = props.api.state.session.messages(props.sessionID);
    const last = [...msgs]
      .reverse()
      .find(
        (m) =>
          m.role === "assistant" &&
          (m as any).tokens &&
          (m as any).tokens.output > 0,
      ) as
      | { providerID?: string; modelID?: string; tokens?: { output: number } }
      | undefined;
    if (!last?.providerID || !last?.modelID) return 0;
    const provider = props.api.state.provider.find(
      (p) => p.id === last.providerID,
    );
    const model = provider?.models?.[last.modelID!] as
      | { limit?: { context?: number } }
      | undefined;
    return model?.limit?.context ?? 0;
  });

  const blobs = createMemo(() => orderedBlobs(map()));
  const barW = 34; // fits 37-char sidebar content width

  const debugInfo = createMemo(() => {
    const m = map();
    if (!m) return "map: null";
    return `${m.blobOrder.length} blobs, ${Object.keys(m.messages).length} msgs`;
  });

  return (
    <box flexDirection="column" gap={1}>
      <text fg={props.api.theme.current.text}>
        <b>Mem Map</b> {debugInfo()}
      </text>
      <text fg={props.api.theme.current.textMuted}>
        sid: {props.sessionID.slice(0, 20)}
      </text>

      <Show when={map() && blobs().length > 0}>
        {/* Post-transform context bar */}
        <Show when={preview()}>
          <box flexDirection="column">
            <box flexDirection="row">
              <For each={preview()!.blobs}>
                {(b, i) => {
                  const pct =
                    b.effectiveTokens / Math.max(1, preview()!.totalEffective);
                  const w = Math.max(
                    b.effectiveTokens > 0 ? 1 : 0,
                    Math.round(pct * barW),
                  );
                  return (
                    <text fg={color(props.api, i())}>{"\u2588".repeat(w)}</text>
                  );
                }}
              </For>
              <Show when={preview()!.totalEffective === 0}>
                <text fg={props.api.theme.current.textMuted}>
                  {"\u2591".repeat(barW)}
                </text>
              </Show>
            </box>

            {/* Per-blob one-liner */}
            <For each={preview()!.blobs}>
              {(b, i) => (
                <text fg={props.api.theme.current.textMuted}>
                  <span style={{ fg: color(props.api, i()) }}>{"\u25A0"}</span>{" "}
                  {trim(b.label, 14)} {FIDELITY_SHORT[b.fidelity]}{" "}
                  {b.effectiveLabel}
                </text>
              )}
            </For>

            {/* Context usage */}
            <text fg={props.api.theme.current.textMuted}>
              {"~"}
              {formatTokens(preview()!.totalEffective)}
              {contextLimit() > 0
                ? ` / ${formatTokens(contextLimit())} (${Math.round((preview()!.totalEffective / contextLimit()) * 100)}%)`
                : " tok in-context"}
            </text>
          </box>
        </Show>
      </Show>

      <text fg={props.api.theme.current.textMuted}>
        {props.api.keybind.print("plugin.mem_map_open")} open
      </text>
    </box>
  );
}

// ── Main dialog (/mem-map) ────────────────────────────────────────────

function MemMapDialog(props: {
  api: TuiPluginApi;
  sessionID: string;
  close: () => void;
}) {
  const [map, setMap] = createSignal<ContextMapFile>();
  const [tab, setTab] = createSignal<Tab>("blobs");
  const [bi, setBi] = createSignal(0); // blob index
  const [mi, setMi] = createSignal(0); // message index
  const mc = createMemo(
    () => props.api.state.session.messages(props.sessionID).length,
  );

  const blobs = createMemo(() => orderedBlobs(map()));
  const secs = createMemo(() => groupedSections(map()));
  const msgs = createMemo(() => flatMessages(secs()));
  const curBlob = createMemo(
    () => blobs()[Math.min(bi(), Math.max(0, blobs().length - 1))],
  );
  const curMsg = createMemo(
    () => msgs()[Math.min(mi(), Math.max(0, msgs().length - 1))],
  );

  const reload = () => void loadMap(props.api, props.sessionID).then(setMap);

  const jumpToBlob = (id?: string) => {
    if (!id) return;
    const idx = msgs().findIndex((m) => m.blobID === id);
    if (idx !== -1) setMi(idx);
  };

  let writing = false;

  const setFidelity = async (f: BlobFidelity) => {
    const b = curBlob();
    if (!b || !map() || writing) return;
    writing = true;
    try {
      const next = structuredClone(map()!);
      updateBlobFidelity({
        map: next,
        blobID: b.id,
        fidelity: f,
        source: "user",
        force: true,
      });
      await writeContextMap(next);
      setMap(next);
    } finally {
      writing = false;
    }
  };

  const patchMsg = async (kind: "hide" | "auto" | "full" | "summary") => {
    const m = curMsg();
    if (!m || !map() || writing) return;
    writing = true;
    try {
      const next = structuredClone(map()!);
      if (kind === "hide")
        updateMessageControls({
          map: next,
          messageID: m.id,
          hidden: !m.hidden,
          source: "user",
        });
      else if (kind === "auto")
        updateMessageControls({
          map: next,
          messageID: m.id,
          fidelityOverride: "inherit",
          source: "user",
        });
      else if (kind === "full")
        updateMessageControls({
          map: next,
          messageID: m.id,
          fidelityOverride: "full",
          source: "user",
        });
      else if (kind === "summary")
        updateMessageControls({
          map: next,
          messageID: m.id,
          fidelityOverride: "summary",
          source: "user",
        });
      await writeContextMap(next);
      setMap(next);
    } finally {
      writing = false;
    }
  };

  createEffect(() => {
    mc();
    reload();
  });
  createEffect(() => {
    if (mi() > Math.max(0, msgs().length - 1))
      setMi(Math.max(0, msgs().length - 1));
    if (bi() > Math.max(0, blobs().length - 1))
      setBi(Math.max(0, blobs().length - 1));
  });

  useKeyboard((evt) => {
    const stop = () => {
      evt.preventDefault();
      evt.stopPropagation();
    };
    if (evt.name === "escape" || evt.name === "q") {
      stop();
      props.close();
      return;
    }
    if (evt.name === "tab") {
      stop();
      setTab(tab() === "blobs" ? "messages" : "blobs");
      if (tab() === "messages") jumpToBlob(curBlob()?.id);
      return;
    }
    if (evt.name === "up" || evt.name === "k") {
      stop();
      tab() === "blobs"
        ? setBi((v) => Math.max(0, v - 1))
        : setMi((v) => Math.max(0, v - 1));
      return;
    }
    if (evt.name === "down" || evt.name === "j") {
      stop();
      tab() === "blobs"
        ? setBi((v) => Math.min(blobs().length - 1, v + 1))
        : setMi((v) => Math.min(msgs().length - 1, v + 1));
      return;
    }
    if (tab() === "blobs") {
      if (evt.name === "1") {
        stop();
        void setFidelity("full");
        return;
      }
      if (evt.name === "2") {
        stop();
        void setFidelity("summary");
        return;
      }
      if (evt.name === "3") {
        stop();
        void setFidelity("compressed");
        return;
      }
      if (evt.name === "4") {
        stop();
        void setFidelity("placeholder");
        return;
      }
      if (evt.name === "5") {
        stop();
        void setFidelity("drop");
        return;
      }
    }
    if (tab() === "messages") {
      if (evt.name === "x") {
        stop();
        void patchMsg("hide");
        return;
      }
      if (evt.name === "a") {
        stop();
        void patchMsg("auto");
        return;
      }
      if (evt.name === "f") {
        stop();
        void patchMsg("full");
        return;
      }
      if (evt.name === "s") {
        stop();
        void patchMsg("summary");
        return;
      }
    }
    // Don't swallow unhandled keys -- let them reach the app
  });

  const t = () => props.api.theme.current;

  // Compute effective tokens for a blob at its current fidelity
  const preview = createMemo(() => {
    const m = map();
    return m ? computeContextPreview(m) : undefined;
  });
  const effectiveTok = (blobID: string) => {
    const p = preview();
    if (!p) return 0;
    return p.blobs.find((b) => b.id === blobID)?.effectiveTokens ?? 0;
  };

  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
    >
      <text fg={t().text}>
        <b>Context Map</b>
      </text>
      <ContextBar api={props.api} map={map()} />

      {/* Tab bar */}
      <box flexDirection="row" gap={2} paddingTop={1}>
        <box
          backgroundColor={tab() === "blobs" ? t().accent : t().border}
          paddingLeft={1}
          paddingRight={1}
          onMouseUp={() => setTab("blobs")}
        >
          <text fg={tab() === "blobs" ? t().selectedListItemText : t().text}>
            Topics
          </text>
        </box>
        <box
          backgroundColor={tab() === "messages" ? t().accent : t().border}
          paddingLeft={1}
          paddingRight={1}
          onMouseUp={() => {
            setTab("messages");
            jumpToBlob(curBlob()?.id);
          }}
        >
          <text fg={tab() === "messages" ? t().selectedListItemText : t().text}>
            Messages
          </text>
        </box>
        <text fg={t().textMuted}>tab to switch</text>
      </box>

      {/* Blobs tab */}
      <Show when={tab() === "blobs"}>
        <Show
          when={blobs().length > 0}
          fallback={
            <text fg={t().textMuted}>
              No topics yet. Chat for a few turns first.
            </text>
          }
        >
          <scrollbox
            maxHeight={16}
            verticalScrollbarOptions={{ visible: false }}
          >
            <box flexDirection="column">
              <For each={blobs()}>
                {(blob, idx) => {
                  const sel = () => idx() === bi();
                  return (
                    <box
                      flexDirection="column"
                      backgroundColor={
                        sel() ? t().backgroundElement : undefined
                      }
                      paddingLeft={1}
                      paddingRight={1}
                      onMouseUp={() => setBi(idx())}
                    >
                      <text fg={t().text}>
                        <span
                          style={{
                            fg: sel() ? t().text : color(props.api, idx()),
                          }}
                        >
                          {sel() ? ">" : "\u25A0"}
                        </span>{" "}
                        {blob.label}{" "}
                        <span style={{ fg: t().textMuted }}>
                          ~{formatTokens(effectiveTok(blob.id))} tok{" "}
                          {blob.messageIDs.length} msgs{" "}
                          {relTime(blob.lastActiveAt)}{" "}
                          {blob.fidelity !== "full"
                            ? `(${formatTokens(blob.tokenEstimate)} raw)`
                            : ""}
                        </span>
                      </text>
                      <text fg={t().textMuted}> {blob.placeholder}</text>
                      <Show when={sel()}>
                        <box flexDirection="row" gap={1} paddingLeft={2}>
                          <For each={BLOB_FIDELITY_KEYS}>
                            {(f, fi) => (
                              <box
                                backgroundColor={
                                  blob.fidelity === f ? t().accent : t().border
                                }
                                paddingLeft={1}
                                paddingRight={1}
                                onMouseUp={() => void setFidelity(f)}
                              >
                                <text
                                  fg={
                                    blob.fidelity === f
                                      ? t().selectedListItemText
                                      : t().text
                                  }
                                >
                                  {fi() + 1}:{BLOB_FIDELITY_LABEL[f]}
                                </text>
                              </box>
                            )}
                          </For>
                        </box>
                      </Show>
                    </box>
                  );
                }}
              </For>
            </box>
          </scrollbox>
        </Show>
        <text fg={t().textMuted}>j/k navigate 1-5 set fidelity q close</text>
      </Show>

      {/* Messages tab */}
      <Show when={tab() === "messages"}>
        <Show
          when={secs().length > 0}
          fallback={<text fg={t().textMuted}>No messages mapped yet.</text>}
        >
          <scrollbox
            maxHeight={16}
            verticalScrollbarOptions={{ visible: false }}
          >
            <box flexDirection="column">
              <For each={secs()}>
                {(sec) => {
                  const ci = sectionColor(map(), sec);
                  return (
                    <box flexDirection="column">
                      <text fg={t().text}>
                        <span style={{ fg: color(props.api, ci) }}>
                          {"\u25A0"}
                        </span>{" "}
                        <b>{sec.label}</b>{" "}
                        <span style={{ fg: t().textMuted }}>
                          {sec.count} msgs ~{sec.tokens.toLocaleString()} tok
                          {sec.fidelity
                            ? `  [${BLOB_FIDELITY_LABEL[sec.fidelity]}]`
                            : ""}
                        </span>
                      </text>
                      <For each={sec.messages}>
                        {(msg) => {
                          const idx = createMemo(() =>
                            msgs().findIndex((m) => m.id === msg.id),
                          );
                          const sel = () => curMsg()?.id === msg.id;
                          const badge = () => {
                            const parts: string[] = [];
                            if (msg.hidden) parts.push("hidden");
                            if (msg.fidelityOverride !== "inherit")
                              parts.push(
                                msg.fidelityOverride === "summary"
                                  ? "summary"
                                  : "full",
                              );
                            return parts.length > 0
                              ? ` [${parts.join(",")}]`
                              : "";
                          };
                          return (
                            <box
                              flexDirection="column"
                              backgroundColor={
                                sel() ? t().backgroundElement : undefined
                              }
                              paddingLeft={2}
                              onMouseUp={() => {
                                if (idx() !== -1) setMi(idx());
                              }}
                            >
                              <text fg={sel() ? t().text : t().textMuted}>
                                {sel() ? ">" : " "}{" "}
                                {msg.role === "user" ? "U" : "A"}{" "}
                                {trim(msg.summary, 80)}
                                <span style={{ fg: t().warning }}>
                                  {badge()}
                                </span>
                              </text>
                              <Show when={sel()}>
                                <box
                                  flexDirection="row"
                                  gap={1}
                                  paddingLeft={3}
                                >
                                  <box
                                    backgroundColor={t().border}
                                    paddingLeft={1}
                                    paddingRight={1}
                                    onMouseUp={() => void patchMsg("hide")}
                                  >
                                    <text fg={t().text}>
                                      {msg.hidden ? "x:Show" : "x:Hide"}
                                    </text>
                                  </box>
                                  <box
                                    backgroundColor={t().border}
                                    paddingLeft={1}
                                    paddingRight={1}
                                    onMouseUp={() => void patchMsg("auto")}
                                  >
                                    <text fg={t().text}>a:Auto</text>
                                  </box>
                                  <box
                                    backgroundColor={t().border}
                                    paddingLeft={1}
                                    paddingRight={1}
                                    onMouseUp={() => void patchMsg("full")}
                                  >
                                    <text fg={t().text}>f:Full</text>
                                  </box>
                                  <box
                                    backgroundColor={t().border}
                                    paddingLeft={1}
                                    paddingRight={1}
                                    onMouseUp={() => void patchMsg("summary")}
                                  >
                                    <text fg={t().text}>s:Summary</text>
                                  </box>
                                </box>
                              </Show>
                            </box>
                          );
                        }}
                      </For>
                    </box>
                  );
                }}
              </For>
            </box>
          </scrollbox>
        </Show>
        <text fg={t().textMuted}>
          j/k navigate x hide a auto f full s summary q close
        </text>
      </Show>
    </box>
  );
}

// ── History dialog (/blame) ───────────────────────────────────────────

type HistoryState = {
  file: string;
  line: number;
  commitHash?: string;
  sessionID: string;
  overview: HistoricalSessionOverview;
};

function HistoryDialog(props: {
  api: TuiPluginApi;
  history: HistoryState;
  close: () => void;
}) {
  const [bi, setBi] = createSignal(0);
  const [zoom, setZoom] = createSignal<"placeholder" | "compressed" | "full">(
    "placeholder",
  );
  const [content, setContent] = createSignal("");
  const [map, setMap] = createSignal<ContextMapFile>();

  const blobs = createMemo(() => props.history.overview.blobs);

  const load = async (z: "placeholder" | "compressed" | "full") => {
    const b = blobs()[Math.min(bi(), Math.max(0, blobs().length - 1))];
    if (!b) return;
    setZoom(z);
    const m = await ensureHistorical(props.api, props.history.sessionID);
    setMap(m);
    if (z === "placeholder") {
      setContent(buildPlaceholderText(m, m.blobs[b.id]!));
      return;
    }
    if (z === "compressed") {
      setContent(
        buildSessionZoomText({ map: m, blobID: b.id, fidelity: "compressed" }),
      );
      return;
    }
    const raw =
      (
        (await props.api.client.session.messages({
          sessionID: props.history.sessionID,
          directory: props.api.state.path.directory,
          limit: 5000,
        })) as any
      )?.data ?? [];
    setContent(
      buildSessionZoomText({
        map: m,
        blobID: b.id,
        fidelity: "full",
        messages: raw as MessageLike[],
      }),
    );
  };

  createEffect(() => {
    void ensureHistorical(props.api, props.history.sessionID).then(setMap);
  });
  createEffect(() => {
    bi();
    zoom();
    void load(zoom());
  });

  useKeyboard((evt) => {
    if (!props.api.ui.dialog.open) return;
    const stop = () => {
      evt.preventDefault();
      evt.stopPropagation();
    };
    if (evt.name === "escape" || evt.name === "q") {
      stop();
      props.close();
      return;
    }
    if (evt.name === "up" || evt.name === "k") {
      stop();
      setBi((v) => Math.max(0, v - 1));
      return;
    }
    if (evt.name === "down" || evt.name === "j") {
      stop();
      setBi((v) => Math.min(blobs().length - 1, v + 1));
      return;
    }
    if (evt.name === "1") {
      stop();
      void load("placeholder");
      return;
    }
    if (evt.name === "2") {
      stop();
      void load("compressed");
      return;
    }
    if (evt.name === "3") {
      stop();
      void load("full");
      return;
    }
    // Don't swallow unhandled keys
  });

  const t = () => props.api.theme.current;
  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
    >
      <text fg={t().text}>
        <b>Blame</b>{" "}
        <span style={{ fg: t().textMuted }}>
          {props.history.file}:{props.history.line} commit{" "}
          {props.history.commitHash?.slice(0, 8)}
        </span>
      </text>
      <Show when={map()}>
        <ContextBar api={props.api} map={map()} />
      </Show>
      <box flexDirection="row" gap={2} paddingTop={1}>
        <box flexDirection="column" width="40%">
          <scrollbox
            maxHeight={14}
            verticalScrollbarOptions={{ visible: false }}
          >
            <box flexDirection="column">
              <For each={blobs()}>
                {(b, idx) => {
                  const sel = () => idx() === bi();
                  return (
                    <box
                      flexDirection="column"
                      backgroundColor={
                        sel() ? t().backgroundElement : undefined
                      }
                      paddingLeft={1}
                      paddingRight={1}
                      onMouseUp={() => setBi(idx())}
                    >
                      <text fg={t().text}>
                        <span
                          style={{
                            fg: sel() ? t().text : color(props.api, idx()),
                          }}
                        >
                          {sel() ? ">" : "\u25A0"}
                        </span>{" "}
                        {b.label}
                      </text>
                      <text fg={t().textMuted}> {b.placeholder}</text>
                      <Show when={b.activeForCommit}>
                        <text fg={t().warning}> commit-linked</text>
                      </Show>
                    </box>
                  );
                }}
              </For>
            </box>
          </scrollbox>
        </box>
        <box flexDirection="column" width="60%">
          <text fg={t().textMuted}>
            Zoom: {zoom()} (1 placeholder 2 compressed 3 full)
          </text>
          <scrollbox
            maxHeight={12}
            verticalScrollbarOptions={{ visible: false }}
          >
            <box
              border
              borderColor={t().border}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={t().text}>{content()}</text>
            </box>
          </scrollbox>
        </box>
      </box>
      <text fg={t().textMuted}>j/k navigate 1-3 zoom level q close</text>
    </box>
  );
}

// ── Blame lookup helper ───────────────────────────────────────────────

async function runBlame(
  api: TuiPluginApi,
  input: string,
): Promise<HistoryState> {
  const [file, lineText] = input.split(":");
  const line = Number.parseInt(lineText ?? "", 10);
  if (!file || !Number.isFinite(line) || line < 1)
    throw new Error("Use file:line, for example src/auth.ts:42");
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
      (await api.client.session.get({
        sessionID: entry.sessionID,
        directory: api.state.path.directory,
      })) as any
    )?.data ?? {};
  return {
    file,
    line,
    commitHash: hash,
    sessionID: entry.sessionID,
    overview: buildHistoricalOverview({
      map,
      session: session as any,
      commitEntry: entry,
      matchedBlobIDs: entry.activeBlobID ? [entry.activeBlobID] : [],
    }),
  };
}

// ── Plugin entry ──────────────────────────────────────────────────────

const tui: TuiPlugin = async (api) => {
  api.ui.toast({ variant: "info", message: "mem-mould TUI plugin loaded" });

  const keys: TuiKeybindSet = api.keybind.create({
    plugin_mem_map_open: "<leader>'",
  });

  const openMap = (sessionID?: string) => {
    const id = sessionID ?? currentSession(api);
    if (!id) {
      api.ui.toast({ variant: "error", message: "No active session" });
      return;
    }
    api.ui.dialog.setSize("xlarge");
    api.ui.dialog.replace(
      () => (
        <MemMapDialog
          api={api}
          sessionID={id}
          close={() => api.ui.dialog.clear()}
        />
      ),
      () => {},
    );
    queueMicrotask(() => api.ui.dialog.setSize("xlarge"));
  };

  const openBlame = () => {
    const P = api.ui.DialogPrompt;
    api.ui.dialog.replace(() => (
      <P
        title="Blame lookup"
        placeholder="src/auth.ts:42"
        onConfirm={(v) => {
          api.ui.dialog.clear();
          void runBlame(api, v)
            .then((h) => {
              api.ui.dialog.setSize("xlarge");
              api.ui.dialog.replace(
                () => (
                  <HistoryDialog
                    api={api}
                    history={h}
                    close={() => api.ui.dialog.clear()}
                  />
                ),
                () => {},
              );
              queueMicrotask(() => api.ui.dialog.setSize("xlarge"));
            })
            .catch((e) =>
              api.ui.toast({
                variant: "error",
                message: e instanceof Error ? e.message : String(e),
              }),
            );
        }}
        onCancel={() => api.ui.dialog.clear()}
      />
    ));
  };

  api.command.register(() => [
    {
      title: "Open context map",
      value: "context-map.open",
      category: "Plugin",
      keybind: keys.get("plugin_mem_map_open"),
      slash: { name: "mem-map" },
      onSelect: () => openMap(),
    },
    {
      title: "Blame lookup",
      value: "context-map.blame",
      category: "Plugin",
      slash: { name: "blame" },
      onSelect: () => openBlame(),
    },
  ]);

  api.slots.register({
    order: 110,
    slots: {
      sidebar_content(_ctx, value) {
        return <SidebarView api={api} sessionID={value.session_id} />;
      },
    },
  });

  api.lifecycle.onDispose(() => {});
};

function currentSession(api: TuiPluginApi) {
  const c = api.route.current;
  return c.name === "session" && typeof c.params?.sessionID === "string"
    ? c.params.sessionID
    : undefined;
}

const plugin: TuiPluginModule = { id: PLUGIN_ID, tui };
export default plugin;
