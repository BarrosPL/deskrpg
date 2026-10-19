import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, hermesProfiles, npcs } from "@/db";
import { decryptGatewayToken } from "@/lib/gateway-resources";
import { createProfileConversationFilesClient } from "@/lib/hermes/plugin-client";
import type { PluginResponse } from "@/lib/hermes/plugin-client-types";
import { AttachmentServiceError, resolveAttachmentAccess, type AttachmentAccess } from "./access";
import { findUpload, getLink, insertLink, listLinks, updateLink } from "./repository";
import type { AttachmentLink } from "./repository";
import { validateAttachmentSelection, validateOriginalFile } from "./policy";
import type { FileView, AttachmentErrorCode } from "./types";
import type { PreparedFile, PrepareRequest, PrepareTarget, PrepareResult } from "./server-types";
export type RuntimePrepareRequest = Omit<PrepareRequest, "targets"> & {
  targets: (PrepareTarget & { sessionId: string })[];
};
function result<T>(r: PluginResponse<T>): T {
  if (!r.ok)
    throw new AttachmentServiceError(
      r.status,
      r.failure.code.startsWith("attachment_") ? r.failure.code : "attachment_prepare_failed",
    );
  return r.data;
}
export function fileView(link: AttachmentLink): FileView {
  return {
    id: link.id,
    name: link.name,
    mimeType: link.mimeType,
    bytes: link.bytes,
    sha256: link.sha256,
    state: link.status === "delete_pending" ? "deleted" : (link.status as FileView["state"]),
    ...(link.errorCode ? { errorCode: link.errorCode as AttachmentErrorCode } : {}),
  };
}
export async function listAttachments(access: AttachmentAccess) {
  return (await listLinks(access.context.id)).map(fileView);
}
export async function requireLink(access: AttachmentAccess, id: string) {
  const link = await getLink(id);
  if (
    !link ||
    link.contextId !== access.context.id ||
    ["deleted", "delete_pending"].includes(link.status)
  )
    throw new AttachmentServiceError(404, "attachment_not_found");
  return link;
}
export async function uploadOriginal(
  access: AttachmentAccess,
  requestId: string,
  file: File,
): Promise<FileView> {
  const error = validateOriginalFile({ name: file.name, bytes: file.size });
  if (error) throw new AttachmentServiceError(error === "attachment_too_large" ? 413 : 400, error);
  if (!requestId || requestId.length > 128)
    throw new AttachmentServiceError(400, "attachment_conflict");
  const sha256 = createHash("sha256")
    .update(Buffer.from(await file.arrayBuffer()))
    .digest("hex");
  const existing = await findUpload(access.context.id, requestId);
  if (existing) {
    if (
      existing.sha256 !== sha256 ||
      existing.name !== file.name ||
      existing.mimeType !== (file.type || "application/octet-stream") ||
      existing.uploaderId !== access.userId ||
      ["deleted", "delete_pending"].includes(existing.status)
    )
      throw new AttachmentServiceError(409, "attachment_conflict");
    return fileView(existing);
  }
  const meta = result(await access.client.upload(access.context.id, requestId, file, file.name));
  if (meta.sha256 !== sha256 || meta.bytes !== file.size)
    throw new AttachmentServiceError(422, "attachment_checksum_mismatch");
  const now = new Date().toISOString();
  const link = await insertLink({
    id: randomUUID(),
    contextId: access.context.id,
    pluginFileId: meta.id,
    uploaderId: access.userId,
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    bytes: file.size,
    sha256,
    status: "stored",
    requestId,
    createdAt: now,
    updatedAt: now,
  });
  if (link.sha256 !== sha256 || link.uploaderId !== access.userId)
    throw new AttachmentServiceError(409, "attachment_conflict");
  return fileView(link);
}
async function profileClient(
  access: AttachmentAccess,
  target: RuntimePrepareRequest["targets"][number],
) {
  const [row] = await db
    .select({ name: hermesProfiles.profileName, token: hermesProfiles.tokenEncrypted })
    .from(npcs)
    .innerJoin(hermesProfiles, eq(npcs.hermesProfileId, hermesProfiles.id))
    .where(
      and(
        eq(npcs.id, target.npcId),
        eq(npcs.channelId, access.channelId),
        eq(hermesProfiles.gatewayId, access.gateway.id),
        eq(npcs.active, true),
      ),
    )
    .limit(1);
  if (!row?.token || row.name !== target.profileName || !target.sessionId || !target.sessionKey)
    throw new AttachmentServiceError(401, "unauthorized");
  return createProfileConversationFilesClient({
    baseUrl: access.gateway.baseUrl,
    profileName: row.name,
    profileToken: decryptGatewayToken(row.token),
  });
}
export async function prepareAttachments(
  access: AttachmentAccess,
  request: RuntimePrepareRequest,
): Promise<PrepareResult> {
  const error = validateAttachmentSelection(request.fileIds);
  if (error) throw new AttachmentServiceError(400, error);
  const fresh = await resolveAttachmentAccess(
    access.userId,
    access.channelId,
    access.conversation,
    "prepare",
  );
  if (
    request.revision !== fresh.context.revision ||
    request.conversation.kind !== access.conversation.kind ||
    request.conversation.id !== access.conversation.id
  )
    throw new AttachmentServiceError(409, "attachment_conflict");
  const files = await Promise.all(request.fileIds.map((id) => requireLink(fresh, id)));
  const byNpc: Record<string, PreparedFile[]> = {};
  const failures: Array<{ npcId: string; fileId: string; errorCode: AttachmentErrorCode }> = [];
  for (const target of request.targets) {
    byNpc[target.npcId] = [];
    for (const file of files) {
      try {
        const client = await profileClient(fresh, target);
        const grant = result(
          await fresh.client.grant(file.pluginFileId, {
            conversationId: fresh.context.id,
            profileName: target.profileName,
            sessionKey: target.sessionKey,
            sessionId: target.sessionId,
          }),
        );
        const prepared = result(
          await client.prepare({
            grant: grant.grant,
            requestId: `${request.requestId}:${file.id}:${target.npcId}`,
          }),
        );
        // Retain the lease before verification so rejected bytes are also released.
        byNpc[target.npcId].push({
          ...prepared,
          id: file.id,
          pluginFileId: file.pluginFileId,
          name: file.name,
        });
        if (prepared.sha256 !== file.sha256 || prepared.bytes !== file.bytes)
          throw new AttachmentServiceError(422, "attachment_checksum_mismatch");
      } catch (error) {
        failures.push({
          npcId: target.npcId,
          fileId: file.id,
          errorCode:
            error instanceof AttachmentServiceError && error.code.startsWith("attachment_")
              ? (error.code as AttachmentErrorCode)
              : "attachment_prepare_failed",
        });
      }
    }
  }
  if (failures.length) {
    await releasePreparedFiles(fresh, request, byNpc);
    return { ok: false, revision: request.revision, failures };
  }
  return { ok: true, revision: request.revision, byNpc };
}
export async function releasePreparedFiles(
  access: AttachmentAccess,
  request: RuntimePrepareRequest,
  byNpc: Record<string, PreparedFile[]>,
) {
  for (const target of request.targets) {
    if (!byNpc[target.npcId]?.length) continue;
    const client = await profileClient(access, target);
    for (const file of byNpc[target.npcId] ?? [])
      result(
        await client.release(file.leaseId, {
          sessionId: target.sessionId,
          requestId: `${request.requestId}:${file.id}:${target.npcId}`,
        }),
      );
  }
}
export async function renewPreparedFiles(
  access: AttachmentAccess,
  request: RuntimePrepareRequest,
  byNpc: Record<string, PreparedFile[]>,
) {
  for (const target of request.targets) {
    if (!byNpc[target.npcId]?.length) continue;
    const client = await profileClient(access, target);
    for (const file of byNpc[target.npcId] ?? [])
      result(
        await client.renew(file.leaseId, {
          sessionId: target.sessionId,
          requestId: `${request.requestId}:${file.id}:${target.npcId}`,
        }),
      );
  }
}
export async function revokePreparedBindings(
  access: AttachmentAccess,
  request: RuntimePrepareRequest,
) {
  for (const target of request.targets)
    result(
      await access.client.revoke({
        conversationId: access.context.id,
        profileName: target.profileName,
        sessionId: target.sessionId,
      }),
    );
}
export async function linkAttachments(
  access: AttachmentAccess,
  fileIds: string[],
  messageId: string,
) {
  const error = validateAttachmentSelection(fileIds);
  if (error) throw new AttachmentServiceError(400, error);
  for (const id of fileIds) {
    const file = await requireLink(access, id);
    if (file.messageId && file.messageId !== messageId) continue;
    // Commit the durable association before the remote call; retry can recover a lost reply.
    await updateLink(id, { messageId });
    result(
      await access.client.link(file.pluginFileId, { conversationId: access.context.id, messageId }),
    );
  }
}
export async function requestAttachmentDeletion(access: AttachmentAccess, id: string) {
  const file = await requireLink(access, id);
  if (file.uploaderId !== access.userId && access.context.ownerUserId !== access.userId)
    throw new AttachmentServiceError(403, "forbidden");
  await updateLink(id, { status: "delete_pending" });
  const response = await access.client.remove(file.pluginFileId);
  if (response.ok && response.data.deleted) await updateLink(id, { status: "deleted" });
}
