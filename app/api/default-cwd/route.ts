import { NextResponse } from "next/server";
import { mkdirSync, statSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { allowFileRoot } from "@/lib/file-access";

// Resolves the default working directory for a fresh session:
//   - PI_WEB_DEFAULT_CWD wins when set and pointing at an existing directory,
//     so a deployment can open Pi Web straight at a project instead of an
//     empty dated sandbox. A missing/relative path falls through so a typo can
//     never wedge the UI on a nonexistent workspace.
//   - Otherwise a fresh ~/pi-cwd-<YYYYMMDD> is created, preserving upstream
//     behavior.
function resolveDefaultCwd(): string {
  const configured = process.env.PI_WEB_DEFAULT_CWD?.trim();
  if (configured) {
    const dir = resolve(configured);
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      // Missing path: fall through to the dated fallback below.
    }
  }
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return join(homedir(), `pi-cwd-${date}`);
}

// POST /api/default-cwd
// Returns the default working directory (PI_WEB_DEFAULT_CWD when set and
// existing, else ~/pi-cwd-<YYYYMMDD>), creating it and marking it browsable.
export async function POST() {
  try {
    const dir = resolveDefaultCwd();
    mkdirSync(dir, { recursive: true });
    allowFileRoot(dir);
    return NextResponse.json({ cwd: dir });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
