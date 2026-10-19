import { useCallback, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";

export function usePluginMutations(refresh: () => Promise<void>) {
  const [operatingKey, setOperatingKey] = useState<string | null>(null);

  const installToRole = useCallback(async (pluginId: string, workspacePath: string) => {
    setOperatingKey(`${pluginId}:${workspacePath}`);
    try {
      await api(`/plugins/install/${encodeURIComponent(pluginId)}`, {
        method: "POST",
        body: JSON.stringify({ scope: "project", cwd: workspacePath }),
      });
      toast.success(`Installed ${pluginId.split("@")[0]}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Install failed");
    } finally {
      await refresh();
      setOperatingKey(null);
    }
  }, [refresh]);

  const uninstallFromRole = useCallback(async (pluginId: string, workspacePath: string) => {
    setOperatingKey(`${pluginId}:${workspacePath}`);
    try {
      await api(`/plugins/uninstall/${encodeURIComponent(pluginId)}`, {
        method: "POST",
        body: JSON.stringify({ scope: "project", cwd: workspacePath }),
      });
      toast.success("Uninstalled from Role");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Uninstall failed");
    } finally {
      await refresh();
      setOperatingKey(null);
    }
  }, [refresh]);

  const updateRoleVersion = useCallback(async (pluginId: string, workspacePath: string) => {
    setOperatingKey(`${pluginId}:${workspacePath}`);
    let uninstallOk = false;
    try {
      await api(`/plugins/uninstall/${encodeURIComponent(pluginId)}`, {
        method: "POST",
        body: JSON.stringify({ scope: "project", cwd: workspacePath }),
      });
      uninstallOk = true;
      await api(`/plugins/install/${encodeURIComponent(pluginId)}`, {
        method: "POST",
        body: JSON.stringify({ scope: "project", cwd: workspacePath }),
      });
      toast.success("Role updated to latest");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Update failed";
      if (uninstallOk) {
        toast.error(
          `Update failed after uninstall: ${message}. Role reverted to user-scope; re-install manually if needed.`,
          { duration: 8000 },
        );
      } else {
        toast.error(`Update failed: ${message}`);
      }
    } finally {
      await refresh();
      setOperatingKey(null);
    }
  }, [refresh]);

  return { operatingKey, installToRole, uninstallFromRole, updateRoleVersion };
}
