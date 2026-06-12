import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

export const DEBUG_LOG = "/tmp/kotori-pet-opencode-debug.log";
export const DEFAULT_STATE = { state: "idle", dialogue: "" };
export const POST_TOOL_STATE = { state: "running", dialogue: "处理中..." };
export const DEFAULT_TERMINAL_EVENTS = ["StopFailure"];

function isDebugEnabled() {
  const raw = process.env.KOTORI_PET_OPENCODE_DEBUG;
  return raw === "1" || raw === "true";
}

export const OPENCODE_TO_PET = {
  "session.created": "SessionStart",
  "session.idle": "Stop",
  "session.error": "StopFailure",
  "session.deleted": "SessionEnd",
  "session.compacted": "PreCompact",
  "permission.asked": "PermissionRequest",
  "tool.execute.before": "PreToolUse",
  "tool.execute.after": "PostToolUse",
};

export function debug(message, data) {
  if (!isDebugEnabled()) return;
  try {
    const suffix = data ? ` ${JSON.stringify(data)}` : "";
    const line = `[${new Date().toISOString()}] ${message}${suffix}\n`;
    fs.appendFileSync(DEBUG_LOG, line);
  } catch {
    // Best-effort only.
  }
}

export function toNativeImportPath(importMetaUrl) {
  return new URL(importMetaUrl).pathname.replace(/^\/([A-Z]:)/, "$1");
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export function findConfigPath(platformDir) {
  const configPath = path.join(platformDir, "config.json");
  if (fs.existsSync(configPath)) return configPath;

  const examplePath = path.join(platformDir, "config.example.json");
  return fs.existsSync(examplePath) ? examplePath : null;
}

export function detectRepoRoot(platformDir) {
  const normalized = path.resolve(platformDir);
  const base = path.basename(normalized);
  const parent = path.basename(path.dirname(normalized));
  if (base === "cross-platform" && parent === "desktop") {
    return path.resolve(normalized, "..", "..");
  }
  return path.dirname(normalized);
}

export function loadPluginRuntime(importMetaUrl) {
  try {
    const deployedDir = path.dirname(toNativeImportPath(importMetaUrl));
    const companionPath = path.join(deployedDir, ".kotori-pet-config-dir");

    if (!fs.existsSync(companionPath)) {
      debug("Companion file not found", { companionPath });
      return null;
    }

    const platformDir = fs.readFileSync(companionPath, "utf-8").trim();
    if (!platformDir || !fs.existsSync(platformDir)) {
      debug("Invalid platform dir", { platformDir });
      return null;
    }

    const configPath = findConfigPath(platformDir);
    if (!configPath) {
      debug("No config found", { platformDir });
      return null;
    }

    const repoRoot = detectRepoRoot(platformDir);

    return {
      platformDir,
      repoRoot,
      config: readJson(configPath),
      configPath,
    };
  } catch (error) {
    debug("Config load error", { error: String(error) });
    return null;
  }
}

export function resolvePath(configValue, baseDir, fallbackParts) {
  if (typeof configValue === "string" && configValue.trim()) {
    const expanded = configValue.startsWith("~")
      ? path.join(process.env.HOME || "/", configValue.slice(1))
      : configValue;
    return path.isAbsolute(expanded) ? expanded : path.join(baseDir, expanded);
  }

  return path.join(baseDir, ...fallbackParts);
}

export function resolveState(eventName, stateMap = {}) {
  if (eventName === "PostToolUse") {
    return { ...POST_TOOL_STATE };
  }

  return { ...(stateMap[eventName] ?? DEFAULT_STATE) };
}

export function resolveToolEvent(toolName) {
  return toolName === "question" ? "QuestionAsked" : "PreToolUse";
}

export function resolveSessionId(payload = {}) {
  return payload?.properties?.sessionID ?? payload?.sessionID ?? "unknown";
}

export function buildPayload({ config, eventName, sessionId, cwd, toolName }) {
  const petId = config?.pet_id || "kotori-minami";
  const stateMap = config?.state_map || {};
  const terminalEvents = new Set(config?.terminal_events || DEFAULT_TERMINAL_EVENTS);
  const { state, dialogue } = resolveState(eventName, stateMap);

  return {
    petId,
    state,
    dialogue,
    event: eventName,
    source: "opencode",
    session_id: sessionId,
    updatedAt: new Date().toISOString(),
    isTerminal: terminalEvents.has(eventName),
    context: {
      cwd,
      tool_name: toolName || "",
    },
  };
}

export async function writeSession(filePath, payload) {
  try {
    const tmpFile = `${filePath}.tmp`;
    await fs.promises.writeFile(tmpFile, JSON.stringify(payload, null, 2), "utf-8");
    await fs.promises.rename(tmpFile, filePath);
  } catch {
    // Best-effort only.
  }
}

export function pushSocket(socketPath, payload) {
  try {
    if (!fs.existsSync(socketPath)) return;

    const socket = net.createConnection(socketPath, () => {
      socket.write(`${JSON.stringify(payload)}\n`, () => socket.end());
    });
    socket.setTimeout(100);
    socket.on("timeout", () => socket.destroy());
    socket.on("error", () => socket.destroy());
  } catch {
    // Best-effort only.
  }
}
