import { request } from "../../client.js";
import { useTuiState } from "./useTuiState.js";

export function useServerConnection() {
  const { state, dispatch } = useTuiState();

  const submitPrompt = async (prompt: string): Promise<string | null> => {
    try {
      const response = await request<{ taskId: string }>("/tasks", {
        method: "POST",
        body: { prompt },
      });
      dispatch({ type: "SET_ACTIVE_TASK", taskId: response.taskId });
      dispatch({ type: "TASK_SUBMITTED" });
      return response.taskId;
    } catch {
      return null;
    }
  };

  return {
    connected: state.connected,
    submitPrompt,
  };
}
