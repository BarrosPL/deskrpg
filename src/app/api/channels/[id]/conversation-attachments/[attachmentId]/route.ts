import { NextRequest } from "next/server";
import { attachmentRoute } from "@/lib/conversation-attachments/routes";
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const p = await params;
  return attachmentRoute(req, p.id, "delete", p.attachmentId);
}
