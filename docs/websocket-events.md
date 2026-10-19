# Adam WebSocket Protocol

Adam provides two WebSocket endpoints for real-time event streaming.

## Connection

### Per-task stream

```
ws://localhost:7100/tasks/:id/stream
```

Streams execution events for a single task. On connection, the server sends all buffered events (up to 100) for reconnection support.

If the task ID is invalid or not found, the socket is closed with code `1008`.

### Global event stream

```
ws://localhost:7100/events
```

Broadcasts server-wide events to all connected clients. No parameters required.

---

## Per-Task Stream (`/tasks/:id/stream`)

### Event Format

Every message is a JSON-serialized `WsEvent`:

```typescript
interface WsEvent {
  taskId: string;      // UUID of the task
  index: number;       // Monotonically increasing sequence number
  type: WsEventType;   // Event type (see below)
  timestamp: number;   // Unix timestamp in milliseconds
  data: unknown;       // Type-specific payload
}
```

### Event Types

#### `reasoning`

Text output from the model's reasoning process (streamed incrementally as text deltas).

```json
{
  "taskId": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "index": 1,
  "type": "reasoning",
  "timestamp": 1711234568000,
  "data": {
    "content": "Let me analyze the authentication module structure..."
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `data.content` | string | Incremental text chunk from the model |

---

#### `tool_call`

The model is invoking a tool. Emitted when a `content_block_start` with type `tool_use` is received from the SDK.

```json
{
  "taskId": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "index": 2,
  "type": "tool_call",
  "timestamp": 1711234569000,
  "data": {
    "toolName": "Read",
    "input": { "file_path": "src/auth/middleware.ts" }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `data.toolName` | string | Name of the tool being called |
| `data.input` | object | Tool input parameters |

---

#### `tool_result`

The result from a tool execution.

```json
{
  "taskId": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "index": 3,
  "type": "tool_result",
  "timestamp": 1711234570000,
  "data": {
    "content": "import jwt from 'jsonwebtoken';\n..."
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `data.content` | string | Tool output (may be truncated for large results) |

---

#### `approval_needed`

A tool call matched an approval pattern and the task is paused waiting for human decision.

```json
{
  "taskId": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "index": 4,
  "type": "approval_needed",
  "timestamp": 1711234571000,
  "data": {
    "approvalId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "toolName": "Bash",
    "toolInput": { "command": "rm -rf src/auth/legacy/" },
    "matchedPattern": "rm -rf"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `data.approvalId` | string (UUID) | Use this ID to approve or reject via REST API |
| `data.toolName` | string | The tool requesting approval |
| `data.toolInput` | object | The tool's input parameters |
| `data.matchedPattern` | string | The approval pattern that triggered the pause |

To respond, call `POST /tasks/:id/approve` or `POST /tasks/:id/reject` with the `approvalId`.

---

#### `status_change`

The task's status changed.

```json
{
  "taskId": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "index": 5,
  "type": "status_change",
  "timestamp": 1711234572000,
  "data": {
    "oldStatus": "pending",
    "newStatus": "running"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `data.oldStatus` | string | Previous status |
| `data.newStatus` | string | New status |

Valid statuses: `pending`, `queued`, `running`, `paused`, `completed`, `failed`, `cancelled`

---

#### `error`

An error occurred during task execution.

```json
{
  "taskId": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "index": 6,
  "type": "error",
  "timestamp": 1711234573000,
  "data": {
    "message": "Worker process crashed",
    "code": "WORKER_CRASH"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `data.message` | string | Error description |
| `data.code` | string | Error code (when available) |

---

#### `complete`

The task finished execution. This is always the final event in a stream.

```json
{
  "taskId": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "index": 7,
  "type": "complete",
  "timestamp": 1711234574000,
  "data": {
    "status": "completed",
    "result": "Successfully refactored auth module...",
    "costUsd": 0.42,
    "numTurns": 12,
    "durationMs": 6000
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `data.status` | string | Final task status (`completed` or `failed`) |
| `data.result` | string | Task result (on success) |
| `data.error` | string | Error message (on failure) |
| `data.costUsd` | number | Total cost in USD |
| `data.numTurns` | number | Total SDK conversation turns |
| `data.durationMs` | number | Total execution duration in milliseconds |

---

### Event Buffer

The server maintains a circular buffer of the last 100 events per task. When a new WebSocket connection is established for a task, all buffered events are replayed immediately. This supports:

- Reconnection after network interruption
- Late-joining observers
- Multiple simultaneous viewers

---

## Global Event Stream (`/events`)

### Event Format

Events are JSON-serialized `GlobalEvent` objects. Each has a `type` field identifying the event kind.

### Event Types

#### `task_status_change`

A task changed status.

```json
{
  "type": "task_status_change",
  "taskId": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "oldStatus": "pending",
  "newStatus": "running"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `taskId` | string | UUID of the task |
| `oldStatus` | string | Previous status |
| `newStatus` | string | New status |

---

#### `approval_request`

A tool call requires human approval.

```json
{
  "type": "approval_request",
  "taskId": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "approvalId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "toolName": "Bash",
  "toolInput": { "command": "git push origin main --force" },
  "matchedPattern": "git push"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `taskId` | string | UUID of the paused task |
| `approvalId` | string (UUID) | Use to approve/reject via REST API |
| `toolName` | string | The tool requesting approval |
| `toolInput` | object | Tool input parameters |
| `matchedPattern` | string | The approval-required regex pattern that matched |

---

#### `worker_status_change`

A worker process changed status.

```json
{
  "type": "worker_status_change",
  "workerId": "worker-1",
  "oldStatus": "idle",
  "newStatus": "busy"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `workerId` | string | Worker identifier |
| `oldStatus` | string | Previous status (`idle`, `busy`, `dead`) |
| `newStatus` | string | New status |

---

#### `stats_update`

Periodic server statistics snapshot.

```json
{
  "type": "stats_update",
  "activeTasks": 2,
  "queuedTasks": 5,
  "idleWorkers": 1,
  "totalCostToday": 3.42
}
```

| Field | Type | Description |
|-------|------|-------------|
| `activeTasks` | number | Currently running tasks |
| `queuedTasks` | number | Tasks waiting for a worker |
| `idleWorkers` | number | Available worker processes |
| `totalCostToday` | number | Cumulative cost in USD today |

---

#### `log_event`

A structured log entry from any server component.

```json
{
  "type": "log_event",
  "timestamp": 1711234568000,
  "level": "info",
  "component": "scheduler",
  "msg": "Task d290f1ee assigned to worker-1",
  "metadata": { "taskId": "d290f1ee-...", "workerId": "worker-1" }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | number | Unix timestamp in milliseconds |
| `level` | string | Log level: `debug`, `info`, `warn`, `error` |
| `component` | string | Source component: `adam`, `manager`, `worker`, `scheduler`, `api`, `ws`, `cli`, `store`, `embedding` |
| `msg` | string | Log message |
| `metadata` | object | Additional structured data (optional) |

---

### Internal Events (not broadcast to WebSocket)

The following events are emitted on the server bus for internal coordination but are **not** forwarded to WebSocket clients:

| Event Type | Description |
|------------|-------------|
| `worker_complete` | A worker finished a task (fields: `taskId`, `workerId`, `result?`, `error?`) |
| `manager_wake` | Wake signal for the Manager Agent (reasons: `worker_complete`, `tick`, `webhook`, `circuit_break`, `manual`, `task_created`) |
| `goal_status_change` | A goal changed status (fields: `goalId`, `oldStatus`, `newStatus`) |
| `strategy_selected` | A strategy was selected for a goal (fields: `goalId`, `strategyId`) |

---

## Client Examples

### TypeScript -- per-task streaming

```typescript
function streamTask(taskId: string): void {
  const ws = new WebSocket(`ws://localhost:7100/tasks/${taskId}/stream`);

  ws.onopen = () => {
    console.log(`Connected to task ${taskId}`);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data as string);

    switch (msg.type) {
      case "reasoning":
        process.stdout.write(msg.data.content);
        break;
      case "tool_call":
        console.log(`\n[${msg.data.toolName}]`, JSON.stringify(msg.data.input));
        break;
      case "tool_result":
        console.log(`  -> ${msg.data.content.slice(0, 200)}`);
        break;
      case "approval_needed":
        console.log(`\n!! APPROVAL NEEDED: ${msg.data.toolName}`);
        console.log(`   Pattern: ${msg.data.matchedPattern}`);
        console.log(`   Approve: POST /tasks/${taskId}/approve {"approvalId":"${msg.data.approvalId}"}`);
        break;
      case "status_change":
        console.log(`\n[status] ${msg.data.oldStatus} -> ${msg.data.newStatus}`);
        break;
      case "error":
        console.error(`\n[error] ${msg.data.message}`);
        break;
      case "complete":
        console.log(`\n--- Task ${msg.data.status} ---`);
        console.log(`Cost: $${msg.data.costUsd}, Turns: ${msg.data.numTurns}`);
        ws.close();
        break;
    }
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
  };

  ws.onclose = (event) => {
    console.log(`Disconnected (code=${event.code})`);
  };
}
```

### TypeScript -- global event monitoring

```typescript
function monitorEvents(): void {
  const ws = new WebSocket("ws://localhost:7100/events");

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data as string);

    switch (msg.type) {
      case "task_status_change":
        console.log(`Task ${msg.taskId}: ${msg.oldStatus} -> ${msg.newStatus}`);
        break;
      case "approval_request":
        console.log(`Approval needed for task ${msg.taskId}: ${msg.toolName}`);
        break;
      case "worker_status_change":
        console.log(`Worker ${msg.workerId}: ${msg.oldStatus} -> ${msg.newStatus}`);
        break;
      case "stats_update":
        console.log(`Active: ${msg.activeTasks}, Queued: ${msg.queuedTasks}, Idle workers: ${msg.idleWorkers}, Cost today: $${msg.totalCostToday}`);
        break;
      case "log_event":
        console.log(`[${msg.level}] [${msg.component}] ${msg.msg}`);
        break;
    }
  };
}
```

### JavaScript -- browser client

```html
<script>
  const taskId = "d290f1ee-6c54-4b01-90e6-d701748f0851";
  const ws = new WebSocket(`ws://localhost:7100/tasks/${taskId}/stream`);

  ws.onmessage = function(event) {
    const msg = JSON.parse(event.data);
    const output = document.getElementById("output");

    if (msg.type === "reasoning") {
      output.textContent += msg.data.content;
    } else if (msg.type === "tool_call") {
      output.textContent += `\n[${msg.data.toolName}] ${JSON.stringify(msg.data.input)}\n`;
    } else if (msg.type === "complete") {
      output.textContent += `\n--- Done (${msg.data.status}) ---\n`;
    }
  };
</script>
```
