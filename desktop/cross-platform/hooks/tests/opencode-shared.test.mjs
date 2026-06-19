import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import {
  OPENCODE_TO_PET,
  buildPayload,
  defaultEventEndpoint,
  detectRepoRoot,
  findConfigPath,
  isWsl,
  loadPluginRuntime,
  resolvePetBaseDir,
  resolvePath,
  resolveSessionId,
  resolveState,
  resolveToolEvent,
} from "../opencode-shared.mjs";

function norm(p) {
  return path.normalize(p);
}

test("OpenCode event map stays aligned with pet events", () => {
  assert.equal(OPENCODE_TO_PET["session.created"], "SessionStart");
  assert.equal(OPENCODE_TO_PET["permission.asked"], "PermissionRequest");
  assert.equal(OPENCODE_TO_PET["tool.execute.after"], "PostToolUse");
});

test("resolveState keeps PostToolUse as running regardless of config", () => {
  const state = resolveState("PostToolUse", {
    PostToolUse: { state: "idle", dialogue: "should not win" },
  });

  assert.deepEqual(state, { state: "running", dialogue: "处理中..." });
});

test("resolveToolEvent treats question specially", () => {
  assert.equal(resolveToolEvent("question"), "QuestionAsked");
  assert.equal(resolveToolEvent("bash"), "PreToolUse");
});

test("buildPayload carries terminal state and context", () => {
  const payload = buildPayload({
    config: {
      pet_id: "kotori-minami",
      terminal_events: ["SessionEnd"],
      state_map: {
        SessionEnd: { state: "waving", dialogue: "bye" },
      },
    },
    eventName: "SessionEnd",
    sessionId: "abc",
    cwd: "/tmp/work",
    toolName: "bash",
  });

  assert.equal(payload.petId, "kotori-minami");
  assert.equal(payload.state, "waving");
  assert.equal(payload.dialogue, "bye");
  assert.equal(payload.isTerminal, true);
  assert.deepEqual(payload.context, { cwd: "/tmp/work", tool_name: "bash" });
});

test("resolvePath uses the provided base dir for relative values and fallback paths", () => {
  assert.equal(
    resolvePath("runtime/custom", "/repo/root", [
      "desktop",
      "cross-platform",
      "runtime",
      "sessions",
    ]),
    norm("/repo/root/runtime/custom"),
  );
  assert.equal(
    resolvePath(null, "/repo/root", ["desktop", "cross-platform", "runtime", "sessions"]),
    norm("/repo/root/desktop/cross-platform/runtime/sessions"),
  );
});

test("resolvePetBaseDir and resolvePath keep plugin path semantics aligned with Rust", () => {
  assert.equal(
    resolvePetBaseDir({ pet_base_dir: "pets/kotori" }, "/repo/root"),
    norm("/repo/root/pets/kotori"),
  );
  assert.equal(resolvePetBaseDir({}, "/repo/root"), norm("/repo/root"));
  assert.equal(
    resolvePath(
      "runtime/custom",
      resolvePetBaseDir({ pet_base_dir: "pets/kotori" }, "/repo/root"),
      ["desktop", "cross-platform", "runtime", "sessions"],
    ),
    norm("/repo/root/pets/kotori/runtime/custom"),
  );
});

test("defaultEventEndpoint prefers explicit values and keeps platform defaults", () => {
  assert.equal(
    defaultEventEndpoint({ event_endpoint: "tcp://127.0.0.1:9999" }),
    "tcp://127.0.0.1:9999",
  );

  const fallback = defaultEventEndpoint({ socket_path: "/tmp/custom.sock" });
  assert.equal(
    fallback,
    process.platform === "win32" ? "tcp://127.0.0.1:17361" : "/tmp/custom.sock",
  );
});

test("defaultEventEndpoint uses TCP inside WSL", () => {
  assert.equal(
    defaultEventEndpoint(
      { socket_path: "/tmp/custom.sock" },
      { env: { WSL_DISTRO_NAME: "Ubuntu" }, procVersionText: "" },
    ),
    "tcp://127.0.0.1:17361",
  );
  assert.equal(isWsl({}, "Linux version 6.6.87.2-microsoft-standard-WSL2"), true);
});

test("detectRepoRoot handles real app layout and flat test fixtures", () => {
  assert.equal(detectRepoRoot("/repo/desktop/cross-platform"), path.resolve("/repo"));
  assert.equal(detectRepoRoot("/tmp/kotori-plugin/platform"), path.resolve("/tmp/kotori-plugin"));
});

test("resolveSessionId prefers nested event properties", () => {
  assert.equal(
    resolveSessionId({ properties: { sessionID: "nested" }, sessionID: "top" }),
    "nested",
  );
  assert.equal(resolveSessionId({ sessionID: "top" }), "top");
  assert.equal(resolveSessionId({}), "unknown");
});

test("loadPluginRuntime prefers config.json and falls back to example config", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kotori-plugin-"));
  const deployedDir = path.join(tempDir, "plugins");
  const platformDir = path.join(tempDir, "desktop", "cross-platform");
  fs.mkdirSync(deployedDir, { recursive: true });
  fs.mkdirSync(platformDir, { recursive: true });

  const runtimeUrl = new URL(`file://${path.join(deployedDir, "pet-plugin.ts")}`);
  fs.writeFileSync(path.join(deployedDir, ".kotori-pet-config-dir"), platformDir);
  fs.writeFileSync(
    path.join(platformDir, "config.example.json"),
    JSON.stringify({ pet_id: "example-pet" }),
  );

  let runtime = loadPluginRuntime(runtimeUrl.href);
  assert.equal(runtime?.config.pet_id, "example-pet");
  assert.equal(runtime?.repoRoot, tempDir);
  assert.equal(findConfigPath(platformDir), path.join(platformDir, "config.example.json"));

  fs.writeFileSync(path.join(platformDir, "config.json"), JSON.stringify({ pet_id: "real-pet" }));

  runtime = loadPluginRuntime(runtimeUrl.href);
  assert.equal(runtime?.config.pet_id, "real-pet");
  assert.equal(runtime?.repoRoot, tempDir);
  assert.equal(findConfigPath(platformDir), path.join(platformDir, "config.json"));
});

test("toNativeImportPath-style runtime loading handles Windows drive paths", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kotori-plugin-winpath-"));
  const deployedDir = path.join(tempDir, "plugins");
  const platformDir = path.join(tempDir, "desktop", "cross-platform");
  fs.mkdirSync(deployedDir, { recursive: true });
  fs.mkdirSync(platformDir, { recursive: true });
  fs.writeFileSync(path.join(deployedDir, ".kotori-pet-config-dir"), platformDir);
  fs.writeFileSync(path.join(platformDir, "config.example.json"), JSON.stringify({}));

  const runtimeUrl = new URL(`file://${path.join(deployedDir, "pet-plugin.ts")}`);
  const runtime = loadPluginRuntime(runtimeUrl.href);
  assert.equal(runtime?.platformDir, platformDir);
});
