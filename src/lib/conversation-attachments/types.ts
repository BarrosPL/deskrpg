/** Browser-safe conversation and original-file metadata. */
export type ConversationRef = { kind: "dm" | "room" | "meeting"; id: string };
export type FileMeta = {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  sha256: string;
};
export type AttachmentState =
  "uploading" | "stored" | "preparing" | "ready" | "failed" | "excluded" | "deleted";
export type AttachmentErrorCode =
  | "attachment_not_found"
  | "attachment_too_large"
  | "attachment_count_exceeded"
  | "attachment_checksum_mismatch"
  | "attachment_conflict"
  | "attachment_backend_unsupported"
  | "attachment_prepare_failed"
  | "attachment_quota_exceeded"
  | "attachment_feature_unavailable"
  | "attachment_invalid_file"
  | "attachment_invalid_selection";
export type FileView = FileMeta & { state: AttachmentState; errorCode?: AttachmentErrorCode };
export const CONVERSATION_FILES_CAPABILITY = "conversation_files_v1";
export const ORIGINAL_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const ORIGINAL_FILE_MAX_COUNT = 3;
