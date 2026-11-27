import { getToolNamesForPreset, type ToolPreset } from "./tool-presets";

// Resolves the tool selection for a fresh session composer.
// Priority: explicit browser preset (localStorage) > server defaultTools from
// pi's settings.json (mapped to the closest preset) > "default".

const PRESET_BY_TOOL_NAMES = new Map<string, ToolPreset>();

function keyFor(toolNames: readonly string[]): string {
  return [...toolNames].map((name) => (name === "powershell" ? "bash" : name)).sort().join(",");
}

for (const preset of ["none", "read-only", "default", "full"] as const) {
  PRESET_BY_TOOL_NAMES.set(keyFor(getToolNamesForPreset(preset)), preset);
}

export function mapToolNamesToPreset(toolNames: readonly string[] | undefined): ToolPreset | null {
  if (!toolNames) return null;
  return PRESET_BY_TOOL_NAMES.get(keyFor(toolNames)) ?? null;
}

export function resolveFreshSessionPreset(
  browserPreset: ToolPreset | null,
  serverDefaultTools: readonly string[] | undefined,
): ToolPreset {
  return browserPreset ?? mapToolNamesToPreset(serverDefaultTools) ?? "default";
}
