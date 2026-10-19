import type { ConversationRef, FileMeta, AttachmentErrorCode } from "./types";

/** Internal transport metadata. Never serialize these objects to a browser. */
export type PrepareTarget = { npcId: string; profileName: string; sessionKey: string; sessionId: string };
export type PrepareRequest = {
  requestId: string;
  conversation: ConversationRef;
  revision: number;
  fileIds: string[];
  targets: PrepareTarget[];
};
export type PreparedFile = FileMeta & { agentPath: string; leaseId: string; expiresAt: string };
export type PrepareResult =
  | { ok: true; revision: number; byNpc: Record<string, PreparedFile[]> }
  | {
      ok: false;
      revision: number;
      failures: { npcId: string; fileId: string; errorCode: AttachmentErrorCode }[];
    };
