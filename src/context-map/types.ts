import { z } from "zod";

export const blobFidelitySchema = z.enum([
  "full",
  "summary",
  "compressed",
  "placeholder",
  "drop",
]);
export type BlobFidelity = z.infer<typeof blobFidelitySchema>;

export const messageFidelitySchema = z.enum(["inherit", "full", "summary"]);
export type MessageFidelity = z.infer<typeof messageFidelitySchema>;

export const controlSourceSchema = z.enum([
  "default",
  "user",
  "agent",
  "system",
]);
export type ControlSource = z.infer<typeof controlSourceSchema>;

export const annotationSchema = z.object({
  blob: z.string().min(1),
  is_new_blob: z.boolean().optional().default(false),
  message_summary: z.string().min(1),
  blob_summary: z.string().min(1),
  placeholder: z.string().min(1),
  key_facts: z.array(z.string().min(1)).optional().default([]),
});
export type AnnotationPayload = z.infer<typeof annotationSchema>;

export const retroactiveAnnotationItemSchema = z.object({
  message_id: z.string().min(1),
  blob: z.string().min(1),
  message_summary: z.string().min(1),
  key_facts: z.array(z.string().min(1)).optional().default([]),
  blob_summary: z.string().min(1).optional(),
  placeholder: z.string().min(1).optional(),
});
export type RetroactiveAnnotationItem = z.infer<
  typeof retroactiveAnnotationItemSchema
>;

export const annotationEnvelopeSchema = z.object({
  current: annotationSchema,
  retroactive: z.array(retroactiveAnnotationItemSchema).optional().default([]),
});
export type AnnotationEnvelope = z.infer<typeof annotationEnvelopeSchema>;

export type BlobEntry = {
  id: string;
  label: string;
  summary: string;
  placeholder: string;
  keyFacts: string[];
  fidelity: BlobFidelity;
  fidelitySource: ControlSource;
  messageIDs: string[];
  tokenEstimate: number;
  createdAt: number;
  lastActiveAt: number;
  commitHashes: string[];
};

export type MessageEntry = {
  id: string;
  role: "user" | "assistant";
  blobID?: string;
  summary: string;
  keyFacts: string[];
  hidden: boolean;
  hiddenSource: ControlSource;
  fidelityOverride: MessageFidelity;
  fidelitySource: ControlSource;
  tokenEstimate: number;
  createdAt: number;
  updatedAt: number;
  source: "annotation" | "derived";
  partTypes: string[];
  toolNames: string[];
};

export type ContextMapSettings = {
  placeholderIncludesKeyFacts: boolean;
  placeholderIncludesKeyFactsSource: ControlSource;
  toolHistoryCleanup: boolean;
  stablePlaceholders: boolean;
  stablePlaceholdersSource: ControlSource;
  stableAnchors: boolean;
  stableAnchorsSource: ControlSource;
};

export type PendingRetroactiveMessage = {
  messageID: string;
  summary: string;
  toolNames: string[];
  tokenEstimate: number;
  createdAt: number;
  suggestedBlobID?: string;
  suggestedBlobLabel?: string;
};

export type ContextMapCompactionState = {
  compactedAt: number;
  summaryMessageID: string;
  summaryBlobID: string;
  includeMessageID?: string;
  archivePath?: string;
};

export type ContextMapFile = {
  version: 1;
  sessionID: string;
  directory?: string;
  worktree?: string;
  createdAt: number;
  updatedAt: number;
  totalTokenEstimate: number;
  lastAnnotatedMessageID?: string;
  lastActiveBlobID?: string;
  settings: ContextMapSettings;
  blobOrder: string[];
  blobs: Record<string, BlobEntry>;
  messages: Record<string, MessageEntry>;
  pendingRetroactive: Record<string, PendingRetroactiveMessage>;
  compaction?: ContextMapCompactionState;
};

export type CommitMapEntry = {
  commitHash: string;
  sessionID: string;
  timestamp: number;
  directory?: string;
  worktree?: string;
  activeBlobID?: string;
  activeBlobLabel?: string;
  activeBlobIDs: string[];
};

export type CommitMapFile = {
  version: 1;
  updatedAt: number;
  entries: Record<string, CommitMapEntry>;
};

export type SessionLike = {
  id: string;
  title?: string;
  parentID?: string;
  directory?: string;
  time?: {
    created?: number;
    updated?: number;
  };
};

export type MessageLike = {
  info: {
    id: string;
    role: "user" | "assistant";
    time?: {
      created?: number;
      updated?: number;
    };
    metadata?: {
      time?: {
        created?: number;
      };
    };
    summary?: boolean;
  };
  parts: Array<{
    id: string;
    sessionID?: string;
    messageID?: string;
    type: string;
    callID?: string;
    text?: string;
    filename?: string;
    url?: string;
    tool?: string;
    metadata?: Record<string, unknown>;
    state?: {
      status?: string;
      title?: string;
      output?: string;
      input?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };
  }>;
};

export type HistoricalSessionOverview = {
  sessionID: string;
  title: string;
  updatedAt?: number;
  matchedBlobIDs: string[];
  blobs: Array<{
    id: string;
    label: string;
    summary: string;
    compressedSummary: string;
    placeholder: string;
    tokenEstimate: number;
    messageCount: number;
    fidelity: BlobFidelity;
    keyFacts: string[];
    activeForCommit: boolean;
  }>;
};

export type ContextPreviewBlob = {
  id: string;
  label: string;
  fidelity: BlobFidelity;
  rawTokens: number;
  effectiveTokens: number;
  messageCount: number;
  effectiveLabel: string;
};

export type ContextPreview = {
  blobs: ContextPreviewBlob[];
  totalRaw: number;
  totalEffective: number;
};
