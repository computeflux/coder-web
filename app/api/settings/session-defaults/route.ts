import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readSessionDefaults, writeSessionDefaults } from "@/lib/session-defaults-settings";

export const dynamic = "force-dynamic";

// GET  /api/settings/session-defaults → current fresh-session defaults
// PUT  /api/settings/session-defaults → partial update (null clears a field)
// Persists to pi's global settings.json (shared with the pi CLI).

export async function GET() {
  try {
    return NextResponse.json({ defaults: await readSessionDefaults() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as {
      model?: { provider: string; modelId: string } | null;
      thinkingLevel?: string | null;
      toolNames?: string[] | null;
    };
    if (body.model !== undefined && body.model !== null
      && (typeof body.model.provider !== "string" || typeof body.model.modelId !== "string")) {
      return NextResponse.json({ error: "model requires provider and modelId" }, { status: 400 });
    }
    if (body.thinkingLevel !== undefined && body.thinkingLevel !== null
      && typeof body.thinkingLevel !== "string") {
      return NextResponse.json({ error: "thinkingLevel must be a string or null" }, { status: 400 });
    }
    if (body.toolNames !== undefined && body.toolNames !== null
      && (!Array.isArray(body.toolNames) || body.toolNames.some((name) => typeof name !== "string"))) {
      return NextResponse.json({ error: "toolNames must be an array of strings or null" }, { status: 400 });
    }
    return NextResponse.json({ defaults: await writeSessionDefaults(body) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
