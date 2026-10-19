"use client";
import type { ConversationRef } from "@/lib/conversation-attachments/types";
import AttachmentTray from "./AttachmentTray";
import { useConversationAttachments } from "./use-conversation-attachments";
export default function AttachmentHistory({
  channelId,
  conversation,
}: {
  channelId: string;
  conversation: ConversationRef;
}) {
  const attachments = useConversationAttachments({ channelId, conversation });
  return (
    <AttachmentTray
      files={attachments.files}
      sharedScope={conversation.kind}
      downloadUrl={(id) => attachments.endpoint(`/${encodeURIComponent(id)}/content`)}
    />
  );
}
