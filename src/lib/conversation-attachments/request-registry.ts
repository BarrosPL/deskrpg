import { internalRpc } from "@/lib/internal-rpc";
import type { AttachmentAccess } from "./access";
export type AttachmentRequestView = { requestId: string; state: string; errorCode?: string };
type Handlers = {
  retry(access: AttachmentAccess, id: string): Promise<AttachmentRequestView>;
  cancel(access: AttachmentAccess, id: string): Promise<AttachmentRequestView>;
};
const registry = globalThis as typeof globalThis & { __deskrpgAttachmentRequests?: Handlers };
export function registerAttachmentRequestHandlers(handlers: Handlers) {
  registry.__deskrpgAttachmentRequests = handlers;
}
export async function invokeAttachmentRequestHandler(
  action: keyof Handlers,
  access: AttachmentAccess,
  id: string,
) {
  const handler = registry.__deskrpgAttachmentRequests?.[action];
  if (!handler)
    return (await internalRpc(access.channelId, `attachment-request-${action}`, {
      userId: access.userId,
      channelId: access.channelId,
      conversation: access.conversation,
      requestId: id,
    })) as AttachmentRequestView;
  return handler(access, id);
}
