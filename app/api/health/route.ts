import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    hasUpstoxToken: Boolean(process.env.UPSTOX_ACCESS_TOKEN),
    time: new Date().toISOString(),
  });
}
