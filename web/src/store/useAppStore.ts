import { create } from "zustand";
import { api, clearStoredApiKey, redirectToLogin, verifyApiKey, getStoredApiKey } from "@/lib/api.ts";
import type {
  Task,
  Goal,
  Strategy,
  TaskTemplate,
  ReadyCheck,
  LogEntry,
  GlobalEvent,
  PlanApprovalRequest,
  Role,
  RoleStatus,
  ExecutionPoolStatus,
  NotifyTarget,
  DeliveryLogEntry,
  LearnedRules,
} from "@/lib/types.ts";

interface Stats {
  activeTasks: number;
  queuedTasks: number;
  totalCostToday: number;
}

interface AppState {
  // Data
  tasks: Task[];
  goals: Goal[];
  strategies: Strategy[];
  templates: TaskTemplate[];
  readiness: ReadyCheck | null;
  stats: Stats;
  logs: LogEntry[];
  configVersion: number; // incremented on config_changed WebSocket events
  pendingPlanApproval: PlanApprovalRequest | null;
  // "pendingPlanApproval": stores a tool operation privilege escalation request.
  // Named "plan approval" for historical reasons — see privilege-escalation-timezone-crystal D-005.
  planTimeoutNotice: string | null;
  roles: Role[];
  executionPool: ExecutionPoolStatus;
  deliveryLog: DeliveryLogEntry[];

  // Connection state
  wsConnected: boolean;
  _ws: WebSocket | null;
  _wsReconnectDelay: number;

  // Actions
  fetchTasks: (status?: string) => Promise<void>;
  fetchGoals: () => Promise<void>;
  updateGoal: (id: string, data: Partial<{ name: string; description: string; status: string; currentValue: number; budgetUsd: number; deliverTo: NotifyTarget[]; reportTo: NotifyTarget[] }>) => Promise<Goal>;
  deleteGoal: (id: string) => Promise<void>;
  fetchStrategies: () => Promise<void>;
  fetchTemplates: () => Promise<void>;
  fetchReadiness: () => Promise<void>;
  fetchExecutionPool: () => Promise<void>;
  connectWebSocket: () => void;
  disconnectWebSocket: () => void;
  addLog: (entry: LogEntry) => void;
  approvePlan: (taskId: string, planId: string, approvalType: "once" | "permanent") => Promise<void>;
  denyPlan: (taskId: string, planId: string, reason?: string) => Promise<void>;
  clearPlanTimeoutNotice: () => void;
  fetchRoles: () => Promise<void>;
  createRole: (data: { name: string; cagPrompt?: string }) => Promise<Role>;
  updateRole: (id: string, data: Partial<{ name: string; cagPrompt: string; learnedRules: LearnedRules; status: RoleStatus; allowedTools: string[]; disallowedTools: string[]; executionMode: string; model: string; maxBudgetUsd: number; additionalDirectories: string[]; osCapabilities: Role["osCapabilities"] }>) => Promise<Role>;
  deleteRole: (id: string, force?: boolean) => Promise<void>;
  addDeliveryLogEntry: (entry: DeliveryLogEntry) => void;
}

const MAX_LOGS = 500;

export const useAppStore = create<AppState>((set, get) => ({
  tasks: [],
  goals: [],
  strategies: [],
  templates: [],
  readiness: null,
  stats: { activeTasks: 0, queuedTasks: 0, totalCostToday: 0 },
  logs: [],
  configVersion: 0,
  pendingPlanApproval: null,
  planTimeoutNotice: null,
  roles: [],
  executionPool: { active: 0, max: 5, queued: 0 },
  deliveryLog: [],
  wsConnected: false,
  _ws: null,
  _wsReconnectDelay: 1000,

  fetchTasks: async (status?: string) => {
    const params = new URLSearchParams({ limit: "100" });
    if (status) params.set("status", status);
    const data = await api<{ tasks: Task[] }>(`/tasks?${params}`);
    set({ tasks: data.tasks });
  },

  fetchGoals: async () => {
    const data = await api<{ goals: Goal[] }>("/goals");
    set({ goals: data.goals });
  },

  updateGoal: async (id, data) => {
    const result = await api<{ goal: Goal }>(`/goals/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    set((state) => ({
      goals: state.goals.map((g) => (g.id === id ? result.goal : g)),
    }));
    return result.goal;
  },

  deleteGoal: async (id) => {
    await api<{ goalId: string; deleted: boolean }>(`/goals/${id}`, {
      method: "DELETE",
    });
    set((state) => ({
      goals: state.goals.filter((g) => g.id !== id),
    }));
  },

  fetchStrategies: async () => {
    const data = await api<{ strategies: Strategy[] }>("/strategies");
    set({ strategies: data.strategies });
  },

  fetchTemplates: async () => {
    const data = await api<{ templates: TaskTemplate[] }>("/task-templates");
    set({ templates: data.templates });
  },

  fetchExecutionPool: async () => {
    try {
      const data = await api<{ executionPool: ExecutionPoolStatus }>("/stats");
      set({ executionPool: data.executionPool });
    } catch {
      // Non-fatal; WebSocket events will update later
    }
  },

  fetchReadiness: async () => {
    try {
      // /readyz returns 503 when not ready, but body still contains real check data
      const response = await fetch("/readyz");
      const data = await response.json() as ReadyCheck;
      set({ readiness: data });
    } catch {
      set({ readiness: { status: "not_ready", checks: { database: false, config: false } } });
    }
  },

  connectWebSocket: () => {
    const existing = get()._ws;
    if (existing && existing.readyState <= 1) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const apiKey = getStoredApiKey();
    const wsUrl = new URL(`${protocol}//${window.location.host}/events`);
    if (apiKey) wsUrl.searchParams.set("api_key", apiKey);
    const ws = new WebSocket(wsUrl.toString());
    let everOpened = false;

    ws.onopen = () => {
      everOpened = true;
      set({ wsConnected: true, _ws: ws, _wsReconnectDelay: 1000 });
    };

    ws.onclose = async () => {
      // If the WS never opened and we have a stored key, the upgrade likely
      // failed with 401 (global hook). Verify the key; if invalid, logout.
      if (!everOpened && apiKey) {
        const valid = await verifyApiKey(apiKey).catch(() => true);
        if (!valid) {
          clearStoredApiKey();
          redirectToLogin();
          return;
        }
      }
      const delay = get()._wsReconnectDelay;
      const nextDelay = Math.min(delay * 2, 10_000);
      set({ wsConnected: false, _ws: null, _wsReconnectDelay: nextDelay });
      setTimeout(() => {
        get().connectWebSocket();
      }, delay);
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as GlobalEvent;
        handleWsEvent(data, set, get);
      } catch {
        // ignore malformed messages
      }
    };

    set({ _ws: ws });
  },

  disconnectWebSocket: () => {
    const ws = get()._ws;
    if (ws) {
      ws.close();
      set({ _ws: null, wsConnected: false });
    }
  },

  addLog: (entry: LogEntry) => {
    set((state) => ({
      logs: [...state.logs.slice(-(MAX_LOGS - 1)), entry],
    }));
  },

  addDeliveryLogEntry: (entry: DeliveryLogEntry) => {
    set((state) => ({
      deliveryLog: [entry, ...state.deliveryLog].slice(0, 100),
    }));
  },

  approvePlan: async (taskId, planId, approvalType) => {
    await api(`/tasks/${taskId}/approve-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId, decision: "allow", approvalType }),
    });
    set({ pendingPlanApproval: null });
  },

  denyPlan: async (taskId, planId, reason) => {
    await api(`/tasks/${taskId}/approve-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId, decision: "deny", reason: reason ?? "rejected by user" }),
    });
    set({ pendingPlanApproval: null });
  },

  clearPlanTimeoutNotice: () => {
    set({ planTimeoutNotice: null });
  },

  fetchRoles: async () => {
    const { roles } = await api<{ roles: Role[] }>("/roles");
    set({ roles });
  },

  createRole: async (data) => {
    const result = await api<{ role: Role }>("/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    set((state) => ({ roles: [...state.roles, result.role] }));
    return result.role;
  },

  updateRole: async (id, data) => {
    const result = await api<{ role: Role }>(`/roles/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    set((state) => ({
      roles: state.roles.map((r) => (r.id === id ? { ...r, ...result.role } : r)),
    }));
    return result.role;
  },

  deleteRole: async (id, force = false) => {
    const apiKey = localStorage.getItem("adam_api_key") ?? "";
    const url = force ? `/roles/${id}?force=true` : `/roles/${id}`;
    const resp = await fetch(url, {
      method: "DELETE",
      headers: { "x-api-key": apiKey },
    });
    if (resp.status === 409) {
      const body = await resp.json() as { code: string; message: string; roleId: string; activeTaskCount: number; taskStatuses: string[] };
      const err = new Error(body.message) as Error & { status: number; code: string; roleId: string; activeTaskCount: number; taskStatuses: string[] };
      err.status = 409;
      err.code = body.code;
      err.roleId = body.roleId;
      err.activeTaskCount = body.activeTaskCount;
      err.taskStatuses = body.taskStatuses;
      throw err;
    }
    if (!resp.ok) throw new Error(`Failed to delete role: ${resp.status}`);
    set((state) => ({
      roles: state.roles.filter((r) => r.id !== id),
    }));
  },

}));

function handleWsEvent(
  event: GlobalEvent,
  set: (fn: (state: AppState) => Partial<AppState>) => void,
  get: () => AppState,
) {
  switch (event.type) {
    case "task_status_change":
      set((state) => ({
        tasks: state.tasks.map((t) =>
          t.id === event.taskId ? { ...t, status: event.newStatus as Task["status"] } : t,
        ),
      }));
      break;

    case "stats_update":
      set(() => ({
        stats: {
          activeTasks: event.activeTasks,
          queuedTasks: event.queuedTasks,
          totalCostToday: event.totalCostToday,
        },
      }));
      break;

    case "log_event":
      get().addLog(event);
      break;

    case "goal_status_change":
      set((state) => ({
        goals: state.goals.map((g) =>
          g.id === event.goalId ? { ...g, status: event.newStatus as Goal["status"] } : g,
        ),
      }));
      break;

    case "config_changed":
      set((state) => ({ configVersion: state.configVersion + 1 }));
      break;

    case "execution_slot_change":
      set(() => ({ executionPool: { active: event.active, max: event.max, queued: event.queued } }));
      break;
    case "plan_approval_request":
      // "plan_approval_request": historical naming — actual semantic is privilege escalation (D-005).
      set(() => ({
        pendingPlanApproval: {
          taskId: event.taskId,
          planId: event.planId,
          plan: event.plan,
        },
      }));
      break;

    case "plan_approval_decision": {
      const current = get().pendingPlanApproval;
      if (current?.planId === event.planId) {
        set(() => ({ pendingPlanApproval: null }));
      }
      break;
    }

    case "delivery_status_change":
      get().addDeliveryLogEntry(event as unknown as DeliveryLogEntry);
      break;

  }
}
