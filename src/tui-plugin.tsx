/** @jsxImportSource @opentui/solid */

import { useKeyboard } from "@opentui/solid";
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import {
  buildSessionZoomText,
  computeContextPreview,
  formatTokens,
  updateBlobFidelity,
  updateMessageControls,
} from "./core";
import { writeContextMap } from "./storage";
import { askAgentAboutBlame, runBlame, type HistoryState } from "./tui-blame";
import {
  BLOB_FIDELITY_LABEL,
  FIDELITY_SHORT,
  USER_SELECTABLE_BLOB_FIDELITIES,
  color,
  currentSession,
  ensureHistorical,
  flatMessages,
  groupedSections,
  keybindPrint,
  loadMap,
  orderedBlobs,
  relTime,
  sectionColor,
  toMessageLikes,
  trim,
} from "./tui-helpers";
import type { BlobEntry, BlobFidelity, ContextMapFile } from "./types";

const PLUGIN_ID = "mem-mould.context-map-tui";

type Tab = "blobs" | "messages";

function ContextBar(props: { api: TuiPluginApi; map?: ContextMapFile }) {
  const preview = createMemo(() =>
    props.map ? computeContextPreview(props.map) : undefined,
  );
  const totalEffective = createMemo(() =>
    Math.max(1, preview()?.totalEffective ?? 0),
  );
  const W = 50;
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <For each={preview()?.blobs ?? []}>
          {(b, i) => (
            <text fg={color(props.api, i())}>
              {"\u2588".repeat(
                Math.max(
                  b.effectiveTokens > 0 ? 1 : 0,
                  Math.round((b.effectiveTokens / totalEffective()) * W),
                ),
              )}
            </text>
          )}
        </For>
      </box>
      <For each={preview()?.blobs ?? []}>
        {(b, i) => (
          <text fg={props.api.theme.current.textMuted}>
            <span style={{ fg: color(props.api, i()) }}>{"\u25A0"}</span>{" "}
            {b.label} {Math.round((b.effectiveTokens / totalEffective()) * 100)}
            % [{BLOB_FIDELITY_LABEL[b.fidelity]}]
          </text>
        )}
      </For>
    </box>
  );
}

function SidebarView(props: {
  api: TuiPluginApi;
  sessionID: string;
  onOpen?: () => void;
}) {
  useKeyboard((evt) => {
    if (!props.onOpen) return;
    if (evt.ctrl && evt.name === "g") {
      evt.preventDefault();
      evt.stopPropagation();
      props.onOpen();
    }
  });

  const [map, setMap] = createSignal<ContextMapFile>();
  const mc = createMemo(
    () => props.api.state.session.messages(props.sessionID).length,
  );
  const dialogOpen = createMemo(() => props.api.ui.dialog.open);
  createEffect(() => {
    mc();
    dialogOpen();
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
      .find((m) => m.role === "assistant" && m.tokens.output > 0);
    if (last?.role !== "assistant") return 0;
    if (!last?.providerID || !last?.modelID) return 0;
    const provider = props.api.state.provider.find(
      (p) => p.id === last.providerID,
    );
    return provider?.models[last.modelID]?.limit.context ?? 0;
  });

  const blobs = createMemo(() => orderedBlobs(map()));
  const sidebarBarWidth = 34;

  return (
    <box flexDirection="column" gap={1}>
      <Show when={map() && blobs().length > 0}>
        <text fg={props.api.theme.current.text}>
          <b>Context Map</b>
        </text>
        <Show when={preview()}>
          <box flexDirection="column">
            <box flexDirection="row">
              <For each={preview()!.blobs}>
                {(b, i) => {
                  const pct =
                    b.effectiveTokens / Math.max(1, preview()!.totalEffective);
                  const w = Math.max(
                    b.effectiveTokens > 0 ? 1 : 0,
                    Math.round(pct * sidebarBarWidth),
                  );
                  return (
                    <text fg={color(props.api, i())}>{"\u2588".repeat(w)}</text>
                  );
                }}
              </For>
              <Show when={preview()!.totalEffective === 0}>
                <text fg={props.api.theme.current.textMuted}>
                  {"\u2591".repeat(sidebarBarWidth)}
                </text>
              </Show>
            </box>

            <For each={preview()!.blobs}>
              {(b, i) => (
                <text fg={props.api.theme.current.textMuted}>
                  <span style={{ fg: color(props.api, i()) }}>{"\u25A0"}</span>{" "}
                  {trim(b.label, 14)} {FIDELITY_SHORT[b.fidelity]} ~
                  {formatTokens(b.effectiveTokens)}
                </text>
              )}
            </For>

            <text fg={props.api.theme.current.textMuted}>
              {"~"}
              {formatTokens(preview()!.totalEffective)}
              {contextLimit() > 0
                ? ` / ${formatTokens(contextLimit())} (${Math.round((preview()!.totalEffective / contextLimit()) * 100)}%)`
                : " tok in-context"}
            </text>
          </box>
        </Show>

        <box onMouseUp={() => props.onOpen?.()}>
          <text fg={props.api.theme.current.textMuted}>
            {keybindPrint(props.api, "plugin_context_open") ?? "ctrl+g/click"}{" "}
            open
          </text>
        </box>
      </Show>
    </box>
  );
}

function MemMapDialog(props: {
  api: TuiPluginApi;
  sessionID: string;
  close: () => void;
}) {
  const [map, setMap] = createSignal<ContextMapFile>();
  const [tab, setTab] = createSignal<Tab>("blobs");
  const [bi, setBi] = createSignal(0);
  const [mi, setMi] = createSignal(0);
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
        void setFidelity("placeholder");
        return;
      }
      if (evt.name === "4") {
        stop();
        void setFidelity("drop");
        return;
      }
    }
    if (tab() === "messages") {
      const curBlobEntry = curMsg()?.blobID
        ? map()?.blobs[curMsg()!.blobID!]
        : undefined;
      if (
        curBlobEntry?.fidelity !== "placeholder" &&
        curBlobEntry?.fidelity !== "drop"
      ) {
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
    }
  });

  const t = () => props.api.theme.current;

  const preview = createMemo(() => {
    const m = map();
    return m ? computeContextPreview(m) : undefined;
  });
  const effectiveTok = (blobID: string) => {
    const p = preview();
    if (!p) return 0;
    return p.blobs.find((b) => b.id === blobID)?.effectiveTokens ?? 0;
  };

  const blobFidelityTag = (blob: BlobEntry) => {
    const m = map();
    if (!m) return `[${BLOB_FIDELITY_LABEL[blob.fidelity]}]`;
    const overrides: Record<string, number> = {};
    for (const msgID of blob.messageIDs) {
      const msg = m.messages[msgID];
      if (!msg) continue;
      if (msg.hidden) overrides.hidden = (overrides.hidden ?? 0) + 1;
      else if (msg.fidelityOverride !== "inherit")
        overrides[msg.fidelityOverride] =
          (overrides[msg.fidelityOverride] ?? 0) + 1;
    }
    const parts = Object.entries(overrides).map(([k, v]) => `+${v} ${k}`);
    const base = BLOB_FIDELITY_LABEL[blob.fidelity];
    return parts.length > 0 ? `[${base} ${parts.join(" ")}]` : `[${base}]`;
  };

  const blobIsCollapsed = (blob?: BlobEntry) =>
    blob?.fidelity === "placeholder" || blob?.fidelity === "drop";

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

      <box flexDirection="row" gap={2} paddingTop={1}>
        <box
          backgroundColor={tab() === "blobs" ? t().accent : t().border}
          paddingLeft={1}
          paddingRight={1}
          onMouseUp={() => setTab("blobs")}
        >
          <text fg={tab() === "blobs" ? t().selectedListItemText : t().text}>
            Blobs
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

      <Show when={tab() === "blobs"}>
        <Show
          when={blobs().length > 0}
          fallback={
            <text fg={t().textMuted}>
              No blobs yet. Chat for a few turns first.
            </text>
          }
        >
          <scrollbox
            maxHeight={16}
            verticalScrollbarOptions={{
              trackOptions: {
                backgroundColor: t().backgroundElement,
                foregroundColor: t().border,
              },
            }}
            viewportOptions={{ paddingRight: 1 }}
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
                            ? `(${formatTokens(blob.tokenEstimate)} raw) `
                            : ""}
                          {blobFidelityTag(blob)}
                        </span>
                      </text>
                      <text fg={t().textMuted}> {blob.placeholder}</text>
                      <Show when={sel()}>
                        <box flexDirection="row" gap={1} paddingLeft={2}>
                          <For each={USER_SELECTABLE_BLOB_FIDELITIES}>
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
        <text fg={t().textMuted}>j/k navigate 1-4 set fidelity q close</text>
      </Show>

      <Show when={tab() === "messages"}>
        <Show
          when={secs().length > 0}
          fallback={<text fg={t().textMuted}>No messages mapped yet.</text>}
        >
          <scrollbox
            maxHeight={16}
            verticalScrollbarOptions={{
              trackOptions: {
                backgroundColor: t().backgroundElement,
                foregroundColor: t().border,
              },
            }}
            viewportOptions={{ paddingRight: 1 }}
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
                          {sec.count} msgs ~
                          {formatTokens(
                            sec.blobID ? effectiveTok(sec.blobID) : sec.tokens,
                          )}{" "}
                          tok
                          {sec.blobID && map()?.blobs[sec.blobID]
                            ? `  ${blobFidelityTag(map()!.blobs[sec.blobID]!)}`
                            : ""}
                        </span>
                      </text>
                      <For each={sec.messages}>
                        {(msg) => {
                          const idx = createMemo(() =>
                            msgs().findIndex((m) => m.id === msg.id),
                          );
                          const sel = () => curMsg()?.id === msg.id;
                          const collapsed = () =>
                            blobIsCollapsed(
                              sec.blobID ? map()?.blobs[sec.blobID] : undefined,
                            );
                          const badge = () => {
                            if (msg.hidden) return " [hidden]";
                            if (collapsed()) return "";
                            const blobF = sec.fidelity ?? "full";
                            if (
                              msg.fidelityOverride === "full" &&
                              blobF !== "full"
                            )
                              return " [full override]";
                            if (
                              msg.fidelityOverride === "summary" &&
                              blobF !== "summary"
                            )
                              return " [summary override]";
                            if (
                              blobF === "summary" &&
                              msg.fidelityOverride === "inherit"
                            )
                              return " [summarized]";
                            return "";
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
                              <text
                                fg={
                                  collapsed()
                                    ? t().border
                                    : sel()
                                      ? t().text
                                      : t().textMuted
                                }
                              >
                                {sel() ? ">" : " "}{" "}
                                {msg.role === "user" ? "U" : "A"}{" "}
                                {trim(msg.summary, 80)}
                                <span
                                  style={{
                                    fg: msg.hidden ? t().error : t().warning,
                                  }}
                                >
                                  {badge()}
                                </span>
                              </text>
                              <Show when={sel() && !collapsed()}>
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
                              <Show when={sel() && collapsed()}>
                                <text fg={t().border} paddingLeft={3}>
                                  blob is{" "}
                                  {sec.fidelity === "drop"
                                    ? "hidden"
                                    : sec.fidelity}{" "}
                                  -- set to Full or Summary first
                                </text>
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

function HistoryDialog(props: {
  api: TuiPluginApi;
  history: HistoryState;
  currentSessionID?: string;
  close: () => void;
}) {
  const [bi, setBi] = createSignal(0);
  const [zoom, setZoom] = createSignal<"summary" | "full">("summary");
  const [content, setContent] = createSignal("");
  const [map, setMap] = createSignal<ContextMapFile>();
  const [askStatus, setAskStatus] = createSignal<string>("");

  const blobs = createMemo(() => props.history.overview.blobs);

  const load = async (z: "summary" | "full") => {
    const b = blobs()[Math.min(bi(), Math.max(0, blobs().length - 1))];
    if (!b) return;
    setZoom(z);
    const m = await ensureHistorical(props.api, props.history.sessionID);
    setMap(m);
    if (z === "summary") {
      setContent(
        buildSessionZoomText({ map: m, blobID: b.id, fidelity: "compressed" }),
      );
      return;
    }
    const raw =
      (
        await props.api.client.session.messages({
          sessionID: props.history.sessionID,
          directory: props.api.state.path.directory,
          limit: 5000,
        })
      )?.data ?? [];
    setContent(
      buildSessionZoomText({
        map: m,
        blobID: b.id,
        fidelity: "full",
        messages: toMessageLikes(raw),
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
      void load("summary");
      return;
    }
    if (evt.name === "2") {
      stop();
      void load("full");
      return;
    }
    if (evt.name === "a") {
      stop();
      void askAgentAboutBlame(props.api, props.currentSessionID, props.history)
        .then(() => {
          setAskStatus("Queued agent investigation in chat.");
          props.api.ui.toast({
            variant: "info",
            message: "Queued blame investigation in the current chat.",
          });
          props.close();
        })
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          setAskStatus(message);
          props.api.ui.toast({
            variant: "error",
            message,
          });
        });
      return;
    }
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
            verticalScrollbarOptions={{
              trackOptions: {
                backgroundColor: t().backgroundElement,
                foregroundColor: t().border,
              },
            }}
            viewportOptions={{ paddingRight: 1 }}
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
          <text fg={t().textMuted}>Zoom: {zoom()} (1 summary 2 full)</text>
          <scrollbox
            maxHeight={12}
            verticalScrollbarOptions={{
              trackOptions: {
                backgroundColor: t().backgroundElement,
                foregroundColor: t().border,
              },
            }}
            viewportOptions={{ paddingRight: 1 }}
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
      <Show when={askStatus()}>
        <text fg={t().textMuted}>{askStatus()}</text>
      </Show>
      <text fg={t().textMuted}>
        j/k navigate 1 summary 2 full a ask agent q close
      </text>
    </box>
  );
}

const tui: TuiPlugin = async (api) => {
  const keys = api.keybind.create({
    plugin_context_open: "<leader>'",
  });

  const openMap = (sessionID?: string) => {
    const id = sessionID ?? currentSession(api);
    if (!id) {
      api.ui.toast({
        variant: "error",
        message: "No active session",
      });
      return;
    }
    const dialog = api.ui.dialog;
    dialog.setSize("xlarge");
    dialog.replace(
      () => (
        <MemMapDialog api={api} sessionID={id} close={() => dialog.clear()} />
      ),
      () => {},
    );
    queueMicrotask(() => dialog.setSize("xlarge"));
  };

  const openBlame = () => {
    const current = currentSession(api);
    const P = api.ui.DialogPrompt;
    const dialog = api.ui.dialog;
    dialog.replace(() => (
      <P
        title="Blame lookup"
        placeholder="src/auth.ts:42"
        onConfirm={(v: string) => {
          dialog.clear();
          void runBlame(api, v)
            .then((h) => {
              dialog.setSize("xlarge");
              dialog.replace(
                () => (
                  <HistoryDialog
                    api={api}
                    history={h}
                    currentSessionID={current}
                    close={() => dialog.clear()}
                  />
                ),
                () => {},
              );
              queueMicrotask(() => dialog.setSize("xlarge"));
            })
            .catch((e) =>
              api.ui.toast({
                variant: "error",
                message: e instanceof Error ? e.message : String(e),
              }),
            );
        }}
        onCancel={() => dialog.clear()}
      />
    ));
  };

  api.command.register(() => [
    {
      title: "Open context map",
      value: "context-map.open",
      category: "Plugin",
      keybind: keys.get("plugin_context_open"),
      slash: { name: "context" },
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
        return (
          <SidebarView
            api={api}
            sessionID={value.session_id}
            onOpen={() => openMap(value.session_id)}
          />
        );
      },
    },
  });

  api.lifecycle.onDispose(() => {});
};

const plugin: TuiPluginModule = { id: PLUGIN_ID, tui };
export default plugin;
