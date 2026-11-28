import { isToolPreset, type ToolPreset } from "./tool-presets";

// Browser-persisted tool preset for fresh sessions. Kept separate from pi's
// settings.json so a preset chosen in this browser never rewrites the global
// server-side default that the pi CLI shares.

const PRESET_STORAGE_KEY = "pi-tool-preset";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// null = no explicit choice in this browser (fresh composers then follow pi's
// settings.json defaultTools); an explicit "default" preset is still a choice.
export function getExplicitToolPreset(
  storage: StorageLike | null = getBrowserStorage(),
): ToolPreset | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(PRESET_STORAGE_KEY);
    return isToolPreset(value) ? value : null;
  } catch {
    return null;
  }
}

export function getPreferredToolPreset(
  storage: StorageLike | null = getBrowserStorage(),
): ToolPreset {
  return getExplicitToolPreset(storage) ?? "default";
}

export function setPreferredToolPreset(
  preset: ToolPreset,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(PRESET_STORAGE_KEY, preset);
  } catch {
    // Browser storage is best-effort.
  }
}
