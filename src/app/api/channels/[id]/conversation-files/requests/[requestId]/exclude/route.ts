import { NextRequest } from "next/server";
import { attachmentRoute } from "@/lib/conversation-attachments/routes";
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; requestId: string }> },
) {
  const p = await params;
  return attachmentRoute(req, p.id, "exclude", p.requestId);
}
