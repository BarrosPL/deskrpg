import { canAccessActiveMeetingAttachments } from "./meeting-access-registry";
import { and, eq } from "drizzle-orm";
import { db, npcs } from "@/db";
import { requireChannelMember } from "@/lib/cron-access";
import { getRoom, isRoomMember } from "@/lib/chat-rooms";
import { decryptGatewayToken, getChannelGatewayBinding } from "@/lib/gateway-resources";
import {
  createOwnerPluginClient,
  createOwnerConversationFilesClient,
} from "@/lib/hermes/plugin-client";
import { CONVERSATION_FILES_CAPABILITY, type ConversationRef } from "./types";
import { createContext, findContext, getContext, type AttachmentContext } from "./repository";
export class AttachmentServiceError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export type AttachmentAction = "read" | "upload" | "prepare" | "delete";
export type AttachmentAccess = {
  userId: string;
  channelId: string;
  conversation: ConversationRef;
  context: AttachmentContext;
  gateway: NonNullable<Awaited<ReturnType<typeof getChannelGatewayBinding>>>["resource"];
  client: ReturnType<typeof createOwnerConversationFilesClient>;
};
async function requireMember(channelId: string, userId: string | null) {
  if (!userId) throw new AttachmentServiceError(401, "unauthorized");
  const member = await requireChannelMember(channelId, userId);
  if (!member.ok) throw new AttachmentServiceError(member.response.status, "forbidden");
  return userId;
}
async function requireSource(
  userId: string,
  channelId: string,
  conversation: ConversationRef,
  ctx?: AttachmentContext | null,
) {
  if (conversation.kind === "dm") {
    const [npc] = await db
      .select({ id: npcs.id })
      .from(npcs)
      .where(and(eq(npcs.id, conversation.id), eq(npcs.channelId, channelId)))
      .limit(1);
    if (!npc) throw new AttachmentServiceError(404, "attachment_not_found");
    if (ctx && ctx.ownerUserId !== userId) throw new AttachmentServiceError(403, "forbidden");
  } else if (conversation.kind === "room" || (ctx?.roomId && ctx.lifecycle === "active")) {
    const room = await getRoom(conversation.kind === "room" ? conversation.id : ctx!.roomId!);
    if (!room || room.channelId !== channelId)
      throw new AttachmentServiceError(404, "attachment_not_found");
    if (room.kind !== "office" && !(await isRoomMember(room.id, userId)))
      throw new AttachmentServiceError(403, "forbidden");
  } else if (conversation.kind === "meeting" && !ctx)
    throw new AttachmentServiceError(404, "attachment_not_found");
}
export async function ensureConversationContext(input: {
  userId: string;
  channelId: string;
  conversation: ConversationRef;
}) {
  const { userId, channelId, conversation } = input;
  await requireMember(channelId, userId);
  if (conversation.kind === "meeting") {
    const ctx = await getContext(conversation.id);
    if (
      !ctx ||
      ctx.kind !== "meeting" ||
      ctx.channelId !== channelId ||
      ctx.lifecycle === "deleted"
    )
      throw new AttachmentServiceError(404, "attachment_not_found");
    await requireSource(userId, channelId, conversation, ctx);
    return ctx;
  }
  await requireSource(userId, channelId, conversation);
  const binding = await getChannelGatewayBinding(channelId);
  if (!binding) throw new AttachmentServiceError(409, "gateway_not_bound");
  const scopeKey = JSON.stringify([
    conversation.kind,
    channelId,
    binding.resource.id,
    conversation.id,
    conversation.kind === "dm" ? userId : "",
  ]);
  const existing = await findContext(scopeKey);
  if (existing && existing.lifecycle !== "deleted") return existing;
  if (existing) throw new AttachmentServiceError(409, "attachment_conflict");
  return createContext({
    kind: conversation.kind,
    scopeKey,
    channelId,
    gatewayId: binding.resource.id,
    sourceChannelId: channelId,
    sourceGatewayId: binding.resource.id,
    ownerUserId: userId,
    npcId: conversation.kind === "dm" ? conversation.id : null,
    roomId: conversation.kind === "room" ? conversation.id : null,
  });
}
export async function createMeetingContext(input: {
  channelId: string;
  userId: string;
  roomId?: string;
}) {
  await requireMember(input.channelId, input.userId);
  if (input.roomId)
    await requireSource(input.userId, input.channelId, { kind: "room", id: input.roomId });
  const binding = await getChannelGatewayBinding(input.channelId);
  if (!binding) throw new AttachmentServiceError(409, "gateway_not_bound");
  return createContext({
    kind: "meeting",
    scopeKey: crypto.randomUUID(),
    channelId: input.channelId,
    gatewayId: binding.resource.id,
    sourceChannelId: input.channelId,
    sourceGatewayId: binding.resource.id,
    ownerUserId: input.userId,
    roomId: input.roomId ?? null,
  });
}
export async function resolveAttachmentAccess(
  userId: string | null,
  channelId: string,
  conversation: ConversationRef,
  action: AttachmentAction,
): Promise<AttachmentAccess> {
  const actor = await requireMember(channelId, userId);
  const context = await ensureConversationContext({ userId: actor, channelId, conversation });
  if (
    context.kind === "meeting" &&
    context.lifecycle === "active" &&
    !(await canAccessActiveMeetingAttachments({
      userId: actor,
      channelId,
      contextId: context.id,
      action,
    }))
  )
    throw new AttachmentServiceError(403, "forbidden");
  if (action !== "read" && context.lifecycle !== "active")
    throw new AttachmentServiceError(409, "attachment_conflict");
  const binding = await getChannelGatewayBinding(channelId);
  if (!binding || binding.resource.id !== context.gatewayId)
    throw new AttachmentServiceError(409, "gateway_not_bound");
  const options = {
    baseUrl: binding.resource.baseUrl,
    ownerToken: decryptGatewayToken(binding.resource.tokenEncrypted),
  };
  const info = await createOwnerPluginClient(options).info();
  if (!info.ok) throw new AttachmentServiceError(info.status, "attachment_feature_unavailable");
  if (!info.data.capabilities.includes(CONVERSATION_FILES_CAPABILITY))
    throw new AttachmentServiceError(428, "attachment_feature_unavailable");
  return {
    userId: actor,
    channelId,
    conversation,
    context,
    gateway: binding.resource,
    client: createOwnerConversationFilesClient(options),
  };
}
