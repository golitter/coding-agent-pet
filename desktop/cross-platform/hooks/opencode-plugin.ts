/**
 * Kotori Pet Plugin for OpenCode.
 *
 * Keeps OpenCode's event stream aligned with the same pet states used by
 * Claude Code and Codex hooks.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  OPENCODE_TO_PET,
  buildPayload,
  debug,
  loadPluginRuntime,
  pushSocket,
  resolvePath,
  resolveSessionId,
  resolveToolEvent,
  writeSession,
} from "./opencode-shared.mjs";

interface PetConfig {
  pet_id: string;
  sessions_dir: string | null;
  socket_path: string | null;
  state_map: Record<string, { state: string; dialogue: string }>;
  terminal_events: string[];
}

interface PluginRuntime {
  platformDir: string;
  repoRoot: string;
  config: PetConfig;
  configPath: string;
}

let runtimeCache: PluginRuntime | null | undefined;

function getRuntime(): PluginRuntime | null {
  if (runtimeCache === undefined) {
    runtimeCache = loadPluginRuntime(import.meta.url) as PluginRuntime | null;
  }
  return runtimeCache;
}

async function handleEvent(
  eventName: string,
  sessionId: string,
  cwd: string,
  toolName: string,
): Promise<void> {
  const runtime = getRuntime();
  if (!runtime) return;

  const { config, repoRoot } = runtime;
  const sessionsDir = resolvePath(config.sessions_dir, repoRoot, [
    "desktop",
    "cross-platform",
    "runtime",
    "sessions",
  ]);
  const socketPath = config.socket_path || "/tmp/kotori-pet.sock";

  try {
    await fs.promises.mkdir(sessionsDir, { recursive: true });
  } catch {
    // 可能已存在
  }

  const payload = buildPayload({ config, eventName, sessionId, cwd, toolName });
  const sessionFile = path.join(sessionsDir, `${sessionId}.json`);

  debug("handleEvent", { eventName, sessionId, state: payload.state, sessionFile });

  await writeSession(sessionFile, payload);
  setTimeout(() => pushSocket(socketPath, payload), 0);
}

type PluginFn = (ctx: {
  project?: any;
  client?: any;
  $?: any;
  directory?: string;
  worktree?: string;
}) => Promise<Record<string, any>>;

export const PetPlugin: PluginFn = async ({ directory }) => {
  const cwd = directory || "";

  debug("plugin initialized", { directory });

  return {
    "tool.execute.before": async (input: any) => {
      try {
        debug("tool.execute.before", { keys: Object.keys(input || {}), tool: input?.tool });
        const sid = resolveSessionId(input);
        const toolName = input?.tool || "";
        await handleEvent(resolveToolEvent(toolName), sid, cwd, toolName);
      } catch (error) {
        debug("tool.execute.before error", { error: String(error) });
      }
    },

    "tool.execute.after": async (input: any) => {
      try {
        if (input?.tool === "question") return;
        debug("tool.execute.after", { keys: Object.keys(input || {}), tool: input?.tool });
        const sid = resolveSessionId(input);
        const toolName = input?.tool || "";
        await handleEvent("PostToolUse", sid, cwd, toolName);
      } catch (error) {
        debug("tool.execute.after error", { error: String(error) });
      }
    },

    event: async ({ event }: { event: any }) => {
      try {
        debug("event", { type: event?.type, sessionID: resolveSessionId(event) });
        const eventName = OPENCODE_TO_PET[event.type];
        if (!eventName) return;
        await handleEvent(eventName, resolveSessionId(event), cwd, "");
      } catch (error) {
        debug("event handler error", { error: String(error) });
      }
    },
  };
};

export default PetPlugin;
