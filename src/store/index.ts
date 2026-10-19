export { getDb, closeDb } from "./db.js";
export { createTask, getTask, updateTask, listTasks, deleteTask } from "./tasks.js";
export { createStepLog, getStepLogs, getStepLogByIndex, deleteTaskLogs } from "./logs.js";
export { createRole, getRole, getRoleByName, updateRole, listRoles, deleteRole, hasActiveTasks } from "./roles.js";
export { RoleHasActiveTasksError } from "../shared/types.js";
export { getRoleWorkspacePath, ensureRoleWorkspace, writeRoleCLAUDEmd, syncRoleSettings } from "./role-workspace.js";
export { initializeDefaultRoles } from "./role-presets.js";
