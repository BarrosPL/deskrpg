import { db, conversationAttachmentContexts } from "@/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AdapterExecuteOptions, NpcAdapter } from "@/lib/adapters/types";
import {
  createMeetingContext,
  AttachmentServiceError,
  type AttachmentAccess,
} from "@/lib/conversation-attachments/access";
import { updateContext, updateLink, getRequest } from "@/lib/conversation-attachments/repository";
import type { AttachmentRequestView } from "@/lib/conversation-attachments/request-registry";
import type { PreparedFile } from "@/lib/conversation-attachments/server-types";
import {
  submitAttachmentExecution,
  controlAttachmentExecution,
  type AttachmentRuntimeTarget,
} from "./conversation-attachment-service";
import { formatAttachmentManifest } from "./conversation-attachment-runtime";
import {
  MeetingAttachmentBarrier,
  registerMeetingAttachmentController,
} from "./meeting-attachment-runtime";

export type MeetingAttachmentInput = {
  channelId: string;
  userId: string;
  isParticipant(userId: string): boolean;
  canControl(userId: string): Promise<boolean> | boolean;
  changed(view: AttachmentRequestView): void;
};
export async function createLiveMeetingAttachments(input: MeetingAttachmentInput) {
  let context;
  try {
    context = await createMeetingContext({ channelId: input.channelId, userId: input.userId });
  } catch (error) {
    if (error instanceof AttachmentServiceError && error.code === "gateway_not_bound") return null;
    throw error;
  }
  const runtime = new LiveMeetingAttachments(input, context.id);
  registerMeetingAttachmentController(runtime);
  return runtime;
}
type RuntimeServices = {
  submit: typeof submitAttachmentExecution;
  control: (
    access: AttachmentAccess,
    id: string,
    action: "retry" | "cancel",
    allowController?: boolean,
  ) => Promise<AttachmentRequestView>;
  getRequest: (id: string) => Promise<Awaited<ReturnType<typeof getRequest>> | null>;
  updateLink: typeof updateLink;
  updateContext: typeof updateContext;
};
export class LiveMeetingAttachments {
  readonly conversation;
  private barrier = new MeetingAttachmentBarrier();
  private targets = new Map<string, AttachmentRuntimeTarget>();
  private executions = new Set<AbortController>();
  private ending: Promise<void> | undefined;
  constructor(
    private input: MeetingAttachmentInput,
    contextId: string,
    private services: RuntimeServices = {
      submit: submitAttachmentExecution,
      control: controlAttachmentExecution,
      getRequest,
      updateLink,
      updateContext,
    },
  ) {
    this.conversation = { kind: "meeting" as const, id: contextId };
  }
  get channelId() {
    return this.input.channelId;
  }
  get ready() {
    return this.barrier.ready;
  }
  get active() {
    return this.barrier.active;
  }
  async authorize(userId: string, action: string) {
    return (
      this.active &&
      (["control", "retry", "cancel", "exclude"].includes(action)
        ? await this.input.canControl(userId)
        : this.input.isParticipant(userId))
    );
  }
  async stage(actorId: string, requestId: string, fileIds: string[], messageId: string) {
    if (!this.active || !this.input.isParticipant(actorId))
      throw new AttachmentServiceError(403, "forbidden");
    this.barrier.stage(requestId, fileIds);
    try {
      await this.services.submit({
        userId: actorId,
        channelId: this.channelId,
        conversation: this.conversation,
        requestId,
        fileIds,
        messageId,
        targets: async () => [...this.targets.values()],
        validate: async () => {
          if (!(await this.authorize(actorId, "upload")))
            throw new AttachmentServiceError(403, "forbidden");
        },
        run: async () => {},
        changed: (view) => {
          this.barrier.change(requestId, view.state);
          this.input.changed(view);
        },
      });
    } catch (error) {
      this.barrier.change(requestId, "failed");
      this.input.changed({ requestId, state: "failed", errorCode: "attachment_prepare_failed" });
      throw error;
    }
  }
  async control(
    access: AttachmentAccess,
    id: string,
    action: "retry" | "cancel" | "exclude",
    fileIds: string[] = [],
  ): Promise<AttachmentRequestView> {
    if (!(await this.authorize(access.userId, "control")))
      throw new AttachmentServiceError(403, "forbidden");
    if (!this.barrier.has(id)) throw new AttachmentServiceError(404, "attachment_not_found");
    if (action === "exclude") {
      if (!fileIds.length) throw new AttachmentServiceError(400, "attachment_invalid_selection");
      this.barrier.exclude(id, fileIds);
      for (const fileId of fileIds) await this.services.updateLink(fileId, { status: "excluded" });
      const remaining = this.barrier.requestFiles(id);
      if (await this.services.getRequest(id))
        await this.services.control(access, id, "cancel", true);
      this.barrier.change(id, "cancelled");
      if (remaining.length) {
        const requestId = randomUUID();
        void this.stage(access.userId, requestId, remaining, `meeting-material-${requestId}`).catch(
          () => {},
        );
        return { requestId, state: "pending" };
      }
      return { requestId: id, state: "cancelled" };
    }
    if (action === "cancel" && !(await this.services.getRequest(id))) {
      this.barrier.change(id, "cancelled");
      return { requestId: id, state: "cancelled" };
    }
    const result = await this.services.control(access, id, action, true);
    this.barrier.change(id, result.state);
    return result;
  }
  beforeTurn = async (_npcId: string, signal: AbortSignal) => {
    await this.barrier.wait(signal);
  };
  wrap(npcId: string, adapter: NpcAdapter, sessionKey: string): NpcAdapter {
    this.targets.set(npcId, { npcId, adapter, sessionKey });
    const execute = async (options: AdapterExecuteOptions) => {
      const abort = new AbortController();
      this.executions.add(abort);
      try {
        await this.barrier.wait(abort.signal);
        const revision = this.barrier.revision;
        const files = this.barrier.files();
        if (!files.length) return adapter.execute(options);
        let result: Awaited<ReturnType<NpcAdapter["execute"]>> | undefined;
        const next = async (offset: number, prepared: PreparedFile[]): Promise<void> => {
          if (offset >= files.length) {
            if (abort.signal.aborted || revision !== this.barrier.revision)
              throw new Error("attachment_conflict");
            result = await adapter.execute({
              ...options,
              prompt: options.prompt + formatAttachmentManifest(prepared),
            });
            return;
          }
          const requestId = randomUUID();
          this.barrier.stage(requestId, files.slice(offset, offset + 3));
          await this.services.submit({
            userId: this.input.userId,
            channelId: this.channelId,
            conversation: this.conversation,
            requestId,
            fileIds: files.slice(offset, offset + 3),
            messageId: `meeting-turn-${requestId}`,
            targets: async () => [{ npcId, adapter, sessionKey: options.sessionKey }],
            validate: async () => {
              if (!this.active || abort.signal.aborted || revision !== this.barrier.revision)
                throw new AttachmentServiceError(409, "attachment_conflict");
            },
            run: async (byNpc, signal) => {
              if (signal.aborted) throw new Error("meeting_aborted");
              await next(offset + 3, [...prepared, ...(byNpc[npcId] ?? [])]);
            },
            changed: (view) => {
              this.barrier.change(requestId, view.state);
              if (view.state === "failed") this.input.changed(view);
            },
          });
          // Keep earlier batches leased while a later batch waits for explicit retry.
          if (!result) await this.barrier.waitRequest(requestId, abort.signal);
        };
        await next(0, []);
        if (!result) await this.barrier.wait(abort.signal);
        if (!result) throw new AttachmentServiceError(502, "attachment_prepare_failed");
        return result;
      } finally {
        this.executions.delete(abort);
      }
    };
    return {
      type: adapter.type,
      execute,
      ensureSession: adapter.ensureSession?.bind(adapter),
      abort: async (key) => {
        for (const c of this.executions) c.abort();
        await adapter.abort?.(key);
      },
      testConnection: adapter.testConnection.bind(adapter),
      getConfigSchema: adapter.getConfigSchema?.bind(adapter),
      resetSession: adapter.resetSession?.bind(adapter),
    };
  }
  async archive(minutesId: string | null) {
    this.stop();
    await this.ending;
    await this.services.updateContext(this.conversation.id, {
      lifecycle: minutesId ? "archived" : "interrupted",
      ...(minutesId ? { meetingMinutesId: minutesId } : {}),
    });
  }
  stop() {
    this.barrier.stop();
    for (const controller of this.executions) controller.abort();
    this.ending ??= this.services.updateContext(this.conversation.id, { lifecycle: "interrupted" });
    void this.ending.catch(() => {});
  }
}

/** Called once at server startup before accepting meeting requests. */
export async function recoverMeetingAttachmentContexts() {
  return db
    .update(conversationAttachmentContexts)
    .set({ lifecycle: "interrupted" })
    .where(
      and(
        eq(conversationAttachmentContexts.kind, "meeting"),
        eq(conversationAttachmentContexts.lifecycle, "active"),
      ),
    )
    .returning({ id: conversationAttachmentContexts.id });
}
