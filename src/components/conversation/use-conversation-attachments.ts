"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationRef, FileView } from "@/lib/conversation-attachments/types";
import { validateOriginalFile } from "@/lib/conversation-attachments/policy";

export type AttachmentSendPayload = {
  attachmentIds: string[];
  attachmentRequestId: string;
  attachmentConversation: ConversationRef;
};
export function attachmentEndpoint(channelId: string, conversation: ConversationRef, suffix = "") {
  return `/api/channels/${encodeURIComponent(channelId)}/conversation-attachments${suffix}?${new URLSearchParams({ kind: conversation.kind, id: conversation.id })}`;
}
export function useConversationAttachments({
  channelId,
  conversation,
}: {
  channelId?: string;
  conversation?: ConversationRef;
}) {
  const [files, setFiles] = useState<FileView[]>([]);
  const [selectedIds, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);
  const generation = useRef(0);
  const pending = useRef(new Map<string, { file: File; controller: AbortController }>());
  const key =
    channelId && conversation ? `${channelId}:${conversation.kind}:${conversation.id}` : "";
  const kind = conversation?.kind;
  const conversationId = conversation?.id;
  const endpoint = useCallback(
    (suffix = "") => attachmentEndpoint(channelId!, { kind: kind!, id: conversationId! }, suffix),
    [channelId, kind, conversationId],
  );
  const refresh = useCallback(async () => {
    if (!key) return;
    const current = generation.current;
    try {
      const response = await fetch(endpoint());
      const data = await response.json();
      if (current !== generation.current) return;
      if (!response.ok) {
        setAvailable(false);
        setError(data.error ?? "attachment_prepare_failed");
        return;
      }
      setAvailable(true);
      setError(null);
      setFiles((previous) => [
        ...data.files,
        ...previous.filter(
          (f) =>
            pending.current.has(f.id) && !data.files.some((remote: FileView) => remote.id === f.id),
        ),
      ]);
    } catch {
      if (current === generation.current) setError("attachment_prepare_failed");
    }
  }, [key, endpoint]);
  useEffect(() => {
    const activeUploads = pending.current;
    const invalidate = () => {
      generation.current++;
    };
    invalidate();
    for (const entry of pending.current.values()) entry.controller.abort();
    pending.current.clear();
    setFiles([]);
    setSelected([]);
    setError(null);
    setAvailable(false);
    void refresh();
    return () => {
      invalidate();
      for (const entry of activeUploads.values()) entry.controller.abort();
      activeUploads.clear();
    };
  }, [key, refresh]);
  const uploadOne = useCallback(
    async (file: File, id: string) => {
      const current = generation.current;
      const controller = new AbortController();
      pending.current.set(id, { file, controller });
      setFiles((previous) => [
        ...previous.filter((f) => f.id !== id),
        {
          id,
          name: file.name,
          mimeType: file.type,
          bytes: file.size,
          sha256: "",
          state: "uploading",
        },
      ]);
      try {
        const body = new FormData();
        body.append("file", file);
        body.append("requestId", id);
        const response = await fetch(endpoint(), {
          method: "POST",
          body,
          signal: controller.signal,
        });
        const data = await response.json();
        if (current !== generation.current || controller.signal.aborted) return;
        if (!response.ok) throw new Error(data.error ?? "attachment_prepare_failed");
        pending.current.delete(id);
        setFiles((previous) => previous.map((f) => (f.id === id ? data.file : f)));
        setSelected((previous) => previous.map((value) => (value === id ? data.file.id : value)));
        setError(null);
      } catch (cause) {
        if (current !== generation.current || controller.signal.aborted) return;
        setFiles((previous) => previous.map((f) => (f.id === id ? { ...f, state: "failed" } : f)));
        setError(cause instanceof Error ? cause.message : "attachment_prepare_failed");
      }
    },
    [endpoint],
  );
  const upload = useCallback(
    async (selected: File[]) => {
      if (!available || !key) return;
      if (selectedIds.length + selected.length > 3) {
        setError("attachment_count_exceeded");
        return;
      }
      for (const file of selected) {
        const problem = validateOriginalFile({ name: file.name, bytes: file.size });
        if (problem) {
          setError(problem);
          return;
        }
      }
      const entries = selected.map((file) => ({ file, id: crypto.randomUUID() }));
      setSelected((previous) => [...previous, ...entries.map((e) => e.id)]);
      await Promise.all(entries.map((e) => uploadOne(e.file, e.id)));
    },
    [available, key, selectedIds, uploadOne],
  );
  const select = (id: string) =>
    setSelected((previous) => {
      if (previous.includes(id)) return previous.filter((value) => value !== id);
      if (previous.length >= 3) {
        setError("attachment_count_exceeded");
        return previous;
      }
      return [...previous, id];
    });
  const cancel = (id: string) => {
    pending.current.get(id)?.controller.abort();
    pending.current.delete(id);
    setFiles((previous) => previous.filter((f) => f.id !== id));
    setSelected((previous) => previous.filter((value) => value !== id));
  };
  const retry = async (id: string) => {
    const item = pending.current.get(id);
    if (item) await uploadOne(item.file, id);
    else await refresh();
  };
  const remove = async (id: string) => {
    if (pending.current.has(id)) {
      cancel(id);
      return;
    }
    const current = generation.current;
    try {
      const response = await fetch(endpoint(`/${encodeURIComponent(id)}`), { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error);
      }
      if (current !== generation.current) return;
      setSelected((previous) => previous.filter((value) => value !== id));
      await refresh();
    } catch (cause) {
      if (current === generation.current)
        setError(cause instanceof Error ? cause.message : "attachment_prepare_failed");
    }
  };
  const busy = files.some(
    (f) =>
      selectedIds.includes(f.id) &&
      (f.state === "uploading" || f.state === "failed" || f.state === "preparing"),
  );
  return {
    files,
    selectedIds,
    error,
    available,
    busy,
    upload,
    select,
    retry,
    remove,
    cancel,
    refresh,
    clearSelection: () => setSelected([]),
    endpoint,
  };
}
