import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAnnotationEnvelope,
  applyAssistantAnnotation,
  buildBlobMessageSummaries,
  buildFallbackMapFromMessages,
  buildHistoricalOverview,
  buildPlaceholderText,
  buildMessageDetail,
  capturePendingRetroactiveMessage,
  parseAnnotationBlock,
  resetMapAfterCompaction,
  transformMessagesForContext,
  updateBlobFidelity,
  updateMessageControls,
} from "../src/context-map/core";
import { createEmptyContextMap } from "../src/context-map/storage";
import type { MessageLike } from "../src/context-map/types";

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  createdAt: number,
): MessageLike {
  return {
    info: {
      id,
      role,
      metadata: {
        time: {
          created: createdAt,
        },
      },
    },
    parts: [
      {
        id: `${id}-part`,
        type: "text",
        text,
      },
    ],
  };
}

function toolOnlyMessage(
  id: string,
  tool: string,
  createdAt: number,
): MessageLike {
  return {
    info: {
      id,
      role: "assistant",
      metadata: {
        time: {
          created: createdAt,
        },
      },
    },
    parts: [
      {
        id: `${id}-tool`,
        type: "tool",
        callID: `${id}-call`,
        messageID: id,
        tool,
        state: {
          status: "completed",
          title: `Ran ${tool}`,
          output: "ok",
        },
      },
    ],
  };
}

test("parseAnnotationBlock extracts annotation and strips visible text", () => {
  const parsed = parseAnnotationBlock(
    `Visible answer\n<annotation>{"blob":"auth_debugging","is_new_blob":false,"message_summary":"Found the race.","blob_summary":"Investigated auth race condition.","placeholder":"Auth race condition investigation","key_facts":["line 42"]}</annotation>`,
  );

  assert.equal(parsed.cleanText, "Visible answer");
  assert.equal(parsed.annotation?.current.blob, "auth_debugging");
  assert.deepEqual(parsed.annotation?.current.key_facts, ["line 42"]);
  assert.deepEqual(parsed.annotation?.retroactive, []);
});

test("parseAnnotationBlock supports current plus retroactive annotation envelope", () => {
  const parsed = parseAnnotationBlock(
    `Visible answer\n<annotation>{"current":{"blob":"docs_update","is_new_blob":false,"message_summary":"Updated docs.","blob_summary":"Updated onboarding docs.","placeholder":"Docs update","key_facts":["quickstart docs"]},"retroactive":[{"message_id":"msg-tool","blob":"auth_debugging","message_summary":"Ran auth concurrency tests.","key_facts":["mutex failed tests"]}]}</annotation>`,
  );

  assert.equal(parsed.annotation?.current.blob, "docs_update");
  assert.equal(parsed.annotation?.retroactive[0]?.message_id, "msg-tool");
  assert.deepEqual(parsed.annotation?.retroactive[0]?.key_facts, [
    "mutex failed tests",
  ]);
});

test("applyAssistantAnnotation assigns pending user and assistant messages to the annotated blob", () => {
  const user = message(
    "msg-user",
    "user",
    "Why is line 42 using an async queue?",
    1,
  );
  const assistant = message(
    "msg-assistant",
    "assistant",
    "It was changed after the mutex failed.",
    2,
  );
  const map = createEmptyContextMap({ sessionID: "ses-test" });

  const next = applyAssistantAnnotation({
    map,
    messages: [user, assistant],
    assistantMessageID: "msg-assistant",
    annotation: {
      blob: "auth_debugging",
      is_new_blob: true,
      message_summary:
        "Explained that the mutex approach failed tests and the code switched to an async queue.",
      blob_summary:
        "Investigated auth debugging and captured the failed mutex attempt before switching to an async queue.",
      placeholder: "Debugging auth race condition",
      key_facts: ["mutex failed tests", "async queue on line 42"],
    },
  });

  assert.equal(next.blobOrder.length, 1);
  assert.equal(next.messages["msg-user"]?.blobID, "auth_debugging");
  assert.equal(next.messages["msg-assistant"]?.blobID, "auth_debugging");
  assert.equal(next.messages["msg-assistant"]?.source, "annotation");
  assert.deepEqual(next.blobs.auth_debugging?.keyFacts, [
    "mutex failed tests",
    "async queue on line 42",
  ]);
});

test("updateBlobFidelity refuses agent overrides of user-controlled blobs without force", () => {
  const map = createEmptyContextMap({ sessionID: "ses-test" });
  map.blobs.auth_debugging = {
    id: "auth_debugging",
    label: "auth_debugging",
    summary: "Summary",
    placeholder: "Placeholder",
    keyFacts: [],
    fidelity: "compressed",
    fidelitySource: "user",
    messageIDs: [],
    tokenEstimate: 10,
    createdAt: 1,
    lastActiveAt: 1,
    commitHashes: [],
  };
  map.blobOrder.push("auth_debugging");

  const denied = updateBlobFidelity({
    map,
    blobID: "auth_debugging",
    fidelity: "drop",
    source: "agent",
  });

  assert.equal(denied.ok, false);
  assert.equal(map.blobs.auth_debugging?.fidelity, "compressed");

  const forced = updateBlobFidelity({
    map,
    blobID: "auth_debugging",
    fidelity: "drop",
    source: "agent",
    force: true,
  });

  assert.equal(forced.ok, true);
  assert.equal(map.blobs.auth_debugging?.fidelity, "drop");
});

test("transformMessagesForContext compresses a blob to one synthetic summary message", () => {
  const user = message(
    "msg-user",
    "user",
    "Why is line 42 using an async queue?",
    1,
  );
  const assistant = message(
    "msg-assistant",
    "assistant",
    "It was changed after the mutex failed.",
    2,
  );
  const map = createEmptyContextMap({ sessionID: "ses-test" });
  map.blobs.auth_debugging = {
    id: "auth_debugging",
    label: "auth_debugging",
    summary:
      "Investigated the auth race and switched from a mutex to an async queue.",
    placeholder: "Auth race condition investigation",
    keyFacts: ["line 42", "mutex failed tests"],
    fidelity: "compressed",
    fidelitySource: "user",
    messageIDs: ["msg-user", "msg-assistant"],
    tokenEstimate: 20,
    createdAt: 1,
    lastActiveAt: 2,
    commitHashes: [],
  };
  map.blobOrder.push("auth_debugging");
  map.messages["msg-user"] = {
    id: "msg-user",
    role: "user",
    blobID: "auth_debugging",
    summary: "Asked why line 42 uses an async queue.",
    keyFacts: [],
    hidden: false,
    hiddenSource: "default",
    fidelityOverride: "inherit",
    fidelitySource: "default",
    tokenEstimate: 5,
    createdAt: 1,
    updatedAt: 1,
    source: "derived",
    partTypes: ["text"],
    toolNames: [],
  };
  map.messages["msg-assistant"] = {
    id: "msg-assistant",
    role: "assistant",
    blobID: "auth_debugging",
    summary: "Explained the async queue change.",
    keyFacts: ["mutex failed tests"],
    hidden: false,
    hiddenSource: "default",
    fidelityOverride: "inherit",
    fidelitySource: "default",
    tokenEstimate: 15,
    createdAt: 2,
    updatedAt: 2,
    source: "annotation",
    partTypes: ["text"],
    toolNames: [],
  };

  const transformed = transformMessagesForContext([user, assistant], map);

  assert.equal(transformed.length, 1);
  assert.match(
    (transformed[0]?.parts[0] as { text?: string })?.text ?? "",
    /Blob summary: auth_debugging/,
  );
});

test("buildFallbackMapFromMessages creates reusable blobs for repeated topics", () => {
  const map = buildFallbackMapFromMessages({
    sessionID: "ses-test",
    messages: [
      message("u1", "user", "Investigate auth race condition in line 42", 1),
      message(
        "a1",
        "assistant",
        "The auth queue replaced the mutex after failures.",
        2,
      ),
      message("u2", "user", "Outline onboarding docs for API contributors", 3),
      message(
        "a2",
        "assistant",
        "Create quickstart, contribution, and API overview docs.",
        4,
      ),
      message(
        "u3",
        "user",
        "Investigate auth race condition again and mention the queue",
        5,
      ),
      message(
        "a3",
        "assistant",
        "The queue stayed because the mutex failed tests.",
        6,
      ),
    ],
  });

  assert.equal(map.blobOrder.length, 2);
  assert.equal(map.blobs[map.blobOrder[0]!]!.messageIDs.length, 4);
  assert.equal(map.blobs[map.blobOrder[1]!]!.messageIDs.length, 2);
  assert.equal(map.blobs[map.blobOrder[0]!]!.fidelity, "full");
});

test("buildFallbackMapFromMessages honors explicit topic switches", () => {
  const map = buildFallbackMapFromMessages({
    sessionID: "ses-test",
    messages: [
      message(
        "u1",
        "user",
        "Investigate API contributor auth race condition in line 42",
        1,
      ),
      message(
        "a1",
        "assistant",
        "The API contributor auth queue replaced the mutex after failures.",
        2,
      ),
      message(
        "u2",
        "user",
        "Now switch topics and outline onboarding docs for API contributors.",
        3,
      ),
      message(
        "a2",
        "assistant",
        "Create quickstart, contribution, and API overview docs.",
        4,
      ),
    ],
  });

  assert.equal(map.blobOrder.length, 2);
  assert.equal(map.messages.u2?.blobID, map.blobOrder[1]);
  assert.equal(map.messages.a2?.blobID, map.blobOrder[1]);
});

test("historical overview exposes compressed blob summaries", () => {
  const map = createEmptyContextMap({ sessionID: "ses-history" });
  map.blobs.auth_history = {
    id: "auth_history",
    label: "auth_history",
    summary: "Investigated auth queue behavior and kept the async queue fix.",
    placeholder: "Auth queue history",
    keyFacts: ["async queue fix"],
    fidelity: "summary",
    fidelitySource: "system",
    messageIDs: ["msg-h1"],
    tokenEstimate: 42,
    createdAt: 1,
    lastActiveAt: 1,
    commitHashes: [],
  };
  map.blobOrder.push("auth_history");

  const overview = buildHistoricalOverview({
    map,
    session: { id: "ses-history", title: "Auth history" },
    matchedBlobIDs: ["auth_history"],
  });

  assert.equal(overview.blobs[0]?.messageCount, 1);
  assert.match(
    overview.blobs[0]?.compressedSummary ?? "",
    /Blob summary: auth_history/,
  );
});

test("blob message summaries and single message detail support progressive historical zoom", () => {
  const fullMessage = message(
    "msg-h1",
    "assistant",
    "The mutex failed tests, so the async queue stayed.",
    1,
  );
  const map = createEmptyContextMap({ sessionID: "ses-history" });
  map.blobs.auth_history = {
    id: "auth_history",
    label: "auth_history",
    summary: "Investigated auth queue behavior.",
    placeholder: "Auth queue history",
    keyFacts: ["async queue fix"],
    fidelity: "summary",
    fidelitySource: "system",
    messageIDs: ["msg-h1"],
    tokenEstimate: 42,
    createdAt: 1,
    lastActiveAt: 1,
    commitHashes: [],
  };
  map.blobOrder.push("auth_history");
  map.messages["msg-h1"] = {
    id: "msg-h1",
    role: "assistant",
    blobID: "auth_history",
    summary: "Explained why the async queue stayed.",
    keyFacts: ["mutex failed tests"],
    hidden: false,
    hiddenSource: "default",
    fidelityOverride: "inherit",
    fidelitySource: "default",
    tokenEstimate: 42,
    createdAt: 1,
    updatedAt: 1,
    source: "annotation",
    partTypes: ["text"],
    toolNames: [],
  };

  const summaries = buildBlobMessageSummaries({
    map,
    blobID: "auth_history",
  });
  assert.equal(summaries.ok, true);
  assert.equal(summaries.messages[0]?.id, "msg-h1");
  assert.equal(
    summaries.messages[0]?.summary,
    "Explained why the async queue stayed.",
  );

  const detail = buildMessageDetail({
    map,
    messageID: "msg-h1",
    messages: [fullMessage],
  });
  assert.equal(detail.ok, true);
  const detailText =
    detail.message.parts[0]?.type === "text"
      ? (detail.message.parts[0].text ?? "")
      : "";
  assert.match(detailText, /mutex failed tests/);
});

test("retroactive annotation captures tool-only messages and clears pending state", () => {
  const user = message(
    "msg-user",
    "user",
    "Investigate the auth race condition on line 42",
    1,
  );
  const tool = toolOnlyMessage("msg-tool", "bash", 2);
  const assistant = message(
    "msg-assistant",
    "assistant",
    "The mutex failed tests, so the async queue stayed.",
    3,
  );
  const map = createEmptyContextMap({ sessionID: "ses-test" });

  capturePendingRetroactiveMessage({
    map,
    messages: [user, tool, assistant],
    messageID: "msg-tool",
    suggestedBlobID: "auth_debugging",
  });

  assert.equal(
    map.pendingRetroactive["msg-tool"]?.suggestedBlobID,
    "auth_debugging",
  );

  const next = applyAnnotationEnvelope({
    map,
    messages: [user, tool, assistant],
    assistantMessageID: "msg-assistant",
    annotation: {
      current: {
        blob: "auth_debugging",
        is_new_blob: false,
        message_summary:
          "Explained that the mutex failed tests and the async queue remained the fix.",
        blob_summary:
          "Investigated the auth race and kept the async queue after the mutex failed tests.",
        placeholder: "Auth race condition investigation",
        key_facts: ["mutex failed tests", "async queue final fix"],
      },
      retroactive: [
        {
          message_id: "msg-tool",
          blob: "auth_debugging",
          message_summary:
            "Ran the auth concurrency reproduction and confirmed the mutex failed tests.",
          key_facts: ["mutex failed tests"],
        },
      ],
    },
  });

  assert.equal(next.messages["msg-tool"]?.blobID, "auth_debugging");
  assert.equal(next.messages["msg-tool"]?.source, "annotation");
  assert.equal(next.pendingRetroactive["msg-tool"], undefined);
});

// ── compaction reset ───────────────────────────────────────────────────

test("resetMapAfterCompaction removes old blobs from the live map", () => {
  const map = createEmptyContextMap({ sessionID: "ses-test" });
  map.settings.placeholderIncludesKeyFacts = false;
  map.blobs.auth_race_bug = {
    id: "auth_race_bug",
    label: "auth_race_bug",
    summary: "Debugged an auth race.",
    placeholder: "Auth race debugging",
    keyFacts: ["mutex failed"],
    fidelity: "full",
    fidelitySource: "user",
    messageIDs: ["old-user", "old-assistant"],
    tokenEstimate: 100,
    createdAt: 1,
    lastActiveAt: 2,
    commitHashes: [],
  };
  map.blobs.docs_cleanup = {
    id: "docs_cleanup",
    label: "docs_cleanup",
    summary: "Updated docs.",
    placeholder: "Docs cleanup",
    keyFacts: [],
    fidelity: "drop",
    fidelitySource: "user",
    messageIDs: [],
    tokenEstimate: 0,
    createdAt: 3,
    lastActiveAt: 3,
    commitHashes: [],
  };
  map.blobOrder.push("auth_race_bug", "docs_cleanup");
  map.pendingRetroactive["old-tool"] = {
    messageID: "old-tool",
    summary: "Ran old tests.",
    toolNames: ["bash"],
    tokenEstimate: 10,
    createdAt: 2,
  };

  const reset = resetMapAfterCompaction({
    map,
    summaryText: "Compacted summary of the auth work.",
    summaryMessageID: "cmp-assistant",
    compactedAt: 10,
    includeMessageID: "tail-user",
    archivePath: "/tmp/archive.json",
  });

  assert.deepEqual(reset.blobOrder, ["session_summary"]);
  assert.equal(reset.blobs.auth_race_bug, undefined);
  assert.equal(reset.blobs.docs_cleanup, undefined);
  assert.equal(reset.messages["old-user"], undefined);
  assert.equal(reset.pendingRetroactive["old-tool"], undefined);
  assert.equal(reset.settings.placeholderIncludesKeyFacts, false);
  assert.equal(reset.compaction?.summaryMessageID, "cmp-assistant");
  assert.equal(reset.compaction?.includeMessageID, "tail-user");
  assert.equal(reset.compaction?.archivePath, "/tmp/archive.json");
  assert.equal(reset.blobs.session_summary?.fidelity, "summary");
  assert.equal(reset.messages["cmp-assistant"]?.blobID, "session_summary");
});

test("resetMapAfterCompaction placeholders all-historical summaries", () => {
  const map = createEmptyContextMap({ sessionID: "ses-test" });
  map.blobs.auth_history = {
    id: "auth_history",
    label: "auth_history",
    summary: "Old auth work that should not remain the current goal.",
    placeholder: "Old auth work",
    keyFacts: [],
    fidelity: "drop",
    fidelitySource: "agent",
    messageIDs: ["old-user"],
    tokenEstimate: 100,
    createdAt: 1,
    lastActiveAt: 1,
    commitHashes: [],
  };
  map.blobs.docs_history = {
    id: "docs_history",
    label: "docs_history",
    summary: "Old docs work.",
    placeholder: "Old docs work",
    keyFacts: [],
    fidelity: "placeholder",
    fidelitySource: "agent",
    messageIDs: ["old-assistant"],
    tokenEstimate: 20,
    createdAt: 2,
    lastActiveAt: 2,
    commitHashes: [],
  };
  map.blobOrder.push("auth_history", "docs_history");

  const reset = resetMapAfterCompaction({
    map,
    summaryText: "## Goal\nContinue the auth rate limiter race.",
    summaryMessageID: "cmp-assistant",
    compactedAt: 10,
  });

  assert.equal(reset.blobs.session_summary?.fidelity, "placeholder");
  assert.equal(
    reset.blobs.session_summary?.placeholder,
    "Historical context compacted",
  );
});

test("buildPlaceholderText supports stable cache-friendly placeholders", () => {
  const map = createEmptyContextMap({ sessionID: "ses-test" });
  map.settings.stablePlaceholders = true;
  const blob = {
    id: "auth_history",
    label: "auth_history",
    summary: "Old auth work.",
    placeholder: "Old auth work",
    keyFacts: ["mutex failed"],
    fidelity: "placeholder" as const,
    fidelitySource: "system" as const,
    messageIDs: [],
    tokenEstimate: 1234,
    createdAt: 1,
    lastActiveAt: 1,
    commitHashes: [],
  };

  assert.equal(
    buildPlaceholderText(map, blob),
    "[Context hidden: auth_history]",
  );
});

test("transformMessagesForContext drops pre-compaction messages after reset", () => {
  const old = message("old-user", "user", "Old auth race details", 1);
  const summary = message(
    "cmp-assistant",
    "assistant",
    "Compacted summary of the useful work.",
    10,
  );
  const next = message("new-user", "user", "What should we do next?", 11);
  const map = resetMapAfterCompaction({
    map: createEmptyContextMap({ sessionID: "ses-test" }),
    summaryText: "Compacted summary of the useful work.",
    summaryMessageID: "cmp-assistant",
    compactedAt: 10,
  });

  const transformed = transformMessagesForContext([old, summary, next], map);

  assert.deepEqual(
    transformed.map((item) => item.info.id),
    ["cmp-assistant", "new-user"],
  );
  assert.match(
    (transformed[0]?.parts[0] as { text?: string })?.text ?? "",
    /Message summary/,
  );
});

test("applyAssistantAnnotation ignores pre-compaction history", () => {
  const old = message("old-user", "user", "Old docs cleanup chatter", 1);
  const summary = message(
    "cmp-assistant",
    "assistant",
    "Compacted summary of the useful work.",
    10,
  );
  const user = message("new-user", "user", "Continue the auth fix", 11);
  const assistant = message(
    "new-assistant",
    "assistant",
    "Next we should add the queue regression test.",
    12,
  );
  const map = resetMapAfterCompaction({
    map: createEmptyContextMap({ sessionID: "ses-test" }),
    summaryText: "Compacted summary of the useful work.",
    summaryMessageID: "cmp-assistant",
    compactedAt: 10,
  });

  const next = applyAssistantAnnotation({
    map,
    messages: [old, summary, user, assistant],
    assistantMessageID: "new-assistant",
    annotation: {
      blob: "auth_followup",
      is_new_blob: true,
      message_summary: "Planned the queue regression test.",
      blob_summary: "Continued auth queue follow-up after compaction.",
      placeholder: "Auth queue follow-up",
      key_facts: ["add queue regression test"],
    },
  });

  assert.equal(next.messages["old-user"], undefined);
  assert.equal(next.messages["cmp-assistant"]?.blobID, "session_summary");
  assert.equal(next.messages["new-user"]?.blobID, "auth_followup");
  assert.equal(next.messages["new-assistant"]?.blobID, "auth_followup");
});

// ── updateMessageControls fidelity normalization ────────────────────────

test("updateMessageControls normalizes redundant summary override to inherit when blob is summary", () => {
  const map = createEmptyContextMap({ sessionID: "ses-test" });
  map.blobs.topic_a = {
    id: "topic_a",
    label: "topic_a",
    summary: "Topic A summary",
    placeholder: "Topic A placeholder",
    keyFacts: [],
    fidelity: "summary",
    fidelitySource: "user",
    messageIDs: ["msg-1"],
    tokenEstimate: 100,
    createdAt: 1,
    lastActiveAt: 1,
    commitHashes: [],
  };
  map.blobOrder.push("topic_a");
  map.messages["msg-1"] = {
    id: "msg-1",
    role: "user",
    blobID: "topic_a",
    summary: "Asked about topic A.",
    keyFacts: [],
    hidden: false,
    hiddenSource: "default",
    fidelityOverride: "inherit",
    fidelitySource: "default",
    tokenEstimate: 50,
    createdAt: 1,
    updatedAt: 1,
    source: "derived",
    partTypes: ["text"],
    toolNames: [],
  };

  // Setting message to "summary" when blob is already "summary" -- should normalize to "inherit"
  const result = updateMessageControls({
    map,
    messageID: "msg-1",
    fidelityOverride: "summary",
    source: "user",
  });

  assert.equal(result.ok, true);
  assert.equal(map.messages["msg-1"]?.fidelityOverride, "inherit");
  assert.equal(map.messages["msg-1"]?.fidelitySource, "user");
});

test("updateMessageControls normalizes redundant full override to inherit when blob is full", () => {
  const map = createEmptyContextMap({ sessionID: "ses-test" });
  map.blobs.topic_b = {
    id: "topic_b",
    label: "topic_b",
    summary: "Topic B summary",
    placeholder: "Topic B placeholder",
    keyFacts: [],
    fidelity: "full",
    fidelitySource: "default",
    messageIDs: ["msg-2"],
    tokenEstimate: 200,
    createdAt: 1,
    lastActiveAt: 1,
    commitHashes: [],
  };
  map.blobOrder.push("topic_b");
  map.messages["msg-2"] = {
    id: "msg-2",
    role: "assistant",
    blobID: "topic_b",
    summary: "Explained topic B.",
    keyFacts: [],
    hidden: false,
    hiddenSource: "default",
    fidelityOverride: "inherit",
    fidelitySource: "default",
    tokenEstimate: 100,
    createdAt: 1,
    updatedAt: 1,
    source: "annotation",
    partTypes: ["text"],
    toolNames: [],
  };

  // Setting message to "full" when blob is already "full" -- should normalize to "inherit"
  const result = updateMessageControls({
    map,
    messageID: "msg-2",
    fidelityOverride: "full",
    source: "agent",
  });

  assert.equal(result.ok, true);
  assert.equal(map.messages["msg-2"]?.fidelityOverride, "inherit");
  assert.equal(map.messages["msg-2"]?.fidelitySource, "agent");
});

test("updateMessageControls preserves meaningful override (full within summary blob)", () => {
  const map = createEmptyContextMap({ sessionID: "ses-test" });
  map.blobs.topic_c = {
    id: "topic_c",
    label: "topic_c",
    summary: "Topic C summary",
    placeholder: "Topic C placeholder",
    keyFacts: [],
    fidelity: "summary",
    fidelitySource: "user",
    messageIDs: ["msg-3"],
    tokenEstimate: 150,
    createdAt: 1,
    lastActiveAt: 1,
    commitHashes: [],
  };
  map.blobOrder.push("topic_c");
  map.messages["msg-3"] = {
    id: "msg-3",
    role: "assistant",
    blobID: "topic_c",
    summary: "Explained topic C.",
    keyFacts: [],
    hidden: false,
    hiddenSource: "default",
    fidelityOverride: "inherit",
    fidelitySource: "default",
    tokenEstimate: 80,
    createdAt: 1,
    updatedAt: 1,
    source: "annotation",
    partTypes: ["text"],
    toolNames: [],
  };

  // Setting message to "full" when blob is "summary" -- meaningful override, keep it
  const result = updateMessageControls({
    map,
    messageID: "msg-3",
    fidelityOverride: "full",
    source: "user",
  });

  assert.equal(result.ok, true);
  assert.equal(map.messages["msg-3"]?.fidelityOverride, "full");
  assert.equal(map.messages["msg-3"]?.fidelitySource, "user");
});

test("updateMessageControls preserves meaningful override (summary within full blob)", () => {
  const map = createEmptyContextMap({ sessionID: "ses-test" });
  map.blobs.topic_d = {
    id: "topic_d",
    label: "topic_d",
    summary: "Topic D summary",
    placeholder: "Topic D placeholder",
    keyFacts: [],
    fidelity: "full",
    fidelitySource: "default",
    messageIDs: ["msg-4"],
    tokenEstimate: 300,
    createdAt: 1,
    lastActiveAt: 1,
    commitHashes: [],
  };
  map.blobOrder.push("topic_d");
  map.messages["msg-4"] = {
    id: "msg-4",
    role: "user",
    blobID: "topic_d",
    summary: "Asked about topic D.",
    keyFacts: [],
    hidden: false,
    hiddenSource: "default",
    fidelityOverride: "inherit",
    fidelitySource: "default",
    tokenEstimate: 60,
    createdAt: 1,
    updatedAt: 1,
    source: "derived",
    partTypes: ["text"],
    toolNames: [],
  };

  // Setting message to "summary" when blob is "full" -- meaningful override, keep it
  const result = updateMessageControls({
    map,
    messageID: "msg-4",
    fidelityOverride: "summary",
    source: "user",
  });

  assert.equal(result.ok, true);
  assert.equal(map.messages["msg-4"]?.fidelityOverride, "summary");
  assert.equal(map.messages["msg-4"]?.fidelitySource, "user");
});
