import { NextResponse } from "next/server";
import { ApiError } from "./errors";
import { logger } from "./logger";

export function apiJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

export function handleApiError(e: unknown): NextResponse {
  if (e instanceof ApiError) {
    return NextResponse.json({ error: { message: e.message } }, { status: e.status });
  }
  logger.error("api.unhandled-error", {
    error: e instanceof Error ? e.message : String(e),
  });
  return NextResponse.json(
    { error: { message: "Internal server error" } },
    { status: 500 },
  );
}