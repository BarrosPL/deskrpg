import { and, eq, inArray, ne, or } from "drizzle-orm";
import {
  db,
  gatewayResources,
  conversationAttachmentRequests as requests,
  conversationAttachmentContexts as contexts,
} from "@/db";
import { decryptGatewayToken } from "@/lib/gateway-resources";
import { createOwnerConversationFilesClient } from "@/lib/hermes/plugin-client";
import { allCleanupLinks, getContext, hasActiveRequest, updateLink } from "./repository";
export type CleanupReport = { deleted: number; pending: number; preserved: number };
export type BindingCleanupReport = { revoked: number; pending: number };
/** Revoke authority after a terminal run without deleting retained originals. */
export async function revokeInterruptedAttachmentBindings(): Promise<BindingCleanupReport> {
  const report = { revoked: 0, pending: 0 };
  const rows = await db
    .select({ request: requests, context: contexts })
    .from(requests)
    .innerJoin(contexts, eq(requests.contextId, contexts.id))
    .where(
      or(
        inArray(requests.status, ["outcome_unknown", "cancelled", "failed"]),
        eq(contexts.lifecycle, "deleted"),
      ),
    );
  for (const { request, context } of rows) {
    let state: { targets?: unknown; bindingsRevoked?: boolean };
    try {
      state = JSON.parse(request.leaseStateJson);
    } catch {
      report.pending++;
      continue;
    }
    if (state?.bindingsRevoked === true) continue;
    if (Array.isArray(state) && state.length === 0) {
      await db
        .update(requests)
        .set({ leaseStateJson: JSON.stringify({ targets: [], bindingsRevoked: true }) })
        .where(
          and(
            eq(requests.id, request.id),
            eq(requests.status, request.status),
            eq(requests.leaseStateJson, request.leaseStateJson),
          ),
        );
      continue;
    }
    if (!state || !Array.isArray(state.targets)) {
      report.pending++;
      continue;
    }
    const targets: { profileName: string; sessionId: string }[] = [];
    let invalid = false;
    for (const target of state.targets) {
      if (
        !target ||
        typeof target.profileName !== "string" ||
        !target.profileName ||
        typeof target.sessionId !== "string" ||
        !target.sessionId
      ) {
        invalid = true;
        break;
      }
      targets.push(target);
    }
    if (invalid) {
      report.pending++;
      continue;
    }
    const active = await db
      .select({ id: requests.id })
      .from(requests)
      .where(
        and(
          eq(requests.contextId, context.id),
          ne(requests.id, request.id),
          inArray(requests.status, ["pending", "preparing", "ready", "running"]),
        ),
      )
      .limit(1);
    if (active.length) {
      report.pending++;
      continue;
    }
    const [gateway] = context.gatewayId
      ? await db
          .select()
          .from(gatewayResources)
          .where(eq(gatewayResources.id, context.gatewayId))
          .limit(1)
      : [];
    if (!gateway) {
      report.pending++;
      continue;
    }
    try {
      const client = createOwnerConversationFilesClient({
        baseUrl: gateway.baseUrl,
        ownerToken: decryptGatewayToken(gateway.tokenEncrypted),
      });
      let revoked = true;
      for (const target of targets) {
        const result = await client.revoke({
          conversationId: context.id,
          profileName: target.profileName,
          sessionId: target.sessionId,
        });
        if (!result.ok) revoked = false;
      }
      if (!revoked) {
        report.pending++;
        continue;
      }
      const updated = await db
        .update(requests)
        .set({
          leaseStateJson: JSON.stringify({ ...state, bindingsRevoked: true }),
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(requests.id, request.id),
            eq(requests.status, request.status),
            eq(requests.leaseStateJson, request.leaseStateJson),
          ),
        )
        .returning({ id: requests.id });
      if (updated.length) report.revoked++;
      else report.pending++;
    } catch {
      report.pending++;
    }
  }
  return report;
}
let sweeping = false;
/** The plugin owns lease-aware byte deletion; this ledger never assumes an offline delete succeeded. */
export async function runAttachmentCleanup(now = new Date()): Promise<CleanupReport> {
  const report: CleanupReport = { deleted: 0, pending: 0, preserved: 0 };
  if (sweeping) return report;
  sweeping = true;
  try {
    const bindings = await revokeInterruptedAttachmentBindings();
    report.pending += bindings.pending;
    for (const file of await allCleanupLinks()) {
      const context = await getContext(file.contextId);
      if (!context) {
        report.pending++;
        continue;
      }
      const orphan =
        !file.messageId && now.getTime() - Date.parse(file.createdAt) >= 24 * 60 * 60 * 1000;
      if (file.status !== "delete_pending" && !orphan) {
        report.preserved++;
        continue;
      }
      if (await hasActiveRequest(context.id)) {
        report.preserved++;
        continue;
      }
      await updateLink(file.id, { status: "delete_pending" });
      const [gateway] = context.gatewayId
        ? await db
            .select()
            .from(gatewayResources)
            .where(eq(gatewayResources.id, context.gatewayId))
            .limit(1)
        : [];
      if (!gateway) {
        report.pending++;
        continue;
      }
      try {
        const response = await createOwnerConversationFilesClient({
          baseUrl: gateway.baseUrl,
          ownerToken: decryptGatewayToken(gateway.tokenEncrypted),
        }).remove(file.pluginFileId);
        if (response.ok && response.data.deleted) {
          await updateLink(file.id, { status: "deleted" });
          report.deleted++;
        } else report.pending++;
      } catch {
        report.pending++;
      }
    }
  } finally {
    sweeping = false;
  }
  return report;
}
