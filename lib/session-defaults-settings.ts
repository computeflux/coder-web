import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

// Server-side defaults for fresh sessions, stored in pi's global settings.json:
//   defaultModel/defaultProvider  — initial model (pi CLI + pi-web share this)
//   defaultThinkingLevel          — initial thinking level
//   defaultTools                  — active built-in tool set (pi-web presets)

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface SessionDefaults {
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  toolNames?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettings(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error("Invalid settings.json: expected an object");
  return parsed;
}

export function getSessionDefaultsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "settings.json");
}

function configuredString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid settings.json: ${field} must be a non-empty string`);
  }
  return value;
}

function configuredStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    throw new Error(`Invalid settings.json: ${field} must be an array of strings`);
  }
  return value as string[];
}

export async function readSessionDefaults(
  settingsPath = getSessionDefaultsPath(),
): Promise<SessionDefaults> {
  if (!existsSync(settingsPath)) return {};
  const release = await lockfile.lock(settingsPath, { realpath: false, retries: 10 });
  try {
    const settings = parseSettings(readFileSync(settingsPath, "utf8"));
    const provider = configuredString(settings.defaultProvider, "defaultProvider");
    const modelId = configuredString(settings.defaultModel, "defaultModel");
    const thinkingLevel = configuredString(settings.defaultThinkingLevel, "defaultThinkingLevel");
    const toolNames = configuredStringArray(settings.defaultTools, "defaultTools");
    return {
      ...(provider && modelId ? { model: { provider, modelId } } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(toolNames ? { toolNames } : {}),
    };
  } finally {
    await release();
  }
}

export interface SessionDefaultsUpdate {
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: string | null;
  toolNames?: string[] | null;
}

/**
 * Merge a partial update into pi's global settings.json. A null value clears
 * the corresponding setting (fresh sessions then fall back to pi defaults);
 * an omitted field is left untouched. Writes the whole file under a lock so
 * concurrent readers never observe a truncated JSON document.
 */
export async function writeSessionDefaults(
  update: SessionDefaultsUpdate,
  settingsPath = getSessionDefaultsPath(),
): Promise<SessionDefaults> {
  mkdirSync(dirname(settingsPath), { recursive: true });
  try {
    writeFileSync(settingsPath, "{}", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const release = await lockfile.lock(settingsPath, { realpath: false, retries: 10 });
  try {
    const settings = parseSettings(readFileSync(settingsPath, "utf8"));

    if (update.model === null) {
      delete settings.defaultModel;
      delete settings.defaultProvider;
    } else if (update.model) {
      const provider = update.model.provider.trim();
      const modelId = update.model.modelId.trim();
      if (!provider || !modelId) throw new Error("model requires provider and modelId");
      settings.defaultProvider = provider;
      settings.defaultModel = modelId;
    }

    if (update.thinkingLevel === null) {
      delete settings.defaultThinkingLevel;
    } else if (update.thinkingLevel !== undefined) {
      if (!THINKING_LEVELS.has(update.thinkingLevel)) {
        throw new Error(`Invalid thinking level: ${update.thinkingLevel}`);
      }
      settings.defaultThinkingLevel = update.thinkingLevel;
    }

    if (update.toolNames === null) {
      delete settings.defaultTools;
    } else if (update.toolNames !== undefined) {
      if (update.toolNames.some((name) => typeof name !== "string")) {
        throw new Error("toolNames must be an array of strings");
      }
      settings.defaultTools = [...update.toolNames];
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    chmodSync(settingsPath, 0o600);
  } finally {
    await release();
  }
  return readSessionDefaults(settingsPath);
}
