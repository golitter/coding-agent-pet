/**
 * Kotori Pet Plugin for OpenCode
 *
 * OpenCode 宠物事件映射插件 — 独立调试版。
 * 在 OpenCode TUI 中运行，console.log 输出事件映射结果。
 *
 * 使用方法：
 *   cp desktop/docs/design/opencode-plugin.ts .opencode/plugins/pet-plugin.ts
 *   然后正常启动 OpenCode TUI 即可。
 *
 * 参考：
 *   - 官方文档: https://opencode.ai/docs/zh-cn/plugins/
 *   - 社区教程: https://zhuanlan.zhihu.com/p/2027144829352583703
 *   - 本项目 hooks 文档: desktop/docs/agent-hooks/opencode.md
 */

// ────────────────────────────────────────────
// 事件映射：OpenCode dot.case → PascalCase
// 与 Codex EVENT_ALIASES 等价，归约后查同一张 state_map
// ────────────────────────────────────────────

const OPENCODE_TO_PET: Record<string, string> = {
  // 会话生命周期
  "session.created": "SessionStart",
  "session.idle": "Stop",
  "session.error": "StopFailure",
  "session.deleted": "SessionEnd",
  "session.compacted": "PreCompact",

  // 权限
  "permission.asked": "PermissionRequest",

  // 工具执行（拦截型 hook，不走 event handler）
  "tool.execute.before": "PreToolUse",
  "tool.execute.after": "PostToolUse",
};

// ────────────────────────────────────────────
// state_map：与 config.example.json 保持一致
// PostToolUse 硬编码为 running + "处理中..."
// ────────────────────────────────────────────

const STATE_MAP: Record<string, { state: string; dialogue: string }> = {
  SessionStart: { state: "waving", dialogue: "嗨！小鸟来啦～" },
  UserPromptSubmit: { state: "running", dialogue: "收到！开始工作～" },
  PreToolUse: { state: "running", dialogue: "执行中..." },
  Stop: { state: "jumping", dialogue: "搞定啦！✨" },
  StopFailure: { state: "failed", dialogue: "呜...出了点问题" },
  Notification: { state: "waving", dialogue: "注意哦～" },
  PermissionRequest: { state: "waiting", dialogue: "需要你的授权～" },
  SubagentStop: { state: "idle", dialogue: "" },
  PreCompact: { state: "waiting", dialogue: "整理一下记忆..." },
  SessionEnd: { state: "waving", dialogue: "下次见！♪" },
  QuestionAsked: { state: "waiting", dialogue: "需要你的选择～" },
};

// Terminal 事件：立即删除 session 文件
const TERMINAL_EVENTS = new Set(["StopFailure", "SessionEnd"]);

// ────────────────────────────────────────────
// 工具函数
// ────────────────────────────────────────────

function resolveState(pascalEvent: string): {
  state: string;
  dialogue: string;
} {
  // PostToolUse 硬编码，与 common.py 保持一致
  if (pascalEvent === "PostToolUse") {
    return { state: "running", dialogue: "处理中..." };
  }
  return STATE_MAP[pascalEvent] ?? { state: "idle", dialogue: "" };
}

function logMapping(
  source: string,
  rawEvent: string,
  pascalEvent: string,
  sessionId: string,
): void {
  const { state, dialogue } = resolveState(pascalEvent);
  const isTerminal = TERMINAL_EVENTS.has(pascalEvent);

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      plugin: "kotori-pet",
      source,
      rawEvent,
      pascalEvent,
      state,
      dialogue,
      sessionId,
      isTerminal,
    }),
  );
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

export const PetPlugin: PluginFn = async ({
  project,
  client,
  $,
  directory,
  worktree,
}) => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      plugin: "kotori-pet",
      msg: "initialized",
      project: project?.name ?? "unknown",
      directory,
      worktree,
    }),
  );

  return {
    // ── 拦截型：工具执行 ──
    "tool.execute.before": async (input: any, output: any) => {
      const raw = "tool.execute.before";
      const sid = input?.sessionId ?? input?.session_id ?? "unknown";

      // When AI asks user a question (choice), pet shows waiting state
      if (input?.tool === "question") {
        logMapping("opencode", "question.asked", "QuestionAsked", sid);
        return;
      }

      const pascal = OPENCODE_TO_PET[raw]; // PreToolUse
      logMapping("opencode", raw, pascal, sid);
    },

    "tool.execute.after": async (input: any, output: any) => {
      const raw = "tool.execute.after";

      // Skip question tool aftermath — user already made their choice
      if (input?.tool === "question") return;

      const pascal = OPENCODE_TO_PET[raw]; // PostToolUse
      const sid = input?.sessionId ?? input?.session_id ?? "unknown";
      logMapping("opencode", raw, pascal, sid);
    },

    // ── 事件型：会话生命周期 + 权限 ──
    event: async ({ event }: { event: any }) => {
      const raw = event.type;
      const pascal = OPENCODE_TO_PET[raw];
      if (!pascal) return; // Tier 3 事件，忽略

      const sid =
        event.sessionId ??
        event.session_id ??
        event.id ??
        "unknown";
      logMapping("opencode", raw, pascal, sid);
    },
  };
};

// OpenCode 会自动发现并执行 export 的 plugin 函数
export default PetPlugin;
