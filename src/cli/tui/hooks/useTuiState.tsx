import React, { createContext, useContext, useReducer, type ReactNode } from "react";
import type { ChatSessionInfo } from "./useChatSession.js";

export interface ServerInfo {
  pid: number;
  port: number;
  uptime: number;
}

export interface ApprovalRequest {
  taskId: string;
  approvalId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  matchedPattern: string;
}

export interface PlanApprovalRequest {
  taskId: string;
  planId: string;
  roleId?: string;
  plan: {
    steps: Array<{
      index: number;
      description: string;
      toolsNeeded: string[];
      expectedOutput: string;
      riskLevel: "low" | "medium" | "high";
    }>;
    requiredPermissions: Record<string, unknown>;
    overallRisk: "low" | "medium" | "high";
  };
}

export interface TuiState {
  connected: boolean;
  serverInfo: ServerInfo | null;
  activeTasks: number;
  queuedTasks: number;
  costToday: number;
  activeTaskId: string | null;
  activeTaskSubmitted: boolean;
  pendingApproval: ApprovalRequest | null;
  pendingPlanApproval: PlanApprovalRequest | null;
  planTimeoutNotice: { planId: string } | null;
  serverUnreachable: boolean;

  view: "chat" | "work" | "tasks" | "config" | "evolution" | "goals" | "strategies" | "templates" | "webhooks" | "memories" | "plugins" | "roles" | "settings" | "channels" | "featureRequests" | "mistakes" | "artifacts";

  selectedTaskId: string | null;
  configVersion: number;
  session: ChatSessionInfo | null;
  version: string | null;
}

export type TuiAction =
  | { type: "SET_CONNECTED"; connected: boolean }
  | { type: "SET_SERVER_INFO"; info: ServerInfo | null }
  | { type: "UPDATE_STATS"; activeTasks: number; queuedTasks: number; costToday: number }
  | { type: "SET_ACTIVE_TASK"; taskId: string | null }
  | { type: "TASK_SUBMITTED" }
  | { type: "SET_PENDING_APPROVAL"; approval: ApprovalRequest | null }
  | { type: "SET_SERVER_UNREACHABLE"; unreachable: boolean }
  | { type: "SET_VIEW"; view: TuiState["view"]; selectedTaskId?: string }
  | { type: "CONFIG_CHANGED" }
  | { type: "SET_SESSION"; session: ChatSessionInfo | null }
  | { type: "SET_PENDING_PLAN_APPROVAL"; approval: PlanApprovalRequest | null }
  | { type: "SET_PLAN_TIMEOUT_NOTICE"; planId: string | null }
  | { type: "SET_VERSION"; version: string | null };

const initialState: TuiState = {
  connected: false,
  serverInfo: null,
  activeTasks: 0,
  queuedTasks: 0,
  costToday: 0,
  activeTaskId: null,
  activeTaskSubmitted: false,
  pendingApproval: null,
  pendingPlanApproval: null,
  planTimeoutNotice: null,
  serverUnreachable: false,
  view: "chat",
  selectedTaskId: null,
  configVersion: 0,
  session: null,
  version: null,
};

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "SET_CONNECTED":
      return { ...state, connected: action.connected };
    case "SET_SERVER_INFO":
      return { ...state, serverInfo: action.info };
    case "UPDATE_STATS":
      return {
        ...state,
        activeTasks: action.activeTasks,
        queuedTasks: action.queuedTasks,
        costToday: action.costToday,
      };
    case "SET_ACTIVE_TASK":
      return { ...state, activeTaskId: action.taskId, activeTaskSubmitted: false };
    case "TASK_SUBMITTED":
      return { ...state, activeTaskSubmitted: true };
    case "SET_PENDING_APPROVAL":
      return { ...state, pendingApproval: action.approval };
    case "SET_SERVER_UNREACHABLE":
      return { ...state, serverUnreachable: action.unreachable };
    case "SET_VIEW":
      return { ...state, view: action.view, selectedTaskId: action.selectedTaskId ?? state.selectedTaskId };
    case "CONFIG_CHANGED":
      return { ...state, configVersion: state.configVersion + 1 };
    case "SET_SESSION":
      return { ...state, session: action.session };
    case "SET_PENDING_PLAN_APPROVAL":
      return { ...state, pendingPlanApproval: action.approval };
    case "SET_PLAN_TIMEOUT_NOTICE":
      return {
        ...state,
        pendingPlanApproval: null,
        planTimeoutNotice: action.planId ? { planId: action.planId } : null,
      };
    case "SET_VERSION":
      return { ...state, version: action.version };
    default:
      return state;
  }
}

interface TuiContextValue {
  state: TuiState;
  dispatch: React.Dispatch<TuiAction>;
}

const TuiContext = createContext<TuiContextValue | null>(null);

export function TuiProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(tuiReducer, initialState);
  return (
    <TuiContext.Provider value={{ state, dispatch }}>
      {children}
    </TuiContext.Provider>
  );
}

export function useTuiState() {
  const context = useContext(TuiContext);
  if (!context) {
    throw new Error("useTuiState must be used within TuiProvider");
  }
  return context;
}
