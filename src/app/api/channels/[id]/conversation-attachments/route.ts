import { NextRequest } from "next/server";
import { attachmentRoute } from "@/lib/conversation-attachments/routes";
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const p = await params;
  return attachmentRoute(req, p.id, "list");
}
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const p = await params;
  return attachmentRoute(req, p.id, "upload");
}
