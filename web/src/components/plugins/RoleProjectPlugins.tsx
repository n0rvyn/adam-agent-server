import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { RoleProjectPluginRow } from "@/components/plugins/RoleProjectPluginRow.tsx";
import type { RoleGroup } from "@/hooks/usePluginsWithUsage.ts";

interface RoleProjectPluginsProps {
  groups: RoleGroup[];
  layout?: "full" | "single-role";
  singleRoleId?: string;
  onUninstall: (pluginId: string, workspacePath: string) => Promise<void>;
  onUpdate?: (pluginId: string, workspacePath: string) => Promise<void>;
  operatingKey: string | null;
}

export function RoleProjectPlugins({
  groups,
  layout = "full",
  singleRoleId,
  onUninstall,
  onUpdate,
  operatingKey,
}: RoleProjectPluginsProps) {
  const groupsToRender = layout === "single-role"
    ? groups.filter((group) => group.roleId === singleRoleId)
    : groups;

  if (groupsToRender.length === 0) {
    return (
      <EmptyState
        title={layout === "full" ? "All Roles use the user-scope defaults" : "This Role uses the user-scope defaults"}
        className="py-4"
      />
    );
  }

  return (
    <>
      {groupsToRender.map((group) => {
        const workspacePath = group.workspacePath;
        return (
          <section key={group.roleId} className="space-y-2">
            {layout === "full" ? (
              <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--app-text-muted)]">
                {group.roleName}
              </h4>
            ) : null}
            <div className="space-y-2">
              {group.plugins.map((plugin) => (
                <RoleProjectPluginRow
                  key={plugin.pluginId}
                  plugin={plugin}
                  workspacePath={workspacePath}
                  onUninstall={onUninstall}
                  onUpdate={onUpdate}
                  operatingKey={operatingKey}
                />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
