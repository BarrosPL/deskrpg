import { readBoundedFormData } from "./upload-body";
import { validateAttachmentSelection } from "./policy";
import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/internal-rpc";
import { streamProxyResponse } from "@/lib/hermes/stream-proxy";
import { AttachmentServiceError, resolveAttachmentAccess, type AttachmentAction } from "./access";
import { listAttachments, requestAttachmentDeletion, requireLink, uploadOriginal } from "./service";
import { getRequest } from "./repository";
import { invokeAttachmentRequestHandler } from "./request-registry";
import type { ConversationRef } from "./types";
export async function attachmentRoute(
  req: NextRequest,
  channelId: string,
  operation: "list" | "upload" | "delete" | "content" | "request" | "retry" | "cancel" | "exclude",
  id?: string,
) {
  try {
    const kind = req.nextUrl.searchParams.get("kind");
    const targetId = req.nextUrl.searchParams.get("id");
    if (!["dm", "room", "meeting"].includes(kind ?? "") || !targetId)
      throw new AttachmentServiceError(400, "attachment_invalid_selection");
    const conversation = { kind: kind as ConversationRef["kind"], id: targetId };
    const action: AttachmentAction =
      operation === "upload"
        ? "upload"
        : operation === "delete"
          ? "delete"
          : ["retry", "cancel", "exclude"].includes(operation)
            ? "prepare"
            : "read";
    const access = await resolveAttachmentAccess(getUserId(req), channelId, conversation, action);
    if (operation === "list")
      return NextResponse.json({ conversation, files: await listAttachments(access) });
    if (operation === "upload") {
      const form = await readBoundedFormData(req);
      const file = form.get("file");
      const requestId = form.get("requestId");
      if (
        !(file instanceof File) ||
        typeof requestId !== "string" ||
        form.getAll("file").length !== 1
      )
        throw new AttachmentServiceError(400, "attachment_invalid_file");
      return NextResponse.json(
        { conversation, file: await uploadOriginal(access, requestId, file) },
        { status: 201 },
      );
    }
    if (!id) throw new AttachmentServiceError(400, "attachment_invalid_selection");
    if (operation === "delete") {
      await requestAttachmentDeletion(access, id);
      return NextResponse.json({ ok: true });
    }
    if (operation === "content") {
      const link = await requireLink(access, id);
      const response = await access.client.content(link.pluginFileId);
      if (!response.ok) throw new AttachmentServiceError(response.status, "attachment_not_found");
      return streamProxyResponse(response.response, { forceAttachment: true });
    }
    const request = await getRequest(id);
    if (
      !request ||
      request.contextId !== access.context.id ||
      (conversation.kind !== "meeting" && request.senderId !== access.userId)
    )
      throw new AttachmentServiceError(404, "attachment_not_found");
    if (operation === "request")
      return NextResponse.json({ requestId: request.id, state: request.status });
    let fileIds: string[] = [];
    if (operation === "exclude") {
      const body = await req.json().catch(() => null);
      if (
        !body ||
        !Array.isArray(body.fileIds) ||
        body.fileIds.some((id: unknown) => typeof id !== "string") ||
        validateAttachmentSelection(body.fileIds)
      )
        throw new AttachmentServiceError(400, "attachment_invalid_selection");
      fileIds = body.fileIds;
    }
    return NextResponse.json(await invokeAttachmentRequestHandler(operation, access, id, fileIds));
  } catch (error) {
    const e =
      error instanceof AttachmentServiceError
        ? error
        : new AttachmentServiceError(502, "attachment_prepare_failed");
    return NextResponse.json(
      { error: e.code, errorCode: e.code, code: e.code },
      { status: e.status },
    );
  }
}
