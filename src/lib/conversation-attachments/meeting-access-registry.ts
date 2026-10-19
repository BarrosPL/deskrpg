import { internalRpc } from "@/lib/internal-rpc";
export type MeetingAttachmentAccessInput = {
  userId: string;
  channelId: string;
  contextId: string;
  action: string;
};
type Authorize = (input: MeetingAttachmentAccessInput) => Promise<boolean> | boolean;
const registry = globalThis as typeof globalThis & { __deskrpgMeetingAttachmentAccess?: Authorize };
export function registerMeetingAttachmentAccess(authorize: Authorize) {
  registry.__deskrpgMeetingAttachmentAccess = authorize;
}
export async function canAccessActiveMeetingAttachments(
  input: MeetingAttachmentAccessInput,
): Promise<boolean> {
  if (registry.__deskrpgMeetingAttachmentAccess)
    return registry.__deskrpgMeetingAttachmentAccess(input);
  try {
    const response = (await internalRpc(input.channelId, "attachment-meeting-access", input)) as {
      allowed?: boolean;
    };
    return response?.allowed === true;
  } catch {
    return false;
  }
}
