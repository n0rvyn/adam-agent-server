import { useEffect, useRef } from "react";
import { EventSocket, request } from "../../client.js";
import { useTuiState, type PlanApprovalRequest } from "./useTuiState.js";

const UNREACHABLE_TIMEOUT_MS = 15000;

export function useGlobalEvents() {
  const { state, dispatch } = useTuiState();
  const unreachableTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track sessionId via ref so the execution_task_start handler (inside the long-lived
  // EventSocket closure) always reads the latest value without triggering socket reconnection.
  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => { sessionIdRef.current = state.session?.id ?? null; }, [state.session?.id]);

  useEffect(() => {
    let isMounted = true;
    let socket: EventSocket | null = null;

    const clearUnreachableTimer = () => {
      if (unreachableTimerRef.current) {
        clearTimeout(unreachableTimerRef.current);
        unreachableTimerRef.current = null;
      }
    };

    const startUnreachableTimer = () => {
      clearUnreachableTimer();
      unreachableTimerRef.current = setTimeout(() => {
        if (isMounted) {
          dispatch({ type: "SET_SERVER_UNREACHABLE", unreachable: true });
        }
      }, UNREACHABLE_TIMEOUT_MS);
    };

    const connect = () => {
      try {
        socket = new EventSocket("/events");

        socket.on("task_status_change", () => {
          // Stats updated via stats_update event
        });

        socket.on("approval_request", (data: unknown) => {
          if (!isMounted) return;
          const d = data as { taskId: string; approvalId: string; toolName: string; toolInput: Record<string, unknown>; matchedPattern: string };
          dispatch({
            type: "SET_PENDING_APPROVAL",
            approval: {
              taskId: d.taskId,
              approvalId: d.approvalId,
              toolName: d.toolName,
              toolInput: d.toolInput,
              matchedPattern: d.matchedPattern,
            },
          });
        });

        socket.on("plan_approval_request", (data: unknown) => {
          if (!isMounted) return;
          const d = data as { taskId: string; planId: string; roleId?: string; plan: PlanApprovalRequest["plan"] };
          dispatch({
            type: "SET_PENDING_PLAN_APPROVAL",
            approval: { taskId: d.taskId, planId: d.planId, roleId: d.roleId, plan: d.plan },
          });
        });

        socket.on("plan_approval_decision", () => {
          if (!isMounted) return;
          dispatch({ type: "SET_PENDING_PLAN_APPROVAL", approval: null });
        });

        socket.on("config_changed", () => {
          if (!isMounted) return;
          dispatch({ type: "CONFIG_CHANGED" });
        });

        // Auto-attach task stream when a task starts that belongs to current chat session
        socket.on("execution_task_start", (data: unknown) => {
          if (!isMounted) return;
          const d = data as { taskId: string; slotIndex: number };
          const currentSessionId = sessionIdRef.current;
          if (!currentSessionId) return;
          // Query task to check sourceSessionId match
          void (async () => {
            try {
              const task = await request<{ id: string; sourceSessionId?: string | null }>(`/tasks/${d.taskId}`);
              if (isMounted && task.sourceSessionId === currentSessionId) {
                dispatch({ type: "SET_ACTIVE_TASK", taskId: d.taskId });
              }
            } catch {
              // Task query failure is non-fatal — Layer 1 (chat_message) still delivers final result
            }
          })();
        });

        socket.on("stats_update", (data: unknown) => {
          if (!isMounted) return;
          const d = data as { activeTasks: number; queuedTasks: number; totalCostToday: number };
          dispatch({
            type: "UPDATE_STATS",
            activeTasks: d.activeTasks,
            queuedTasks: d.queuedTasks,
            costToday: d.totalCostToday,
          });
        });

        socket.connect().then(async () => {
          if (isMounted) {
            clearUnreachableTimer();
            dispatch({ type: "SET_CONNECTED", connected: true });
            dispatch({ type: "SET_SERVER_UNREACHABLE", unreachable: false });
            try {
              const data = await request<{ version: string }>("/version");
              dispatch({ type: "SET_VERSION", version: data.version });
            } catch {
              dispatch({ type: "SET_VERSION", version: null });
            }
          }
        }).catch(() => {
          if (isMounted) {
            dispatch({ type: "SET_CONNECTED", connected: false });
            startUnreachableTimer();
          }
        });
      } catch {
        if (isMounted) {
          dispatch({ type: "SET_CONNECTED", connected: false });
          startUnreachableTimer();
        }
      }
    };

    connect();

    return () => {
      isMounted = false;
      clearUnreachableTimer();
      socket?.close();
    };
  }, [dispatch]);
}
