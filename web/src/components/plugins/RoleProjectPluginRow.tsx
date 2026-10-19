import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { ICON_SIZE } from "@/lib/ui.ts";
import type { RoleGroupedProjectPlugin } from "@/hooks/usePluginsWithUsage.ts";

interface RoleProjectPluginRowProps {
  plugin: RoleGroupedProjectPlugin;
  workspacePath: string;
  onUninstall: (pluginId: string, workspacePath: string) => Promise<void>;
  onUpdate?: (pluginId: string, workspacePath: string) => Promise<void>;
  operatingKey: string | null;
}

export function RoleProjectPluginRow({
  plugin,
  workspacePath,
  onUninstall,
  onUpdate,
  operatingKey,
}: RoleProjectPluginRowProps) {
  const operating = operatingKey === `${plugin.pluginId}:${workspacePath}`;

  return (
    <div className="flex items-center justify-between rounded border border-[var(--app-border)] px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--app-text)]">{plugin.name}</span>
          <span className="text-xs text-[var(--app-text-muted)]">v{plugin.version}</span>
          {plugin.isRoleOnly ? (
            <Badge variant="muted" className="text-[10px]">Role-only</Badge>
          ) : plugin.isOutdated ? (
            <Badge variant="warning" className="text-[10px]">
              {`⚠ behind user (v${plugin.userScopeVersion})`}
            </Badge>
          ) : null}
        </div>
        <p
          className="truncate font-mono text-[11px] text-[var(--app-text-subtle)]"
          title={plugin.installPath}
        >
          {plugin.installPath}
        </p>
      </div>
      <div className="ml-3 flex items-center gap-1">
        {plugin.isOutdated && onUpdate ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={operating}
            onClick={() => void onUpdate(plugin.pluginId, workspacePath)}
          >
            {operating ? (
              <>
                <Loader2 size={ICON_SIZE.xs} className="animate-spin" />
                Update
              </>
            ) : "Update"}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-[var(--app-danger)]"
          disabled={operating}
          onClick={() => void onUninstall(plugin.pluginId, workspacePath)}
        >
          {operating ? (
            <>
              <Loader2 size={ICON_SIZE.xs} className="animate-spin" />
              Uninstall
            </>
          ) : "Uninstall"}
        </Button>
      </div>
    </div>
  );
}
