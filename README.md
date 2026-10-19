<p align="center">
  <img src="web/public/favicon.svg" alt="Adam" width="80" height="80" />
</p>

<h1 align="center">Adam</h1>

<p align="center">
  <strong>AI Agent Orchestration Server</strong>
  <br />
  Built on the <a href="https://docs.anthropic.com/en/docs/agents-sdk">Claude Agent SDK</a>
</p>

<p align="center">
  <a href="#features">Features</a> &middot;
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#web-ui">Web UI</a> &middot;
  <a href="#api-reference">API</a> &middot;
  <a href="#中文说明">中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/adam-agent-server"><img src="https://img.shields.io/npm/v/adam-agent-server" alt="npm" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node.js" />
  <img src="https://img.shields.io/badge/typescript-5.x-blue" alt="TypeScript" />
  <img src="https://img.shields.io/badge/API-80%20endpoints-blue" alt="API" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License" />
</p>

---

Manages task lifecycle, concurrent execution pool, real-time streaming, remote human approval, goal-driven orchestration, and self-evolving agent strategies.

## Maintenance status — historical project

Adam is no longer under active development. This repository preserves the historical implementation for reference, study, and forks; ongoing support and compatibility updates are not promised.

The published package remains available as [`adam-agent-server@1.19.1`](https://www.npmjs.com/package/adam-agent-server/v/1.19.1). Source repository: [n0rvyn/adam](https://github.com/n0rvyn/adam-agent-server). This is a standalone source snapshot of the historical main line. It includes work after the npm 1.19.1 release and is not an exact reproduction of that published package. The experimental SDK-native branch is not included.

The feature descriptions and examples below describe the historical implementation. They are not a fresh validation of the current package or its dependencies.

## Architecture

```
              Client (CLI / TUI / Web UI / HTTP)
                          |
                          v
                +-----------------------+
                |    Fastify Server     |  REST + WebSocket + Swagger UI
                |          |            |
                |    +-----v------+     |
                |    | Scheduler  |     |  Cron + event triggers
                |    |  (Bree)    |     |  Multi-step template executions
                |    +-----+------+     |
                |          |            |
                |  +-------v--------+   |
                |  | ChatManager   |   |  Persistent SDK session, LLM dispatch
                |  +-------+--------+   |
                +---------|-----------+
                          | serverBus events
               +----------+----------+
               v          v          v
          Chat sessions  Execution   Delivery
              +          Pool (N)    Engine
                            |             |
                       Execution      OutboundGateway
                       Manager          (retry, dedup,
                       (fresh          rate limit)
                       query, RBAC)
```

## Features

| Category | Capabilities |
|----------|-------------|
| **Task Management** | Submit, queue, run, cancel; full status tracking; cost and token accounting |
| **Execution Pool** | Configurable concurrent slot pool; event-driven task pickup; poll-based fallback; crash resilience |
| **Scheduling** | Cron expressions (5-field); event-driven triggers (`template_complete:<id>`); multi-step templates with dependency DAGs |
| **Goal System** | Natural language SMART goals; metric trees; Thompson Sampling strategy selection |
| **Role Model** | Role (identity/personality) with allowedTools/disallowedTools; role-level macOS OS Capabilities; learned rules; memory with hybrid search |
| **Real-time Streaming** | WebSocket per-task stream + global event bus; structured pino logging |
| **Security** | 6-layer model: disallowed tools, allowed tools, role OS capabilities, file path checks, human approval, secret redaction |
| **Plugin Support** | Plugin registry (global + project); MCP server passthrough |
| **Web UI** | React SPA with 20 pages; real-time WebSocket updates; mobile responsive (shadcn/ui + Tailwind) |
| **TUI** ⚠️ *deprecated* | Ink-based terminal UI (live streaming, approval prompts, 11 slash commands). **不再维护 / frozen (2026-06-04)** — Web UI 是受支持的交互界面;代码保留未删。 |
| **CLI** | `adam run "prompt"`; JSON output; daemon management |
| **API Docs** | OpenAPI 3.0 via Swagger UI at `/docs`; AI-optimized reference at `docs/CLAUDE-API.md` |

## Quick Start

### Prerequisites

- **Node.js** >= 20
- **pnpm** >= 9
- **`ANTHROPIC_API_KEY`** environment variable (Claude API key)

### Install

```bash
# Option A: npm (recommended)
npm install -g adam-agent-server

# Option B: From source
git clone https://github.com/n0rvyn/adam-agent-server.git
cd adam
pnpm install && pnpm build:all
pnpm link --global
```

### Start

```bash
# Foreground (see logs)
pnpm start

# Or as daemon
adam server start
adam server status
adam server logs -f
```

### Use

```bash
# 1. Start the server (required)
adam server start  # Or: pnpm start

# 2. Interactive TUI (⚠️ deprecated/unmaintained — prefer the Web UI below)
adam

# 3. One-shot task
adam run "Refactor the auth module to use JWT"

# 4. Web UI
# macOS: open http://localhost:7100/ui
# Linux: xdg-open http://localhost:7100/ui
# Or visit in browser: http://localhost:7100/ui

# 5. API
curl -X POST http://localhost:7100/tasks \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Analyze code quality"}'

# 6. Swagger docs
# Visit: http://localhost:7100/docs
```

## Web UI

Full React SPA served at `http://localhost:7100/ui`. Mobile responsive.

**Pages**: Dashboard, Tasks, Templates, Goals, GoalDetail, Roles, RoleDetail, Strategies, Memories, Evolution, Plugins, Channels, ChannelDetail, Chat, Webhooks, Work, Logs, Settings, TaskDetail, NotFound

Built with: Vite + React 19 + TypeScript + Zustand + shadcn/ui + Tailwind CSS

## CLI Commands

```bash
# Server
adam server start|stop|restart|status|logs [-f]

# Tasks
adam run "prompt" [--model M] [--timeout N] [--budget N] [--json] [--no-approval]
adam tasks list [-s status] [-l limit]
adam tasks show <id>
adam tasks cancel <id>

# Info
adam config [--json]
adam evolution [-l limit]
```

### TUI Slash Commands (⚠️ deprecated — TUI 不再维护,改用 Web UI)

`/work` `/config` `/evolution` `/webhooks` `/memories` `/strategies` `/plugins` `/roles` `/settings` `/back` `/quit`

## Configuration

Adam stores config in SQLite DB. The Settings UI (Web UI `/ui/settings`) is the primary editing interface — changes take effect on server restart. CLI flags and environment variables override DB values at startup.

> Note: `adam.config.yaml` is deprecated. On first boot, `.env` seeds the DB; after that DB is authoritative.

```yaml
defaults:
  timeout: 600
  maxTurns: 100
  maxBudgetUsd: 5.0
  effort: high                    # low | medium | high | max
  model: claude-sonnet-4-6
  settingSources: ["user", "project"]
  deniedReadPaths: ["~/.ssh", "~/.aws", "~/.gnupg", "/etc/shadow"]
  approvalRequired: ["rm -rf *", "git push*", "git reset*"]
  approvalTimeout: 300

execution:
  maxConcurrent: 5
  pollIntervalMs: 30000

server:
  port: 7100
  host: "0.0.0.0"

logging:
  level: info                     # debug | info | warn | error
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key (required) |
| `ADAM_PORT` | Server port (default: 7100) |
| `ADAM_LOG_LEVEL` | Log level (default: info) |
| `ADAM_API_KEY` | Overrides DB-stored auth key (disables rotation via UI). Leave unset to let Adam auto-generate on first boot → `~/.adam/adam.key`. See `docs/authentication.md`. |
| `ANTHROPIC_MODEL` | Default model |

## API Reference

**Base URL**: `http://localhost:7100`

Interactive docs: `GET /docs` (Swagger UI)
Machine-readable: `GET /openapi.json`
AI-optimized: [docs/CLAUDE-API.md](docs/CLAUDE-API.md)
WebSocket events: [docs/websocket-events.md](docs/websocket-events.md)

### Endpoints Overview

| Resource | Endpoints | Description |
|----------|-----------|-------------|
| **Tasks** | `POST` `GET` `GET/:id` `POST/:id/cancel` `POST/:id/approve` `POST/:id/reject` `POST/:id/approve-plan` `GET/:id/plan` `GET/:id/logs` `POST /batch-cancel` | Full task lifecycle + batch ops |
| **Roles** | `POST` `GET` `GET/:id` `PATCH/:id` `DELETE/:id` `GET /:id/scores` `GET /:id/presets` | Role CRUD + tool permissions + OS capabilities + workspace management |
| **Memories** | `GET/:roleId` `POST/query` `GET /stats` `GET /:roleId/:memoryId` `DELETE /:roleId/:memoryId` | Role memory with hybrid search |
| **Goals** | `POST` `GET` `GET/:id` `PATCH/:id` `DELETE/:id` | Natural language SMART goals |
| **Strategies** | `GET` `GET /:role/:taskType/probabilities` | Thompson Sampling |
| **Templates** | `POST` `GET` `GET/:id` `PATCH/:id` `DELETE/:id` `POST/:id/run` | Task template CRUD + trigger |
| **Webhooks** | `POST/:name` `GET` | External trigger with API key auth |
| **Channels** | `POST` `GET` `GET/:id` `PATCH/:id` `DELETE/:id` `GET /:id/events` `GET /:id/test` `POST /:id/send` `POST /:id/setup` `GET /platforms` | Channel adapters (WeChat, Telegram, etc.) |
| **Delivery Rules** | `POST` `GET` `GET /:id` `PATCH/:id` `DELETE/:id` `GET /:id/test` | Event-driven delivery routing |
| **Plugins** | `GET` `GET /:id` `POST` `DELETE/:id` `POST /:id/sync` `GET /installed` `GET /available` `POST /scan-directory` `POST /register` | Plugin registry + discovery |
| **Chat** | `POST /messages` `GET /sessions` `GET /sessions/:id` `POST /sessions/:id/restore` `GET /sessions/:id/messages` `DELETE /sessions/:id` `POST /sessions/:id/archive` `POST /sessions` | Chat sessions + messaging + restore |
| **Evolution** | `GET` `GET /:roleId` | Role evolution audit trail |
| **Config** | `GET` `PATCH` `GET /diff` `PATCH /override` `POST /reset` | Runtime configuration + sandbox status + OS capability registry |
| **FS** | `GET /read` `GET /list` `POST /write` `POST /mkdir` | File system operations |
| **Health** | `GET /healthz` `GET /readyz` `GET /metrics` | Liveness + readiness + metrics |
| **WebSocket** | `WS /tasks/:id/stream` `WS /events` `WS /chat/:sessionId` | Real-time streaming |

For full request/response examples, see [docs/CLAUDE-API.md](docs/CLAUDE-API.md).

## Security Model

| Layer | Mechanism | Behavior |
|-------|-----------|----------|
| 1 | `disallowedTools` | Hard block |
| 2 | `allowedTools` | Auto-approve |
| 3 | `role.osCapabilities` + sandbox provider | Role-level macOS system capability gating |
| 4 | Filesystem sandbox + `PreToolUse` hook | Write scope restriction, deniedReadPaths, file path validation |
| 5 | `canUseTool` callback | Remote human approval |
| 6 | `PostToolUse` hook | Log capture + secret redaction |

macOS capability registry is exposed from `GET /config`, mirrored in `adam-tools.get_capabilities`, and rendered in Web/TUI Role settings.

- `runtime-enforced`: editable and enforced by Adam runtime
- `runtime-unavailable`: registered on macOS, but current runtime has no usable sandbox backend so Adam cannot enforce it
- `host-only`: shown for diagnosis, not saved on roles
- `registered-unwired`: shown in the registry, not enforced yet

Current runtime-enforced macOS capabilities:

- `Automation`: launch/control other apps; stored as bundle-id targets such as `com.apple.mail`
- `Accessibility`: desktop UI automation surfaces

## Project Structure

```
adam/
├── src/
│   ├── index.ts                 # Server entry
│   ├── cli/
│   │   ├── index.ts             # CLI entry (commander)
│   │   ├── daemon.ts            # Daemon process management
│   │   ├── client.ts            # HTTP client for daemon
│   │   ├── commands/            # config, evolution, logs, run, tasks
│   │   └── tui/                 # Ink terminal UI (21 components, 11 slash commands)
│   ├── server/
│   │   ├── app.ts               # Fastify + Swagger + static files
│   │   ├── routes/              # 15 route modules (80 endpoints)
│   │   ├── ws/                  # stream, global-events, chat-stream
│   │   └── events/              # ServerBus typed event emitter
│   ├── manager/
│   │   ├── chat-manager.ts      # Persistent SDK session, message routing
│   │   ├── execution-manager.ts  # Fresh query() per task, RBAC via canUseTool
│   │   ├── execution-pool.ts     # N-slot semaphore, event-driven + poll pickup
│   │   ├── adam-tools.ts         # MCP server (53 tools)
│   │   ├── hooks.ts             # SDK hooks (SubagentStart/Stop, PostToolUse, PreCompact)
│   │   ├── chat-system-prompt.ts
│   │   ├── execution-system-prompt.ts
│   │   └── execution-tools.ts
│   ├── agent/
│   │   ├── learner.ts           # Deviation → learnedRules
│   │   ├── memory-extractor.ts   # Step log → role memories
│   │   ├── session-memory-extractor.ts
│   │   ├── memory-service.ts
│   │   ├── reflection.ts         # Importance counter → insight generation
│   │   └── review.ts
│   ├── strategy/
│   │   ├── engine.ts            # Thompson Sampling controller
│   │   ├── sampler.ts
│   │   ├── generator.ts
│   │   ├── reflexion.ts
│   │   └── evaluator/           # L0-L3 collectors, llm-judge, calibration
│   ├── scheduler/
│   │   ├── bree-engine.ts        # Cron + event trigger scheduling
│   │   └── template-executor.ts  # Multi-step TemplateExecution DAG execution
│   ├── delivery/
│   │   ├── engine.ts            # Event subscription, rule matching
│   │   └── outbound-gateway.ts  # Dedup, format, anti-loop, retry, rate limit
│   ├── goal-manager/
│   │   ├── goal-manager.ts
│   │   └── types.ts
│   ├── platform/
│   │   └── watchdog.ts          # Independent health timer
│   ├── monitor/
│   │   ├── monitor.ts           # EMA quality scores, retirement/reinstatement
│   │   ├── score.ts
│   │   ├── retirement.ts
│   │   └── diagnostic.ts
│   ├── channels/
│   │   ├── manager.ts
│   │   ├── adapter.ts
│   │   ├── approval-handler.ts
│   │   └── adapters/            # WeChat, Telegram, Slack, Discord, Openclaw
│   ├── chat/
│   │   ├── context-builder.ts
│   │   ├── message-handler.ts
│   │   └── session-manager.ts
│   ├── store/                   # SQLite persistence (22 .ts files)
│   ├── config/                  # YAML + env + runtime config (6 files)
│   ├── lib/                     # Logger, permissions, embedding, token estimation
│   ├── shared/                  # types.ts, constants.ts
│   ├── admin/
│   │   └── admin-tools.ts
│   └── plugins/
│       └── playwright/          # Browser automation tools
├── web/
│   ├── src/
│   │   ├── pages/               # 20 pages
│   │   ├── components/          # Chat, Layout, Plan, UI components
│   │   ├── store/              # Zustand stores
│   │   └── lib/                # API client, types, utils
│   └── public/
├── docs/
│   ├── CLAUDE-API.md
│   └── websocket-events.md
├── .env.example
└── package.json
```

## Development

```bash
pnpm dev              # Watch mode (tsx)
pnpm test             # Run all tests
pnpm test:unit        # Unit tests only
pnpm test:e2e         # E2E tests only
pnpm test:coverage    # Coverage report
pnpm typecheck        # Type check

# Web UI development
pnpm --filter adam-web dev      # Vite dev server (hot reload)
pnpm --filter adam-web build    # Production build
```

## License

Licensed under the [MIT License](LICENSE).

---

# 中文说明

## 简介

Adam 是一个基于 [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-sdk) 的 AI Agent 编排服务器。管理任务生命周期、并发执行池、实时流式输出、远程人工审批、目标驱动编排和自进化策略。

## 核心能力

- **任务管理**: 提交、队列、执行、取消，完整状态追踪和成本核算
- **并发执行池**: 可配置 slot 数、事件驱动任务拾取、poll 兜底、崩溃恢复
- **定时调度**: 5 字段 Cron 表达式、事件驱动触发（`template_complete:<id>`）、多步工作流（依赖 DAG）
- **目标系统**: 自然语言 SMART 目标、指标树、Thompson Sampling 策略选择
- **Role 模型**: Role（人格/身份），含 allowedTools/disallowedTools、Role 级 macOS OS Capabilities；学习规则、混合搜索记忆
- **实时流**: WebSocket 任务流 + 全局事件总线、pino 结构化日志
- **6 层安全**: 工具禁用、工具白名单、Role 级 OS Capabilities、文件路径检查、人工审批、敏感信息脱敏
- **插件支持**: 通过 `plugins` 配置加载 Claude Code 插件、MCP Server 透传
- **Web UI**: React SPA，20 个页面，WebSocket 实时更新，移动端响应式（shadcn/ui + Tailwind）
- **终端 UI**: 基于 Ink 的 TUI，实时流、审批提示、11 个斜杠命令
- **CLI**: `adam run "prompt"`，JSON 输出，后台进程管理
- **API 文档**: OpenAPI 3.0（Swagger UI `/docs`），AI 优化版 `docs/CLAUDE-API.md`

## 快速开始

```bash
# 前置条件: Node.js >= 20, ANTHROPIC_API_KEY 环境变量

# 方式 A: npm 安装（推荐）
npm install -g adam-agent-server

# 方式 B: 从源码
git clone https://github.com/n0rvyn/adam-agent-server.git
cd adam
pnpm install && pnpm build:all
pnpm link --global

# 启动
pnpm start                    # 前台运行
# 或
adam server start             # 后台 daemon

# 使用
# 1. 启动服务器（必需）
adam server start

# 2. 交互式 TUI（在新终端）
adam

# 3. 单次任务
adam run "重构认证模块"

# 4. Web 管理后台
# macOS: open http://localhost:7100/ui
# Linux: xdg-open http://localhost:7100/ui
# 或在浏览器访问：http://localhost:7100/ui

# 5. API
curl -X POST http://localhost:7100/tasks \
  -H "Content-Type: application/json" \
  -d '{"prompt": "分析代码质量"}'

# 6. API 文档
# 访问：http://localhost:7100/docs
```

## 配置

配置优先级: **CLI 参数 > 环境变量 > .env 文件 > DB（Settings UI）> 默认值**

> 注意：`adam.config.yaml` 已废弃。配置数据存储在 DB 中，Settings UI 为主要编辑界面（重启生效）。`.env` 仅用于首次启动时的初始种子。

| 环境变量 | 说明 |
|---------|------|
| `ANTHROPIC_API_KEY` | Claude API 密钥（必需） |
| `ADAM_PORT` | 服务端口（默认 7100） |
| `ADAM_LOG_LEVEL` | 日志级别（默认 info） |
| `ADAM_API_KEY` | 覆盖 DB 中的认证 key（设置后 UI 轮换返 409）。留空则首启自动生成到 `~/.adam/adam.key`。详见 `docs/authentication.md` |
| `ANTHROPIC_MODEL` | 默认模型 |

## API 概览

80 REST 端点 + 3 WebSocket 端点。完整文档见 `/docs`（Swagger UI）。

| 资源 | 端点 | 说明 |
|------|------|------|
| 任务 | 11 个 | 创建、列表、详情、取消、审批、拒绝、批量取消、执行计划、日志 |
| Role | 7 个 | CRUD + 工作区管理 + 插件绑定 |
| 记忆 | 5 个 | 列表、搜索、详情、统计 |
| 目标 | 5 个 | CRUD + 列表 |
| 策略 | 1 个 | Thompson Sampling |
| 模板 | 6 个 | 定时任务 CRUD + 触发 |
| Webhook | 2 个 | 外部触发 + API Key 认证 |
| Channel | 10 个 | CRUD + 列表 + 详情 |
| Delivery Rule | 6 个 | CRUD + 列表 + 详情 |
| Plugin | 10 个 | CRUD + 同步 + 列表 + 扫描 |
| Chat | 8 个 | 消息、会话、恢复 |
| Evolution | 1 个 | Role 进化审计 |
| Config | 5 个 | 读写、覆盖、重置 |
| FS | 1 个 | 文件操作 |
| 健康检查 | 3 个 | 存活、就绪、指标 |
| WebSocket | 3 个 | 任务流 + 全局事件 + Chat 流 |

---

## Contact

- X (Twitter): [@norvynzhang](https://x.com/norvynzhang)
- GitHub: [n0rvyn](https://github.com/n0rvyn)
- Email: [norvynzhang@gmail.com](mailto:norvynzhang@gmail.com)
