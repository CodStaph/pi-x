import { NextResponse } from "next/server";
import { listTerminalShells } from "@/lib/terminal-shells-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ shells: listTerminalShells() });
}
