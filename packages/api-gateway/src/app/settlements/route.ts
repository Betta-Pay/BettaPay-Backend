import { NextResponse } from "next/server";
import { fetchSettlementsFromDb } from "@/lib/db"; // Adjust matching database import string

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const ALLOWED_SORT_COLUMNS = ["createdAt", "amount", "status", "id"];

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    
    // 1. Enforce strict maximum page size clamping boundary
    let limit = parseInt(searchParams.get("limit") || String(DEFAULT_PAGE_SIZE), 10);
    if (isNaN(limit) || limit <= 0) {
      limit = DEFAULT_PAGE_SIZE;
    } else if (limit > MAX_PAGE_SIZE) {
      limit = MAX_PAGE_SIZE; // Silently clamp to max size to prevent pinning the DB
    }

    // 2. Parse cursor-based or offset pagination metrics
    const cursor = searchParams.get("cursor") || null;
    
    // 3. Validate explicit sort column parameters against a safe allow-list
    let sortBy = searchParams.get("sortBy") || "createdAt";
    if (!ALLOWED_SORT_COLUMNS.includes(sortBy)) {
      return NextResponse.json(
        { error: `Invalid sort column. Allowed values: ${ALLOWED_SORT_COLUMNS.join(", ")}` },
        { status: 422 }
      );
    }

    const sortOrder = searchParams.get("sortOrder")?.toLowerCase() === "desc" ? "DESC" : "ASC";

    // Fetch values from underlying database handler tier
    const { items, totalCount, nextCursor } = await fetchSettlementsFromDb({
      limit,
      cursor,
      sortBy,
      sortOrder,
    });

    // 4. Return the data structured cleanly with metadata contracts
    return NextResponse.json({
      data: items,
      pagination: {
        total: totalCount,
        limit,
        nextCursor,
        hasMore: !!nextCursor,
      }
    }, { status: 200 });

  } catch (error) {
    return NextResponse.json({ error: "Internal settlement querying service error." }, { status: 500 });
  }
}
