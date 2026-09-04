import { NextResponse } from "next/server";
import { getIpScore } from "../../../../lib/ipReputation";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const ip = searchParams.get("ip");

    if (!ip) {
      return NextResponse.json({ error: "Query parameter 'ip' is strictly required." }, { status: 400 });
    }

    const report = await getIpScore(ip);
    return NextResponse.json(report, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: "Internal gateway scoring service error." }, { status: 500 });
  }
}
