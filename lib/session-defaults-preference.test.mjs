import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { mapToolNamesToPreset, resolveFreshSessionPreset } = await jiti.import(
  "./session-defaults-preference.ts",
);

test("maps exact preset tool sets to their preset names", () => {
  assert.equal(mapToolNamesToPreset(["read", "bash", "edit", "write"]), "default");
  assert.equal(mapToolNamesToPreset(["read", "grep", "find", "ls"]), "read-only");
  assert.equal(mapToolNamesToPreset(["bash", "read", "edit", "write", "grep", "find", "ls"]), "full");
  assert.equal(mapToolNamesToPreset([]), "none");
});

test("normalizes powershell to bash and ignores order", () => {
  assert.equal(mapToolNamesToPreset(["write", "powershell", "edit", "read"]), "default");
});

test("returns null for tool sets that match no preset", () => {
  assert.equal(mapToolNamesToPreset(["read", "bash", "edit", "write", "grep"]), null);
  assert.equal(mapToolNamesToPreset(undefined), null);
});

test("browser preset wins over the server default tools", () => {
  assert.equal(resolveFreshSessionPreset("full", ["read", "bash", "edit", "write"]), "full");
  assert.equal(resolveFreshSessionPreset("none", ["read", "grep", "find", "ls"]), "none");
});

test("falls back to the server default tools, then to default", () => {
  assert.equal(resolveFreshSessionPreset(null, ["bash", "read", "edit", "write", "grep", "find", "ls"]), "full");
  assert.equal(resolveFreshSessionPreset(null, ["read", "grep"]), "default");
  assert.equal(resolveFreshSessionPreset(null, undefined), "default");
});
