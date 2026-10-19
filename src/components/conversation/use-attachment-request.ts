"use client";
import { useCallback, useEffect, useState } from "react";
import type { ConversationRef } from "@/lib/conversation-attachments/types";
export type AttachmentRequestView = { requestId: string; state: string; errorCode?: string };
export function useAttachmentRequest(
  channelId: string | undefined,
  conversation: ConversationRef | undefined,
  onChange: () => Promise<void>,
) {
  const [request, setRequest] = useState<AttachmentRequestView | null>(null);
  const key =
    channelId && conversation
      ? `deskrpg:attachment-request:${channelId}:${conversation.kind}:${conversation.id}`
      : "";
  useEffect(() => {
    try {
      const id = key ? sessionStorage.getItem(key) : null;
      setRequest(id ? { requestId: id, state: "pending" } : null);
    } catch {
      setRequest(null);
    }
  }, [key]);
  const kind = conversation?.kind;
  const conversationId = conversation?.id;
  const requestId = request?.requestId;
  const requestState = request?.state;
  const url = useCallback(
    (id: string, action = "") =>
      `/api/channels/${encodeURIComponent(channelId!)}/conversation-files/requests/${encodeURIComponent(id)}${action}?${new URLSearchParams({ kind: kind!, id: conversationId! })}`,
    [channelId, kind, conversationId],
  );
  useEffect(() => {
    if (
      !key ||
      !requestId ||
      ["done", "cancelled", "failed", "outcome_unknown"].includes(requestState!)
    )
      return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(url(requestId));
        if (response.ok) {
          const data = await response.json();
          if (!cancelled) {
            setRequest(data);
            void onChange();
          }
        }
      } catch {
      } finally {
        if (!cancelled) timer = setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, requestId, requestState, url, onChange]);
  const start = (requestId: string) => {
    setRequest({ requestId, state: "pending" });
    try {
      sessionStorage.setItem(key, requestId);
    } catch {}
  };
  const action = async (action: "retry" | "cancel" | "exclude", fileIds?: string[]) => {
    if (!request) return;
    try {
      const response = await fetch(url(request.requestId, `/${action}`), {
        method: "POST",
        ...(fileIds
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileIds }) }
          : {}),
      });
      if (response.ok) {
        const data = await response.json();
        setRequest(
          data.requestId
            ? data
            : {
                requestId: request.requestId,
                state: action === "cancel" ? "cancelled" : "pending",
              },
        );
        void onChange();
      } else {
        const data = await response.json().catch(() => ({}));
        setRequest({ ...request, errorCode: data.error ?? "attachment_prepare_failed" });
      }
    } catch {
      setRequest({ ...request, errorCode: "attachment_prepare_failed" });
    }
  };
  return {
    request,
    start,
    retry: () => action("retry"),
    cancel: () => action("cancel"),
    exclude: (fileIds: string[]) => action("exclude", fileIds),
  };
}
