import type { ConversationRef, FileMeta, AttachmentErrorCode } from "./types";

/** Internal transport metadata. Never serialize these objects to a browser. */
export type PrepareTarget = {
  npcId: string;
  profileName: string;
  sessionKey: string;
  sessionId: string;
};
export type PrepareRequest = {
  requestId: string;
  conversation: ConversationRef;
  revision: number;
  fileIds: string[];
  targets: PrepareTarget[];
};
export type PreparedFile = FileMeta & {
  /** Hermes tool identifier; absent only in requests persisted before this field existed. */
  pluginFileId?: string;
  agentPath: string;
  leaseId: string;
  expiresAt: string;
};
export type PrepareResult =
  | { ok: true; revision: number; byNpc: Record<string, PreparedFile[]> }
  | {
      ok: false;
      revision: number;
      failures: { npcId: string; fileId: string; errorCode: AttachmentErrorCode }[];
    };
