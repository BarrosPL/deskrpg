import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  conversationAttachmentContexts as contexts,
  conversationAttachmentLinks as links,
  conversationAttachmentRequests as requests,
} from "@/db";
import type { ConversationRef } from "./types";
export type AttachmentContext = typeof contexts.$inferSelect;
export type AttachmentLink = typeof links.$inferSelect;
export type AttachmentRequest = typeof requests.$inferSelect;
export type RequestStatus =
  | "pending"
  | "preparing"
  | "ready"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "outcome_unknown";
export async function getContext(id: string) {
  return (await db.select().from(contexts).where(eq(contexts.id, id)).limit(1))[0] ?? null;
}
export async function findContext(scopeKey: string) {
  return (
    (await db.select().from(contexts).where(eq(contexts.scopeKey, scopeKey)).limit(1))[0] ?? null
  );
}
export async function createContext(
  input: Omit<typeof contexts.$inferInsert, "id" | "createdAt" | "revision" | "lifecycle">,
) {
  const row = {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    revision: 0,
    lifecycle: "active",
  };
  await db.insert(contexts).values(row).onConflictDoNothing();
  return (await findContext(input.scopeKey))!;
}
export async function updateContext(
  id: string,
  patch: Partial<Pick<AttachmentContext, "revision" | "lifecycle" | "meetingMinutesId">>,
) {
  await db.update(contexts).set(patch).where(eq(contexts.id, id));
}
export async function getLink(id: string) {
  return (await db.select().from(links).where(eq(links.id, id)).limit(1))[0] ?? null;
}
export async function listLinks(contextId: string) {
  return db.select().from(links).where(eq(links.contextId, contextId)).orderBy(links.createdAt);
}
export async function findUpload(contextId: string, requestId: string) {
  return (
    (
      await db
        .select()
        .from(links)
        .where(and(eq(links.contextId, contextId), eq(links.requestId, requestId)))
        .limit(1)
    )[0] ?? null
  );
}
export async function insertLink(row: typeof links.$inferInsert) {
  await db.insert(links).values(row).onConflictDoNothing();
  return (await findUpload(row.contextId, row.requestId))!;
}
export async function updateLink(
  id: string,
  patch: Partial<Pick<AttachmentLink, "status" | "messageId" | "errorCode">>,
) {
  await db
    .update(links)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(links.id, id));
}
export async function getRequest(id: string) {
  return (await db.select().from(requests).where(eq(requests.id, id)).limit(1))[0] ?? null;
}
export async function createRequest(input: {
  id: string;
  contextId: string;
  senderId: string;
  revision: number;
  targets: unknown[];
  fileIds: string[];
}) {
  const now = new Date().toISOString();
  await db
    .insert(requests)
    .values({
      id: input.id,
      contextId: input.contextId,
      senderId: input.senderId,
      revision: input.revision,
      targetSnapshotJson: JSON.stringify(input.targets),
      selectedFileIdsJson: JSON.stringify(input.fileIds),
      status: "pending",
      leaseStateJson: "[]",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const row = (await getRequest(input.id))!;
  if (
    row.contextId !== input.contextId ||
    row.senderId !== input.senderId ||
    row.revision !== input.revision ||
    row.targetSnapshotJson !== JSON.stringify(input.targets) ||
    row.selectedFileIdsJson !== JSON.stringify(input.fileIds)
  )
    throw new Error("attachment_conflict");
  return row;
}
export async function transitionRequest(
  id: string,
  from: RequestStatus[],
  to: RequestStatus,
  patch?: { leaseStateJson?: string },
) {
  const result = await db
    .update(requests)
    .set({ ...patch, status: to, updatedAt: new Date().toISOString() })
    .where(and(eq(requests.id, id), inArray(requests.status, from)))
    .returning({ id: requests.id });
  return result.length === 1;
}
export async function recoverInterruptedRequests() {
  return db
    .update(requests)
    .set({ status: "outcome_unknown", updatedAt: new Date().toISOString() })
    .where(inArray(requests.status, ["pending", "running", "preparing", "ready"]))
    .returning({ id: requests.id });
}
export async function allCleanupLinks() {
  return db
    .select()
    .from(links)
    .where(inArray(links.status, ["stored", "delete_pending"]));
}
export async function hasActiveRequest(contextId: string) {
  return (
    (
      await db
        .select({ id: requests.id })
        .from(requests)
        .where(
          and(
            eq(requests.contextId, contextId),
            inArray(requests.status, [
              "pending",
              "preparing",
              "ready",
              "running",
              "outcome_unknown",
            ]),
          ),
        )
        .limit(1)
    ).length > 0
  );
}
export async function markContextDeleted(id: string) {
  await db
    .update(contexts)
    .set({ lifecycle: "deleted", scopeKey: `deleted:${id}` })
    .where(eq(contexts.id, id));
  for (const file of await listLinks(id))
    if (file.status !== "deleted") await updateLink(file.id, { status: "delete_pending" });
}
export function externalConversation(ctx: AttachmentContext): ConversationRef {
  return {
    kind: ctx.kind as ConversationRef["kind"],
    id: ctx.kind === "dm" ? ctx.npcId! : ctx.kind === "room" ? ctx.roomId! : ctx.id,
  };
}
export async function findContextByMinutes(minutesId: string) {
  return (
    (
      await db.select().from(contexts).where(eq(contexts.meetingMinutesId, minutesId)).limit(1)
    )[0] ?? null
  );
}

export async function resetDmAttachmentContext(userId: string, channelId: string, npcId: string) {
  const rows = await db
    .select()
    .from(contexts)
    .where(
      and(
        eq(contexts.kind, "dm"),
        eq(contexts.sourceChannelId, channelId),
        eq(contexts.ownerUserId, userId),
        eq(contexts.npcId, npcId),
      ),
    );
  for (const row of rows) await markContextDeleted(row.id);
}
export async function retireAttachmentContexts(source: {
  channelId?: string;
  gatewayId?: string;
  roomId?: string;
  minutesId?: string;
}) {
  const conditions = [];
  if (source.channelId) conditions.push(eq(contexts.sourceChannelId, source.channelId));
  if (source.gatewayId) conditions.push(eq(contexts.sourceGatewayId, source.gatewayId));
  if (source.roomId) conditions.push(eq(contexts.roomId, source.roomId));
  if (source.minutesId) conditions.push(eq(contexts.meetingMinutesId, source.minutesId));
  if (!conditions.length) throw new Error("attachment_invalid_selection");
  for (const row of await db
    .select()
    .from(contexts)
    .where(and(...conditions)))
    await markContextDeleted(row.id);
}
