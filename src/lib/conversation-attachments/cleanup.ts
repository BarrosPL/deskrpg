import { eq } from "drizzle-orm";
import { db, gatewayResources } from "@/db";
import { decryptGatewayToken } from "@/lib/gateway-resources";
import { createOwnerConversationFilesClient } from "@/lib/hermes/plugin-client";
import { allCleanupLinks, getContext, hasActiveRequest, updateLink } from "./repository";
export type CleanupReport = { deleted: number; pending: number; preserved: number };
let sweeping = false;
/** The plugin owns lease-aware byte deletion; this ledger never assumes an offline delete succeeded. */
export async function runAttachmentCleanup(now = new Date()): Promise<CleanupReport> {
  const report: CleanupReport = { deleted: 0, pending: 0, preserved: 0 };
  if (sweeping) return report;
  sweeping = true;
  try {
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
