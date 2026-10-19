"use client";
import { useRef, useEffect } from "react";
import { useAttachmentRequest, type AttachmentRequestView } from "./use-attachment-request";
import ChatInput, { type ChatInputProps } from "../ChatInput";
import { useT } from "@/lib/i18n";
import type { ConversationRef } from "@/lib/conversation-attachments/types";
import AttachmentTray from "./AttachmentTray";
import {
  useConversationAttachments,
  type AttachmentSendPayload,
} from "./use-conversation-attachments";

export default function ConversationChatInput({
  channelId,
  conversation,
  onSend,
  canControlAttachments = true,
  attachmentRequest,
  ...props
}: Omit<ChatInputProps, "onSend"> & {
  canControlAttachments?: boolean;
  attachmentRequest?: AttachmentRequestView;
  channelId?: string;
  conversation?: ConversationRef;
  onSend: (
    message: string,
    files?: File[],
    skills?: string[],
    attachments?: AttachmentSendPayload,
  ) => void;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const attachments = useConversationAttachments({ channelId, conversation });
  const execution = useAttachmentRequest(channelId, conversation, attachments.refresh);
  const observeRequest = execution.observe;
  useEffect(() => {
    if (attachmentRequest) observeRequest(attachmentRequest);
  }, [attachmentRequest, observeRequest]);
  return (
    <div>
      {conversation && (
        <>
          <AttachmentTray
            files={attachments.files}
            selectedIds={attachments.selectedIds}
            sharedScope={conversation.kind}
            onSelect={attachments.select}
            onRetry={(id) => void attachments.retry(id)}
            onRemove={(id) => void attachments.remove(id)}
            onCancel={attachments.cancel}
            onExclude={
              conversation.kind === "meeting" &&
              canControlAttachments &&
              execution.request?.state === "failed"
                ? (id) => void execution.exclude([id])
                : undefined
            }
            downloadUrl={(id) => attachments.endpoint(`/${encodeURIComponent(id)}/content`)}
          />
          <div className="px-3 flex items-center gap-3 text-xs text-text-muted">
            <button
              type="button"
              disabled={
                !attachments.available || props.disabled || attachments.selectedIds.length >= 3
              }
              onClick={() => input.current?.click()}
            >
              {t("chat.attachFile")}
            </button>
            <button type="button" onClick={() => void attachments.refresh()}>
              {t("attachments.refresh")}
            </button>
            <span>{t("attachments.limit")}</span>
            <input
              ref={input}
              type="file"
              multiple
              className="hidden"
              accept=".txt,.md,.json,.csv,.pdf,.xlsx,.xls,.docx,.doc,.png,.jpg,.jpeg,.gif,.webp"
              onChange={(event) => {
                void attachments.upload(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
          </div>
        </>
      )}
      {attachments.error && (
        <p role="alert" className="px-3 text-xs text-danger">
          {t(
            attachments.error === "attachment_feature_unavailable"
              ? "attachments.unavailable"
              : attachments.error === "attachment_count_exceeded"
                ? "attachments.limit"
                : attachments.error === "attachment_too_large"
                  ? "attachments.limit"
                  : "attachments.failed",
          )}
        </p>
      )}
      {!conversation && props.scope === "meeting" && (
        <p className="px-3 text-xs text-text-muted">{t("attachments.meetingInactive")}</p>
      )}
      {execution.request && !["done", "cancelled"].includes(execution.request.state) && (
        <div role="status" className="px-3 py-2 text-xs text-text-muted">
          {t(`attachments.request.${execution.request.state}`)}
          {execution.request.errorCode && <span role="alert">{t("attachments.failed")}</span>}
          {canControlAttachments && execution.request.state === "failed" && (
            <button type="button" className="ml-2" onClick={() => void execution.retry()}>
              {t("attachments.retry")}
            </button>
          )}
          {canControlAttachments &&
            ["pending", "preparing", "ready", "failed"].includes(execution.request.state) && (
              <button type="button" className="ml-2" onClick={() => void execution.cancel()}>
                {t("attachments.cancelRequest")}
              </button>
            )}
        </div>
      )}
      <ChatInput
        {...props}
        showFileUpload={false}
        attachmentCount={attachments.selectedIds.length}
        disabled={props.disabled || attachments.busy}
        onSend={(message, _files, skills) => {
          const requestId = crypto.randomUUID();
          if (attachments.selectedIds.length) execution.start(requestId);
          onSend(
            message,
            undefined,
            skills,
            conversation && attachments.selectedIds.length
              ? {
                  attachmentIds: attachments.selectedIds,
                  attachmentRequestId: requestId,
                  attachmentConversation: conversation,
                }
              : undefined,
          );
          attachments.clearSelection();
        }}
      />
    </div>
  );
}
