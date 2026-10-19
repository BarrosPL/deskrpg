import { revokeInterruptedAttachmentBindings } from "@/lib/conversation-attachments/cleanup";
import { registerRpcHandler } from "@/lib/rpc-registry";
import {
  getMeetingAttachmentController,
  authorizeMeetingAttachment,
} from "./meeting-attachment-runtime";
import { registerMeetingAttachmentAccess } from "@/lib/conversation-attachments/meeting-access-registry";
import { and, eq } from "drizzle-orm";
import { db, npcs, hermesProfiles } from "@/db";
import type { NpcAdapter } from "@/lib/adapters/types";
import type { ConversationRef } from "@/lib/conversation-attachments/types";
import type { PrepareRequest, PreparedFile } from "@/lib/conversation-attachments/server-types";
import {
  AttachmentServiceError,
  resolveAttachmentAccess,
  type AttachmentAccess,
} from "@/lib/conversation-attachments/access";
import {
  createRequest,
  getRequest,
  transitionRequest,
} from "@/lib/conversation-attachments/repository";
import {
  prepareAttachments,
  releasePreparedFiles,
  renewPreparedFiles,
  requireLink,
  linkAttachments,
} from "@/lib/conversation-attachments/service";
import { validateAttachmentSelection } from "@/lib/conversation-attachments/policy";
import {
  registerAttachmentRequestHandlers,
  type AttachmentRequestView,
} from "@/lib/conversation-attachments/request-registry";
import { AttachmentExecution } from "./conversation-attachment-runtime";

export type AttachmentRuntimeTarget = { npcId: string; adapter: NpcAdapter; sessionKey: string };
type Input = {
  userId: string;
  channelId: string;
  conversation: ConversationRef;
  requestId: string;
  fileIds: string[];
  messageId: string | (() => string);
  accepted?(): Promise<void>;
  signal?: AbortSignal;
  targets(): Promise<AttachmentRuntimeTarget[]>;
  validate?(): Promise<void>;
  run(
    files: Record<string, PreparedFile[]>,
    signal: AbortSignal,
    revalidate: () => Promise<void>,
  ): Promise<void>;
  changed?(view: AttachmentRequestView): void;
};
let startupReady: Promise<unknown> = Promise.resolve();
const jobs = new Map<
  string,
  { execution: AttachmentExecution; contextId: string; userId: string }
>();

export function parseAttachmentSend(
  value: {
    attachmentIds?: unknown;
    attachmentRequestId?: unknown;
    attachmentConversation?: unknown;
  },
  expected: ConversationRef,
): { fileIds: string[]; requestId: string } | null {
  if (value.attachmentIds === undefined) return null;
  if (
    !Array.isArray(value.attachmentIds) ||
    !value.attachmentIds.every((id) => typeof id === "string")
  )
    throw new AttachmentServiceError(400, "attachment_invalid_selection");
  const error = validateAttachmentSelection(value.attachmentIds);
  if (error) throw new AttachmentServiceError(400, error);
  if (!value.attachmentIds.length) return null;
  if (
    typeof value.attachmentRequestId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(value.attachmentRequestId)
  )
    throw new AttachmentServiceError(400, "attachment_conflict");
  const ref = value.attachmentConversation as Partial<ConversationRef> | null;
  if (!ref || ref.kind !== expected.kind || ref.id !== expected.id)
    throw new AttachmentServiceError(409, "attachment_conflict");
  return { fileIds: value.attachmentIds, requestId: value.attachmentRequestId };
}

export async function submitAttachmentExecution(input: Input): Promise<void> {
  await startupReady;
  let access = await resolveAttachmentAccess(
    input.userId,
    input.channelId,
    input.conversation,
    "prepare",
  );
  const targets = await input.targets();
  const targetIds = targets.map((t) => t.npcId).sort();
  const stored = await createRequest({
    id: input.requestId,
    contextId: access.context.id,
    senderId: input.userId,
    revision: access.context.revision,
    targets: targetIds,
    fileIds: input.fileIds,
  });
  if (
    stored.contextId !== access.context.id ||
    stored.senderId !== input.userId ||
    stored.selectedFileIdsJson !== JSON.stringify(input.fileIds) ||
    stored.targetSnapshotJson !== JSON.stringify(targetIds)
  )
    throw new AttachmentServiceError(409, "attachment_conflict");
  if (jobs.has(input.requestId) || stored.status !== "pending") return;
  const request: PrepareRequest = {
    requestId: input.requestId,
    conversation: input.conversation,
    revision: access.context.revision,
    fileIds: input.fileIds,
    targets: [],
  };
  const revalidate = async () => {
    access = await resolveAttachmentAccess(
      input.userId,
      input.channelId,
      input.conversation,
      "prepare",
    );
    await input.validate?.();
    if (
      access.context.id !== stored.contextId ||
      access.context.revision !== request.revision ||
      JSON.stringify((await input.targets()).map((t) => t.npcId).sort()) !==
        JSON.stringify(targetIds)
    )
      throw new AttachmentServiceError(409, "attachment_conflict");
    for (const fileId of input.fileIds) await requireLink(access, fileId);
    for (const target of targets) {
      const [row] = await db
        .select({
          id: npcs.id,
          profileName: hermesProfiles.profileName,
          gatewayId: hermesProfiles.gatewayId,
        })
        .from(npcs)
        .innerJoin(hermesProfiles, eq(npcs.hermesProfileId, hermesProfiles.id))
        .where(
          and(
            eq(npcs.id, target.npcId),
            eq(npcs.channelId, input.channelId),
            eq(npcs.active, true),
          ),
        )
        .limit(1);
      const preparedTarget = request.targets.find((item) => item.npcId === target.npcId);
      if (
        !row ||
        row.gatewayId !== access.gateway.id ||
        (preparedTarget && preparedTarget.profileName !== row.profileName)
      )
        throw new AttachmentServiceError(404, "attachment_not_found");
    }
  };
  const execution = new AttachmentExecution({
    transition: (from, to) => transitionRequest(input.requestId, from, to),
    validate: revalidate,
    prepare: async () => {
      await input.accepted?.();
      request.targets = [];
      for (const target of targets) {
        if (!target.adapter.ensureSession)
          throw new AttachmentServiceError(428, "attachment_feature_unavailable");
        const [profile] = await db
          .select({ name: hermesProfiles.profileName })
          .from(npcs)
          .innerJoin(hermesProfiles, eq(npcs.hermesProfileId, hermesProfiles.id))
          .where(and(eq(npcs.id, target.npcId), eq(hermesProfiles.gatewayId, access.gateway.id)))
          .limit(1);
        if (!profile) throw new AttachmentServiceError(404, "attachment_not_found");
        request.targets.push({
          npcId: target.npcId,
          profileName: profile.name,
          sessionKey: target.sessionKey,
          sessionId: await target.adapter.ensureSession(target.sessionKey),
        });
      }
      if (
        !(await transitionRequest(input.requestId, ["preparing"], "preparing", {
          leaseStateJson: JSON.stringify({ targets: request.targets }),
        }))
      )
        throw new AttachmentServiceError(409, "attachment_conflict");
      await linkAttachments(
        access,
        input.fileIds,
        typeof input.messageId === "function" ? input.messageId() : input.messageId,
      );
      const result = await prepareAttachments(access, request);
      if (result.ok) {
        const patch = {
          leaseStateJson: JSON.stringify({ targets: request.targets, byNpc: result.byNpc }),
        };
        if (!(await transitionRequest(input.requestId, ["preparing"], "preparing", patch)))
          await transitionRequest(input.requestId, ["cancelled"], "cancelled", patch);
      }
      return result;
    },
    release: (files) => releasePreparedFiles(access, request, files),
    renew: (files) => renewPreparedFiles(access, request, files),
    run: (files, signal) => input.run(files, signal, revalidate),
    finished: async () => {
      await revokeInterruptedAttachmentBindings();
      const row = await getRequest(input.requestId);
      if (row && ["done", "cancelled", "outcome_unknown"].includes(row.status))
        jobs.delete(input.requestId);
    },
    changed: (state) =>
      input.changed?.({
        requestId: input.requestId,
        state,
        ...(state === "failed" ? { errorCode: "attachment_prepare_failed" } : {}),
      }),
  });
  jobs.set(input.requestId, { execution, contextId: access.context.id, userId: input.userId });
  const cancel = () => {
    void execution.cancel();
  };
  input.signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (input.signal?.aborted) await execution.cancel();
    else await execution.start();
  } finally {
    input.signal?.removeEventListener("abort", cancel);
    const row = await getRequest(input.requestId);
    if (row && ["done", "cancelled", "outcome_unknown"].includes(row.status))
      jobs.delete(input.requestId);
  }
}

export async function controlAttachmentExecution(
  access: AttachmentAccess,
  id: string,
  action: "retry" | "cancel",
  allowMeetingController = false,
): Promise<AttachmentRequestView> {
  const row = await getRequest(id);
  if (
    !row ||
    row.contextId !== access.context.id ||
    (row.senderId !== access.userId &&
      !(allowMeetingController && access.conversation.kind === "meeting"))
  )
    throw new AttachmentServiceError(404, "attachment_not_found");
  const job = jobs.get(id);
  if (!job) throw new AttachmentServiceError(409, "attachment_conflict");
  if (action === "retry") await job.execution.retry({ wait: false });
  else await job.execution.cancel();
  return { requestId: id, state: (await getRequest(id))!.status };
}
async function routeControl(
  access: AttachmentAccess,
  id: string,
  action: "retry" | "cancel" | "exclude",
  fileIds?: string[],
) {
  if (access.conversation.kind === "meeting") {
    const controller = getMeetingAttachmentController(access.context.id);
    if (!controller || controller.channelId !== access.channelId)
      throw new AttachmentServiceError(409, "attachment_conflict");
    return controller.control(access, id, action, fileIds);
  }
  if (action === "exclude") throw new AttachmentServiceError(400, "attachment_invalid_selection");
  return controlAttachmentExecution(access, id, action);
}
export function registerSocketAttachmentRuntime(ready: Promise<unknown> = Promise.resolve()) {
  startupReady = ready;
  registerAttachmentRequestHandlers({
    retry: (access, id) => routeControl(access, id, "retry"),
    cancel: (access, id) => routeControl(access, id, "cancel"),
    exclude: (access, id, files) => routeControl(access, id, "exclude", files),
  });
  registerMeetingAttachmentAccess(authorizeMeetingAttachment);
  registerRpcHandler(handleAttachmentRequestRpc);
}
export async function handleAttachmentRequestRpc(
  channelId: string,
  method: string,
  params: Record<string, unknown>,
) {
  if (method === "attachment-meeting-access")
    return {
      allowed: await authorizeMeetingAttachment({
        channelId,
        contextId: String(params.contextId),
        userId: String(params.userId),
        action: String(params.action),
      }),
    };
  if (
    ![
      "attachment-request-retry",
      "attachment-request-cancel",
      "attachment-request-exclude",
    ].includes(method)
  )
    throw new AttachmentServiceError(404, "not_found");
  const ref = params.conversation as Partial<ConversationRef> | null;
  if (!ref || !["dm", "room", "meeting"].includes(ref.kind ?? "") || typeof ref.id !== "string")
    throw new AttachmentServiceError(400, "attachment_invalid_selection");
  const access = await resolveAttachmentAccess(
    typeof params.userId === "string" ? params.userId : null,
    channelId,
    ref as ConversationRef,
    "prepare",
  );
  return routeControl(
    access,
    String(params.requestId),
    method === "attachment-request-retry"
      ? "retry"
      : method === "attachment-request-exclude"
        ? "exclude"
        : "cancel",
    Array.isArray(params.fileIds) ? params.fileIds : undefined,
  );
}
