/**
 * Kotori Pet Plugin for OpenCode — Production Version
 *
 * 在 OpenCode TUI 中运行，将事件映射为宠物状态，
 * 写入 session 文件 + 推送 Unix socket，与 Claude Code/Codex 保持一致。
 *
 * 部署方式：由 setup-hooks.sh 自动复制到 ~/.config/opencode/plugins/pet-plugin.ts
 * 参考：desktop/docs/agent-hooks/opencode.md
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

// ────────────────────────────────────────────
// Debug 日志（写文件，console.error 被 OpenCode 吞掉）
// ────────────────────────────────────────────

const DEBUG_LOG = "/tmp/kotori-pet-opencode-debug.log";

function debug(msg: string, data?: any): void {
  try {
    const line = `[${new Date().toISOString()}] ${msg}${data ? " " + JSON.stringify(data) : ""}\n`;
    fs.appendFileSync(DEBUG_LOG, line);
  } catch {
    // Silent
  }
}

// ────────────────────────────────────────────
// Config 加载
// ────────────────────────────────────────────

interface PetConfig {
  pet_id: string;
  sessions_dir: string | null;
  socket_path: string | null;
  state_map: Record<string, { state: string; dialogue: string }>;
  terminal_events: string[];
}

let _platformDir: string | null = null;

function loadConfig(): PetConfig | null {
  try {
    const deployedDir = path.dirname(
      new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"),
    );
    const companionPath = path.join(deployedDir, ".kotori-pet-config-dir");

    if (!fs.existsSync(companionPath)) {
      debug("Companion file not found:", companionPath);
      return null;
    }

    const platformDir = fs.readFileSync(companionPath, "utf-8").trim();
    if (!platformDir || !fs.existsSync(platformDir)) {
      debug("Invalid platform dir:", platformDir);
      return null;
    }

    _platformDir = platformDir;

    const configPath = path.join(platformDir, "config.json");
    if (!fs.existsSync(configPath)) {
      const examplePath = path.join(platformDir, "config.example.json");
      if (!fs.existsSync(examplePath)) {
        debug("No config found in:", platformDir);
        return null;
      }
      return JSON.parse(fs.readFileSync(examplePath, "utf-8"));
    }

    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (e) {
    debug("Config load error:", e);
    return null;
  }
}

let _config: PetConfig | null | undefined;

function getConfig(): PetConfig | null {
  if (_config === undefined) {
    _config = loadConfig();
  }
  return _config;
}

// ────────────────────────────────────────────
// 路径解析（与 common.py resolve() 保持一致）
// ────────────────────────────────────────────

function resolvePath(configVal: string | null | undefined, autoParts: string[]): string {
  if (configVal && typeof configVal === "string" && configVal.trim()) {
    const expanded = configVal.startsWith("~")
      ? path.join(process.env.HOME || "/", configVal.slice(1))
      : configVal;
    if (path.isAbsolute(expanded)) return expanded;
    if (_platformDir) return path.join(_platformDir, expanded);
  }
  if (_platformDir) return path.join(_platformDir, ...autoParts);
  return path.join(...autoParts);
}

// ────────────────────────────────────────────
// 事件映射：OpenCode dot.case → PascalCase
// ────────────────────────────────────────────

const OPENCODE_TO_PET: Record<string, string> = {
  "session.created": "SessionStart",
  "session.idle": "Stop",
  "session.error": "StopFailure",
  "session.deleted": "SessionEnd",
  "session.compacted": "PreCompact",
  "permission.asked": "PermissionRequest",
  "tool.execute.before": "PreToolUse",
  "tool.execute.after": "PostToolUse",
};

// ────────────────────────────────────────────
// 状态解析
// ────────────────────────────────────────────

function resolveState(
  pascalEvent: string,
  stateMap: Record<string, { state: string; dialogue: string }>,
): { state: string; dialogue: string } {
  if (pascalEvent === "PostToolUse") {
    return { state: "running", dialogue: "处理中..." };
  }
  return stateMap[pascalEvent] ?? { state: "idle", dialogue: "" };
}

// ────────────────────────────────────────────
// 异步写入 session 文件（POSIX 原子）
// ────────────────────────────────────────────

async function writeSession(filePath: string, payload: object): Promise<void> {
  try {
    const tmpFile = filePath + ".tmp";
    await fs.promises.writeFile(tmpFile, JSON.stringify(payload, null, 2), "utf-8");
    await fs.promises.rename(tmpFile, filePath);
  } catch {
    // Best-effort
  }
}

// ────────────────────────────────────────────
// Unix socket 推送（fire-and-forget）
// ────────────────────────────────────────────

function pushSocket(socketPath: string, payload: object): void {
  try {
    if (!fs.existsSync(socketPath)) return;

    const data = JSON.stringify(payload) + "\n";
    const sock = net.createConnection(socketPath, () => {
      sock.write(data, () => {
        sock.end();
      });
    });
    sock.setTimeout(100);
    sock.on("timeout", () => sock.destroy());
    sock.on("error", () => sock.destroy());
  } catch {
    // Silent
  }
}

// ────────────────────────────────────────────
// 核心事件处理
// ────────────────────────────────────────────

async function handleEvent(
  pascalEvent: string,
  sessionId: string,
  cwd: string,
  toolName: string,
): Promise<void> {
  const config = getConfig();
  if (!config) return;

  const petId = config.pet_id || "kotori-minami";
  const stateMap = config.state_map || {};
  const terminalEvents = new Set(config.terminal_events || ["StopFailure"]);

  const sessionsDir = resolvePath(config.sessions_dir, ["runtime", "sessions"]);
  const socketPath = config.socket_path || "/tmp/kotori-pet.sock";

  try {
    await fs.promises.mkdir(sessionsDir, { recursive: true });
  } catch {
    // 可能已存在
  }

  const { state, dialogue } = resolveState(pascalEvent, stateMap);
  const isTerminal = terminalEvents.has(pascalEvent);

  const payload = {
    petId,
    state,
    dialogue,
    event: pascalEvent,
    source: "opencode",
    session_id: sessionId,
    updatedAt: new Date().toISOString(),
    isTerminal,
    context: { cwd, tool_name: toolName || "" },
  };

  const sessionFile = path.join(sessionsDir, `${sessionId}.json`);

  debug("handleEvent:", { pascalEvent, sessionId, state, file: sessionFile });

  await writeSession(sessionFile, payload);
  setTimeout(() => pushSocket(socketPath, payload), 0);
}

// ────────────────────────────────────────────
// 插件主体
// ────────────────────────────────────────────

type PluginFn = (ctx: {
  project?: any;
  client?: any;
  $?: any;
  directory?: string;
  worktree?: string;
}) => Promise<Record<string, any>>;

export const PetPlugin: PluginFn = async ({ directory }) => {
  const cwd = directory || "";

  debug("plugin initialized:", { directory });

  return {
    // ── 拦截型：工具执行 ──
    // OpenCode API: ({ tool, sessionID, callID }, { args/output })
    "tool.execute.before": async (input: any) => {
      try {
        debug("tool.execute.before input:", { keys: Object.keys(input || {}), full: input });

        const sid = input?.sessionID ?? "unknown";
        const toolName = input?.tool || "";

        if (input?.tool === "question") {
          await handleEvent("QuestionAsked", sid, cwd, toolName);
          return;
        }

        await handleEvent("PreToolUse", sid, cwd, toolName);
      } catch (e) {
        debug("tool.execute.before error:", e);
      }
    },

    "tool.execute.after": async (input: any) => {
      try {
        if (input?.tool === "question") return;

        debug("tool.execute.after input:", { keys: Object.keys(input || {}), tool: input?.tool });

        const sid = input?.sessionID ?? "unknown";
        const toolName = input?.tool || "";

        await handleEvent("PostToolUse", sid, cwd, toolName);
      } catch (e) {
        debug("tool.execute.after error:", e);
      }
    },

    // ── 事件型：会话生命周期 + 权限 ──
    event: async ({ event }: { event: any }) => {
      try {
        debug("event:", event);

        const raw = event.type;
        const pascal = OPENCODE_TO_PET[raw];
        if (!pascal) return;

        const sid = event?.properties?.sessionID ?? event?.sessionID ?? "unknown";

        await handleEvent(pascal, sid, cwd, "");
      } catch (e) {
        debug("event handler error:", e);
      }
    },
  };
};

export default PetPlugin;
