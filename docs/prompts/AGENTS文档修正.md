# 📐 AGENTS.md 文档规范

> 适用于本项目根目录与 `desktop/` 子模块的 AGENTS.md 维护。

## 1. 🚪 入口精简

AGENTS.md 只承担**导航级入口**职责，保留三件事：

- **项目简介** — 一句话说明 Kotori Pet 是什么
- **目录结构** — 顶层 `desktop/cross-platform/`、`assets/`、`docs/` 三大块
- **核心命令** — `./setup.sh`、`./build-and-run.sh` 这类高频入口

> 一切详细索引（design / reference / guides / testing / API 列表）一律外移。

## 2. 📎 强制一行引用 details.md

❌ 不允许在 AGENTS.md 中展开文档表格、Hook 列表、精灵图规格。

✅ 统一写为一行引用：

```markdown
详见 [docs/reference/details.md](docs/reference/details.md)
```

## 3. 📏 硬性行数限制

| 文件 | 上限 |
|---|---|
| `/AGENTS.md` | ≤ 70 行 |
| `desktop/AGENTS.md` | ≤ 70 行 |

超出即触发：压缩注释 → 合并段落 → 精简命令示例。**不保留例外**。

## 4. 🧱 纯数据结构化

风格统一，禁止花哨排版：

- **目录树** → ` ```text ` 代码块 + 行内注释
- **命令**   → ` ```bash ` 代码块，仅可运行命令，不加说明性散文
- **路径**   → 使用相对路径（如 `desktop/cross-platform/src-tauri/`）

示例：

```text
.
├── assets/kotori-minami/   # frames/ 运行时 + imagegen/ 生成工件
├── desktop/
│   ├── cross-platform/     # Tauri 主实现
│   │   ├── src/            #   前端 (HTML/CSS/JS)
│   │   └── src-tauri/      #   后端 (Rust)
│   └── docs/               # 架构 / hook / 渲染器
└── docs/                   # 顶层文档 (生成教程)
```

## 5. 🔀 分工明确

| 文件 | 角色 | 内容 |
|---|---|---|
| `AGENTS.md` | 导航入口 | **是什么 / 在哪 / 怎么跑** |
| `docs/reference/details.md` | 技术参考 | design / reference / guides / testing 完整清单、Tauri IPC 通道、Rust commands、Hook 协议、精灵图规格 |

## 6. 🤖 自动同步、直接修复

执行流程：

1. **全量扫描** — 遍历 `desktop/docs/`、`assets/`、`desktop/cross-platform/hooks/`
2. **交叉验证**：
   - 目录存在性（如 `desktop/cross-platform/runtime/sessions/` 是否真存在）
   - 命令有效性（`setup.sh` / `build-and-run.sh` 中的 target）
   - 文件引用（README / details.md 中的链接是否指向真实文件）
   - 索引完整性（details.md 是否覆盖所有子目录文档）
3. **直接修改** — 发现问题即就地修复，**不输出冗长报告**。
