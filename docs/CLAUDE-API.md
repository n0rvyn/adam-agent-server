# Adam Agent Server -- API Reference

## Overview

Adam is an agent orchestration server built on the Claude Agent SDK. It manages task lifecycle, multi-worker process isolation, real-time streaming, agent personas with memory, goal-driven strategies, and self-evolving orchestration.

Interact with Adam via:
- **REST API** -- create/manage tasks, agents, goals, templates, webhooks
- **WebSocket** -- stream real-time execution events per-task or globally
- **CLI** -- `adam run "prompt"` for one-shot execution, `adam` for interactive TUI

## Base URL

```
http://localhost:7100
```

Configurable via:
- Environment variable: `ADAM_PORT=7100`
- Runtime config: `server.port` via Settings UI or `PATCH /config`

## Authentication

Authentication is required **only for webhook endpoints** (`/webhooks/:name`).

When an API key is configured in the server, webhook requests must include:

```
X-API-Key: your-api-key
```

All other endpoints are unauthenticated. Adam is designed to run on a local network or behind a reverse proxy that handles external authentication.

## Error Format

All errors follow this structure:

```json
{
  "code": "ERROR_CODE",
  "message": "Human-readable description"
}
```

Common error codes:

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Request body or query params failed validation |
| `INVALID_STATE` | 400 | Operation not allowed in current resource state |
| `NOT_FOUND` | 404 | Resource does not exist |
| `UNAUTHORIZED` | 401 | Invalid or missing API key (webhooks only) |
| `DISABLED` | 409 | Template is disabled |
| `EXECUTION_ERROR` | 500 | Template execution failed |
| `INVALID_GOAL` | 400 | Goal parsing failed (includes `errors` and `warnings` arrays) |

---

## Endpoints

### Tasks

#### Create a task

```
POST /tasks
```

Create a new task. It enters `pending` status and the scheduler picks it up automatically.

```bash
curl -X POST http://localhost:7100/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Refactor the authentication module to use JWT",
    "agentId": "agent-a1b2c3d4",
    "config": {
      "model": "claude-sonnet-4-6",
      "effort": "high",
      "timeout": 300,
      "maxTurns": 50,
      "maxBudgetUsd": 2.0,
      "allowedTools": ["Read", "Write", "Bash"],
      "approvalRequired": ["rm -rf *", "git push*"],
      "approvalTimeout": 120,
      "env": { "NODE_ENV": "test" }
    }
  }'
```

Response `201`:
```json
{ "taskId": "d290f1ee-6c54-4b01-90e6-d701748f0851" }
```

Config fields (all optional, defaults from DB config):

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Claude model to use |
| `effort` | string | `low`, `medium`, `high`, or `max` |
| `timeout` | number | Seconds before task times out |
| `maxTurns` | number | Maximum SDK conversation turns |
| `maxBudgetUsd` | number | Maximum cost in USD |
| `allowedTools` | string[] | Tools auto-approved without prompting |
| `disallowedTools` | string[] | Tools hard-blocked from execution |
| `mcpServers` | object | MCP server configurations |
| `settingSources` | string[] | Settings source paths |
| `workspacePath` | string | Working directory for the task |
| `approvalRequired` | string[] | Glob patterns triggering human approval (`*` = wildcard) |
| `approvalTimeout` | number | Seconds before approval request times out |
| `env` | object | Environment variables for the worker |

---

### Roles

#### Create a role

```
POST /roles
```

```bash
curl -X POST http://localhost:7100/roles \
  -H "Content-Type: application/json" \
  -d '{
    "name": "MailOps",
    "cagPrompt": "Triage inbound mail and summarize important threads.",
    "allowedTools": ["Read", "Bash", "mactools"],
    "osCapabilities": [
      {
        "id": "automation",
        "targets": ["com.apple.mail", "com.apple.systemevents"]
      },
      { "id": "accessibility" }
    ]
  }'
```

Response `201`:
```json
{
  "role": {
    "id": "role-9f5d0f5e",
    "name": "MailOps",
    "allowedTools": ["Read", "Bash", "mactools"],
    "osCapabilities": [
      {
        "id": "accessibility"
      },
      {
        "id": "automation",
        "targets": ["com.apple.mail", "com.apple.systemevents"]
      }
    ]
  }
}
```

Role fields added for OS capability control:

| Field | Type | Description |
|-------|------|-------------|
| `osCapabilities` | array | Role-level OS capability grants |
| `osCapabilities[].id` | string | Capability id from the `/config` registry |
| `osCapabilities[].targets` | string[] | Required only for target-scoped capabilities such as `automation` |

Validation rules:

- Only `runtime-enforced` capabilities from the registry can be saved on a role
- `automation` requires at least one valid bundle id target
- Capabilities without `supportsTargets` reject `targets`

#### Update a role

```
PATCH /roles/:id
```

```bash
curl -X PATCH http://localhost:7100/roles/role-9f5d0f5e \
  -H "Content-Type: application/json" \
  -d '{
    "allowedTools": ["Read", "Bash", "mactools"],
    "osCapabilities": [
      {
        "id": "automation",
        "targets": ["com.apple.mail"]
      }
    ]
  }'
```

Response `200`:
```json
{
  "role": {
    "id": "role-9f5d0f5e",
    "name": "MailOps",
    "allowedTools": ["Read", "Bash", "mactools"],
    "osCapabilities": [
      {
        "id": "automation",
        "targets": ["com.apple.mail"]
      }
    ]
  }
}
```

---

### Config

#### Get runtime config and OS capability registry

```
GET /config
```

```bash
curl http://localhost:7100/config
```

Response `200`:
```json
{
  "config": {
    "defaults.model": { "value": "claude-sonnet-4-6", "mutable": true },
    "server.port": { "value": 7100, "mutable": false }
  },
  "mutable": ["defaults.model", "logging.level"],
  "restartRequired": ["server.port", "server.host"],
  "sandbox": {
    "platform": "sandbox-exec",
    "available": true
  },
  "osCapabilities": {
    "registry": [
      {
        "id": "automation",
        "label": "Automation",
        "status": "runtime-enforced",
        "availability": "editable",
        "editable": true,
        "supportsTargets": true
      },
      {
        "id": "accessibility",
        "label": "Accessibility",
        "status": "runtime-enforced",
        "availability": "editable",
        "editable": true
      },
      {
        "id": "full-disk-access",
        "label": "Full Disk Access",
        "status": "host-only",
        "availability": "host-only",
        "editable": false
      }
    ]
  }
}
```

Registry semantics:

- `sandbox.platform`: current filesystem sandbox backend such as `sandbox-exec`, `landlock`, or `none`
- `sandbox.available`: whether that backend is usable on the current host
- `runtime-enforced`: Adam can save it on roles and enforce it in runtime
- `runtime-unavailable`: the host is macOS, but the current Adam runtime has no usable macOS sandbox backend, so Role-level enforcement is disabled
- `host-only`: shown for diagnosis only; not saved on roles
- `registered-unwired`: part of the registry, not enforced yet
- `platform-unsupported`: returned when the current host cannot support that capability family

Current runtime-enforced macOS capabilities:

- `automation` with bundle-id targets
- `accessibility`

---

#### List tasks

```
GET /tasks?status=running&limit=10&offset=0
```

```bash
curl "http://localhost:7100/tasks?status=running&limit=10"
```

Response `200`:
```json
{
  "tasks": [
    {
      "id": "d290f1ee-6c54-4b01-90e6-d701748f0851",
      "status": "running",
      "prompt": "Refactor auth module",
      "agentId": "agent-a1b2c3d4",
      "createdAt": 1711234567890,
      "startedAt": 1711234568000
    }
  ]
}
```

Query parameters:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `status` | string | - | Filter: `pending`, `queued`, `running`, `paused`, `completed`, `failed`, `cancelled` |
| `limit` | integer | 100 | Results per page (1-100) |
| `offset` | integer | 0 | Pagination offset |

---

#### Get task by ID

```
GET /tasks/:id
```

```bash
curl http://localhost:7100/tasks/d290f1ee-6c54-4b01-90e6-d701748f0851
```

Response `200`:
```json
{
  "task": {
    "id": "d290f1ee-6c54-4b01-90e6-d701748f0851",
    "status": "completed",
    "prompt": "Refactor auth module",
    "agentId": "agent-a1b2c3d4",
    "result": "Successfully refactored auth module to use JWT...",
    "costUsd": 0.42,
    "numTurns": 12,
    "workerId": "worker-1",
    "createdAt": 1711234567890,
    "startedAt": 1711234568000,
    "completedAt": 1711234590000
  }
}
```

---

#### Cancel a task

```
POST /tasks/:id/cancel
```

Works on tasks in `pending`, `queued`, `running`, or `paused` status. Returns `400` for terminal states.

```bash
curl -X POST http://localhost:7100/tasks/d290f1ee-6c54-4b01-90e6-d701748f0851/cancel
```

Response `200`:
```json
{ "taskId": "d290f1ee-6c54-4b01-90e6-d701748f0851", "status": "cancelled" }
```

---

#### Approve a pending tool call

```
POST /tasks/:id/approve
```

```bash
curl -X POST http://localhost:7100/tasks/d290f1ee-6c54-4b01-90e6-d701748f0851/approve \
  -H "Content-Type: application/json" \
  -d '{"approvalId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}'
```

Response `200`:
```json
{ "approvalId": "f47ac10b-58cc-4372-a567-0e02b2c3d479", "decision": "allow" }
```

---

#### Reject a pending tool call

```
POST /tasks/:id/reject
```

```bash
curl -X POST http://localhost:7100/tasks/d290f1ee-6c54-4b01-90e6-d701748f0851/reject \
  -H "Content-Type: application/json" \
  -d '{"approvalId": "f47ac10b-58cc-4372-a567-0e02b2c3d479", "reason": "Too risky"}'
```

Response `200`:
```json
{ "approvalId": "f47ac10b-58cc-4372-a567-0e02b2c3d479", "decision": "deny" }
```

---

### Agents

#### List agents

```
GET /agents?status=idle&source=user&limit=10&offset=0
```

```bash
curl "http://localhost:7100/agents?status=idle"
```

Response `200`:
```json
{
  "agents": [
    {
      "id": "agent-a1b2c3d4",
      "name": "CodeSmith",
      "role": "engineer",
      "source": "user",
      "status": "idle",
      "traits": ["code quality", "refactoring"],
      "taskCount": 15,
      "createdAt": 1711234567890
    }
  ]
}
```

Query parameters: `status` (`idle`/`busy`/`paused`/`dead`), `source` (`system`/`manager`/`user`), `limit` (1-100), `offset`

---

#### Get agent by ID

```
GET /agents/:id
```

```bash
curl http://localhost:7100/agents/agent-a1b2c3d4
```

Response `200`:
```json
{
  "agent": {
    "id": "agent-a1b2c3d4",
    "name": "CodeSmith",
    "role": "engineer",
    "source": "user",
    "status": "idle",
    "traits": ["code quality", "refactoring"],
    "background": "Expert engineer focused on clean code.",
    "learnedRules": ["Prefer small functions"],
    "taskCount": 15,
    "createdAt": 1711234567890
  }
}
```

---

#### Create an agent

```
POST /agents
```

Provide either `role` (uses a preset) or both `traits` and `background` (custom agent).

Role presets: `engineer`, `analyst`, `content_creator`, `reviewer`

```bash
# From role preset
curl -X POST http://localhost:7100/agents \
  -H "Content-Type: application/json" \
  -d '{"name": "ReviewBot", "role": "reviewer"}'

# Custom agent
curl -X POST http://localhost:7100/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "DataWiz",
    "traits": ["data analysis", "visualization"],
    "background": "Specialist in data pipelines and reporting",
    "preferences": {"model": "claude-sonnet-4-6", "effort": "high", "maxTurns": 30}
  }'
```

Response `201`:
```json
{
  "agent": {
    "id": "agent-e5f6g7h8",
    "name": "ReviewBot",
    "role": "reviewer",
    "status": "idle",
    "traits": ["code review", "quality assurance"],
    "createdAt": 1711234567890
  }
}
```

---

#### Update an agent

```
PATCH /agents/:id
```

All fields optional: `name`, `role`, `traits`, `background`, `preferences`, `learnedRules`, `status`, `toolProfile`, `evaluationCriteria`

```bash
curl -X PATCH http://localhost:7100/agents/agent-a1b2c3d4 \
  -H "Content-Type: application/json" \
  -d '{"traits": ["debugging", "performance optimization"], "status": "paused"}'
```

Response `200`:
```json
{
  "agent": { "id": "agent-a1b2c3d4", "name": "CodeSmith", "status": "paused" }
}
```

---

#### Delete an agent

```
DELETE /agents/:id
```

Cannot delete agents with `busy` status.

```bash
curl -X DELETE http://localhost:7100/agents/agent-a1b2c3d4
```

Response `200`:
```json
{ "agentId": "agent-a1b2c3d4", "deleted": true }
```

---

#### Get agent persona

```
GET /agents/:id/persona
```

Returns the generated CLAUDE.md persona content (markdown string) or `null` if no workspace is configured.

```bash
curl http://localhost:7100/agents/agent-a1b2c3d4/persona
```

Response `200`:
```json
{ "persona": "# Agent Workspace CLAUDE.md\n\n## [system] (Immutable)\n..." }
```

---

### Memories

#### List agent memories

```
GET /memories/:agentId?limit=50&offset=0
```

```bash
curl "http://localhost:7100/memories/agent-a1b2c3d4?limit=20"
```

Response `200`:
```json
{
  "memories": [
    {
      "id": "mem-001",
      "agentId": "agent-a1b2c3d4",
      "content": "JWT refresh tokens should rotate on use.",
      "importance": 4,
      "accessCount": 3,
      "createdAt": 1711234567890,
      "lastAccessedAt": 1711234600000
    }
  ],
  "count": 1
}
```

Embeddings are stripped from the response.

---

#### Query agent memories

```
POST /memories/query
```

Hybrid search using FTS5 full-text search + vector similarity, scored with Smallville-style weighting (recency, importance, relevance).

```bash
curl -X POST http://localhost:7100/memories/query \
  -H "Content-Type: application/json" \
  -d '{"agentId": "agent-a1b2c3d4", "prompt": "authentication patterns", "topK": 5}'
```

Response `200`:
```json
{
  "memories": [
    {
      "id": "mem-001",
      "agentId": "agent-a1b2c3d4",
      "content": "JWT refresh tokens should rotate on use.",
      "importance": 4,
      "score": 0.87,
      "createdAt": 1711234567890
    }
  ],
  "count": 1
}
```

---

### Goals

#### List goals

```
GET /goals?status=executing&limit=20&offset=0
```

```bash
curl "http://localhost:7100/goals?status=executing"
```

Response `200`:
```json
{
  "goals": [
    {
      "id": "goal-001",
      "name": "Improve test coverage to 80%",
      "status": "executing",
      "metricType": "coverage",
      "createdAt": 1711234567890
    }
  ]
}
```

Goal statuses: `pending`, `planning`, `executing`, `evaluating`, `replanning`, `completed`, `failed`, `paused`

---

#### Get goal by ID

```
GET /goals/:id
```

```bash
curl http://localhost:7100/goals/goal-001
```

Response `200`:
```json
{
  "goal": {
    "id": "goal-001",
    "name": "Improve test coverage to 80%",
    "status": "executing",
    "metricType": "coverage",
    "currentValue": 65.5
  }
}
```

---

#### Create a goal

```
POST /goals
```

Parse a natural language input into a structured goal with metric tree.

```bash
curl -X POST http://localhost:7100/goals \
  -H "Content-Type: application/json" \
  -d '{"input": "Improve test coverage to 80% by end of month with $10 budget"}'
```

Response `201`:
```json
{
  "goal": {
    "id": "goal-002",
    "name": "Improve test coverage to 80%",
    "status": "pending",
    "metricType": "coverage"
  }
}
```

Error response `400` (invalid goal):
```json
{
  "code": "INVALID_GOAL",
  "errors": ["Missing target value"],
  "warnings": ["No deadline specified; using default"]
}
```

---

### Strategies

#### List strategies

```
GET /strategies?role=engineer&taskType=refactor&limit=50
```

```bash
curl "http://localhost:7100/strategies?role=engineer"
```

Response `200`:
```json
{
  "strategies": [
    {
      "id": "strat-001",
      "role": "engineer",
      "taskType": "refactor",
      "fitness": 0.85,
      "genome": { "promptTemplate": "...", "alpha": 2, "beta": 1 }
    }
  ]
}
```

---

#### Get sampling probabilities

```
GET /strategies/:role/:taskType/probabilities
```

```bash
curl http://localhost:7100/strategies/engineer/refactor/probabilities
```

Response `200`:
```json
{
  "role": "engineer",
  "taskType": "refactor",
  "stats": { "populationSize": 5, "avgFitness": 0.72 },
  "probabilities": { "strat-001": 0.35, "strat-002": 0.25, "strat-003": 0.40 }
}
```

---

### Task Templates

#### Create a task template

```
POST /task-templates
```

```bash
curl -X POST http://localhost:7100/task-templates \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Daily Code Review",
    "description": "Automated daily code review",
    "trigger": { "type": "cron", "cron": "0 9 * * 1-5" },
    "steps": [
      { "id": "step1", "prompt": "Review recent commits", "outputAs": "review" },
      { "id": "step2", "prompt": "Summarize {{review}}", "dependsOn": ["step1"] }
    ],
    "agentPreference": "reviewer",
    "enabled": true
  }'
```

Response `201`:
```json
{ "templateId": "d290f1ee-6c54-4b01-90e6-d701748f0851" }
```

Trigger types:
- `cron` -- scheduled execution (provide `cron` expression)
- `manual` -- triggered by API call only
- `template_complete` -- triggered when another template completes (provide `template_complete:<templateId>`)
- `task_complete` -- triggered when any task completes

---

#### List task templates

```
GET /task-templates?enabled=true
```

```bash
curl "http://localhost:7100/task-templates?enabled=true"
```

Response `200`:
```json
{
  "templates": [
    {
      "id": "d290f1ee-6c54-4b01-90e6-d701748f0851",
      "name": "Daily Code Review",
      "description": "Automated daily code review",
      "trigger": { "type": "cron", "cron": "0 9 * * 1-5" },
      "enabled": true,
      "createdAt": 1711234567890
    }
  ]
}
```

---

#### Get task template by ID

```
GET /task-templates/:id
```

```bash
curl http://localhost:7100/task-templates/d290f1ee-6c54-4b01-90e6-d701748f0851
```

---

#### Update a task template

```
PATCH /task-templates/:id
```

Cron schedules automatically reschedule when the trigger changes.

```bash
curl -X PATCH http://localhost:7100/task-templates/d290f1ee-6c54-4b01-90e6-d701748f0851 \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

Response `200`:
```json
{ "templateId": "d290f1ee-6c54-4b01-90e6-d701748f0851" }
```

---

#### Delete a task template

```
DELETE /task-templates/:id
```

Cron jobs are automatically unscheduled.

```bash
curl -X DELETE http://localhost:7100/task-templates/d290f1ee-6c54-4b01-90e6-d701748f0851
```

Response `200`:
```json
{ "templateId": "d290f1ee-6c54-4b01-90e6-d701748f0851", "deleted": true }
```

---

#### Manually trigger a template

```
POST /task-templates/:id/run
```

Execute a template immediately regardless of its trigger type.

```bash
curl -X POST http://localhost:7100/task-templates/d290f1ee-6c54-4b01-90e6-d701748f0851/run
```

Response `200`:
```json
{ "executionId": "exec-f47ac10b", "status": "started" }
```

---

### Webhooks

#### Trigger a webhook

```
POST /webhooks/:name
```

Trigger a task template by name or ID. Requires `X-API-Key` header when API key is configured.

```bash
curl -X POST http://localhost:7100/webhooks/daily-code-review \
  -H "X-API-Key: your-api-key"
```

Response `202`:
```json
{
  "code": "ACCEPTED",
  "message": "Template 'Daily Code Review' triggered",
  "executionId": "exec-f47ac10b",
  "templateId": "d290f1ee-6c54-4b01-90e6-d701748f0851"
}
```

---

#### List available webhooks

```
GET /webhooks
```

Lists all enabled task templates that can be triggered via webhook.

```bash
curl http://localhost:7100/webhooks
```

Response `200`:
```json
{
  "webhooks": [
    {
      "name": "d290f1ee-6c54-4b01-90e6-d701748f0851",
      "displayName": "Daily Code Review",
      "description": "Automated daily code review",
      "tags": ["review", "daily"],
      "trigger": "POST /webhooks/d290f1ee-6c54-4b01-90e6-d701748f0851"
    }
  ],
  "auth": "X-API-Key header required"
}
```

---

### Workers

#### List workers

```
GET /workers
```

```bash
curl http://localhost:7100/workers
```

Response `200`:
```json
{
  "workers": [
    { "id": "worker-1", "status": "busy", "taskId": "d290f1ee-...", "pid": 12345 },
    { "id": "worker-2", "status": "idle", "taskId": null, "pid": 12346 }
  ],
  "idleCount": 1,
  "totalCount": 2
}
```

Worker statuses: `idle`, `busy`, `dead`

---

### Health

#### Liveness check

```
GET /healthz
```

Returns `200` if the server process is running.

```bash
curl http://localhost:7100/healthz
```

Response `200`:
```json
{ "status": "ok" }
```

---

#### Readiness check

```
GET /readyz
```

Checks: database, workers, config, agents, embedding model, task hub.

```bash
curl http://localhost:7100/readyz
```

Response `200`:
```json
{
  "status": "ready",
  "checks": {
    "database": true,
    "workers": true,
    "config": true,
    "agents": true,
    "embedding": true,
    "taskHub": true
  }
}
```

Response `503` when any check fails:
```json
{
  "status": "not_ready",
  "checks": { "database": true, "workers": false, "config": true, "agents": false, "embedding": true, "taskHub": true }
}
```

---

## WebSocket Endpoints

See [websocket-events.md](websocket-events.md) for full protocol documentation.

### Per-task stream

```
WS /tasks/:id/stream
```

Connect to receive real-time execution events for a specific task. Events are buffered (last 100 per task); new connections receive all buffered events immediately.

```javascript
const ws = new WebSocket("ws://localhost:7100/tasks/d290f1ee-.../stream");
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // { taskId, index, type, timestamp, data }
};
```

### Global event stream

```
WS /events
```

Receive server-wide events: task status changes, approval requests, worker status changes, stats updates, log events.

```javascript
const ws = new WebSocket("ws://localhost:7100/events");
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // { type, ...payload }
};
```

---

## Common Workflows

### Create a task, stream output, get result

```typescript
// 1. Create task
const res = await fetch("http://localhost:7100/tasks", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "Fix the login bug in src/auth.ts" }),
});
const { taskId } = await res.json();

// 2. Connect to stream
const ws = new WebSocket(`ws://localhost:7100/tasks/${taskId}/stream`);

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case "reasoning":
      console.log("[thinking]", msg.data.content);
      break;
    case "tool_call":
      console.log("[tool]", msg.data.toolName, msg.data.input);
      break;
    case "tool_result":
      console.log("[result]", msg.data.content);
      break;
    case "approval_needed":
      // Handle approval via POST /tasks/:id/approve or /reject
      break;
    case "complete":
      ws.close();
      break;
  }
};

// 3. Get final result
const taskRes = await fetch(`http://localhost:7100/tasks/${taskId}`);
const { task } = await taskRes.json();
console.log("Result:", task.result);
console.log("Cost:", task.costUsd);
```

### Handle approval requests

```typescript
// Listen on global events for approval requests
const events = new WebSocket("ws://localhost:7100/events");

events.onmessage = async (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "approval_request") {
    console.log(`Tool: ${msg.toolName}`);
    console.log(`Pattern: ${msg.matchedPattern}`);
    console.log(`Input:`, msg.toolInput);

    // Approve
    await fetch(`http://localhost:7100/tasks/${msg.taskId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId: msg.approvalId }),
    });
  }
};
```

### Trigger a webhook from CI

```bash
curl -X POST http://localhost:7100/webhooks/deploy-review \
  -H "X-API-Key: $ADAM_API_KEY"
```

---

## Endpoint Summary

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/tasks` | Create a task |
| `GET` | `/tasks` | List tasks |
| `GET` | `/tasks/:id` | Get task by ID |
| `POST` | `/tasks/:id/cancel` | Cancel a task |
| `POST` | `/tasks/:id/approve` | Approve pending tool call |
| `POST` | `/tasks/:id/reject` | Reject pending tool call |
| `GET` | `/roles` | List roles |
| `POST` | `/roles` | Create a role |
| `GET` | `/roles/:id` | Get role details |
| `PATCH` | `/roles/:id` | Update a role |
| `DELETE` | `/roles/:id` | Delete a role |
| `GET` | `/config` | Get runtime config, sandbox status, and OS capability registry |
| `PATCH` | `/config` | Update runtime-mutable config |
| `GET` | `/agents` | List agents |
| `GET` | `/agents/:id` | Get agent by ID |
| `POST` | `/agents` | Create an agent |
| `PATCH` | `/agents/:id` | Update an agent |
| `DELETE` | `/agents/:id` | Delete an agent |
| `GET` | `/agents/:id/persona` | Get agent persona markdown |
| `GET` | `/memories/:agentId` | List agent memories |
| `POST` | `/memories/query` | Query memories (hybrid search) |
| `GET` | `/goals` | List goals |
| `GET` | `/goals/:id` | Get goal by ID |
| `POST` | `/goals` | Create a goal |
| `GET` | `/strategies` | List strategies |
| `GET` | `/strategies/:role/:taskType/probabilities` | Get sampling probabilities |
| `POST` | `/task-templates` | Create a task template |
| `GET` | `/task-templates` | List task templates |
| `GET` | `/task-templates/:id` | Get task template by ID |
| `PATCH` | `/task-templates/:id` | Update a task template |
| `DELETE` | `/task-templates/:id` | Delete a task template |
| `POST` | `/task-templates/:id/run` | Manually trigger a template |
| `POST` | `/webhooks/:name` | Trigger a webhook |
| `GET` | `/webhooks` | List available webhooks |
| `GET` | `/workers` | List worker processes |
| `GET` | `/healthz` | Liveness check |
| `GET` | `/readyz` | Readiness check |
| `WS` | `/tasks/:id/stream` | Per-task event stream |
| `WS` | `/events` | Global event stream |
