/** Revision-aware next-turn barrier. It never interrupts a turn already speaking. */
export class MeetingAttachmentBarrier {
  active = true;
  revision = 0;
  private requests = new Map<string, { files: Set<string>; state: string }>();
  private listeners = new Set<() => void>();
  stage(requestId: string, fileIds: string[]) {
    if (!this.active) throw new Error("meeting_aborted");
    const existing = this.requests.get(requestId);
    if (existing) {
      if (JSON.stringify([...existing.files]) !== JSON.stringify(fileIds))
        throw new Error("attachment_conflict");
      return;
    }
    const priorFiles = new Set(this.files());
    this.requests.set(requestId, { files: new Set(fileIds), state: "pending" });
    if (fileIds.some((id) => !priorFiles.has(id))) this.revision++;
    this.notify();
  }
  change(requestId: string, state: string) {
    const request = this.requests.get(requestId);
    if (!request || !this.active) return;
    request.state = state;
    if (state === "cancelled") request.files.clear();
    this.notify();
  }
  exclude(requestId: string, fileIds: string[]) {
    const request = this.requests.get(requestId);
    if (!request) throw new Error("attachment_not_found");
    if (fileIds.some((id) => !request.files.has(id))) throw new Error("attachment_not_found");
    for (const entry of this.requests.values()) for (const id of fileIds) entry.files.delete(id);
    this.revision++;
    this.notify();
  }
  get ready() {
    return [...this.requests.values()].every(
      (request) => !request.files.size || request.state === "done",
    );
  }
  files() {
    return [...new Set([...this.requests.values()].flatMap((request) => [...request.files]))];
  }
  requestFiles(id: string) {
    return [...(this.requests.get(id)?.files ?? [])];
  }
  has(id: string) {
    return this.requests.has(id);
  }
  stop() {
    this.active = false;
    this.notify();
  }
  private notify() {
    for (const listener of this.listeners) listener();
  }
  waitRequest(requestId: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const request = this.requests.get(requestId);
        if (signal.aborted || !this.active) {
          cleanup();
          reject(new Error("meeting_aborted"));
          return;
        }
        if (!request || !request.files.size || ["done", "cancelled"].includes(request.state)) {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        this.listeners.delete(check);
        signal.removeEventListener("abort", check);
      };
      this.listeners.add(check);
      signal.addEventListener("abort", check, { once: true });
      check();
    });
  }
  wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (signal.aborted || !this.active) {
          cleanup();
          reject(new Error("meeting_aborted"));
          return;
        }
        if (
          [...this.requests.values()].every(
            (request) => !request.files.size || request.state === "done",
          )
        ) {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        this.listeners.delete(check);
        signal.removeEventListener("abort", check);
      };
      this.listeners.add(check);
      signal.addEventListener("abort", check, { once: true });
      check();
    });
  }
}

import type { ConversationRef } from "@/lib/conversation-attachments/types";
import type { AttachmentAccess } from "@/lib/conversation-attachments/access";
import type { AttachmentRequestView } from "@/lib/conversation-attachments/request-registry";
export type MeetingAttachmentController = {
  conversation: ConversationRef;
  channelId: string;
  active: boolean;
  authorize(userId: string, action: string): Promise<boolean>;
  control(
    access: AttachmentAccess,
    requestId: string,
    action: "retry" | "cancel" | "exclude",
    fileIds?: string[],
  ): Promise<AttachmentRequestView>;
};
const controllers = new Map<string, MeetingAttachmentController>();
export function registerMeetingAttachmentController(controller: MeetingAttachmentController) {
  controllers.set(controller.conversation.id, controller);
}
export function getMeetingAttachmentController(contextId: string) {
  return controllers.get(contextId);
}
export function getMeetingAttachmentConversation(channelId: string) {
  return [...controllers.values()].find((c) => c.channelId === channelId && c.active)?.conversation;
}
export async function authorizeMeetingAttachment(input: {
  channelId: string;
  contextId: string;
  userId: string;
  action: string;
}) {
  const controller = controllers.get(input.contextId);
  return Boolean(
    controller &&
    controller.active &&
    controller.channelId === input.channelId &&
    (await controller.authorize(input.userId, input.action)),
  );
}
