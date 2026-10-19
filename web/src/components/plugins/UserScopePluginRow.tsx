import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Loader2, MoreHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/Badge.tsx";
import { Button } from "@/components/ui/Button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/Tooltip.tsx";
import { ICON_SIZE } from "@/lib/ui.ts";
import type { RoleRef, UserScopePlugin } from "@/hooks/usePluginsWithUsage.ts";

interface UserScopePluginRowProps {
  plugin: UserScopePlugin;
  roles: RoleRef[];
  expandedContent?: ReactNode;
  onInstallToRole: (pluginId: string, workspacePath: string) => Promise<void>;
  onToggleGlobal: (pluginId: string, enable: boolean) => Promise<void>;
  onUninstallUser: (pluginId: string) => Promise<void>;
  projectOperatingKey: string | null;
  userOperatingId: string | null;
}

function PluginTypeBadges({ plugin }: { plugin: UserScopePlugin }) {
  const manifest = plugin.manifest;
  if (!manifest) return null;

  const badges: { label: string; variant: "info" | "success" | "warning" | "default" }[] = [];
  if (manifest.skills.length > 0) badges.push({ label: `Skill(${manifest.skills.length})`, variant: "info" });
  if (manifest.agents.length > 0) badges.push({ label: `Agent(${manifest.agents.length})`, variant: "success" });
  if (manifest.mcpServers.length > 0) badges.push({ label: `MCP(${manifest.mcpServers.length})`, variant: "warning" });
  if (manifest.hooks.length > 0) badges.push({ label: `Hook(${manifest.hooks.length})`, variant: "default" });
  if (manifest.lspServers.length > 0) badges.push({ label: `LSP(${manifest.lspServers.length})`, variant: "default" });

  if (badges.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {badges.map((badge) => (
        <Badge key={badge.label} variant={badge.variant}>{badge.label}</Badge>
      ))}
    </div>
  );
}

function PluginActionsMenu({
  plugin,
  roles,
  onInstallToRole,
  onToggleGlobal,
  onUninstallUser,
  projectOperatingKey,
  userOperatingId,
}: {
  plugin: UserScopePlugin;
  roles: RoleRef[];
  onInstallToRole: (pluginId: string, workspacePath: string) => Promise<void>;
  onToggleGlobal: (pluginId: string, enable: boolean) => Promise<void>;
  onUninstallUser: (pluginId: string) => Promise<void>;
  projectOperatingKey: string | null;
  userOperatingId: string | null;
}) {
  const userOperating = userOperatingId === plugin.id;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 w-7 px-0" aria-label={`Manage ${plugin.name}`}>
          {userOperating ? <Loader2 size={ICON_SIZE.xs} className="animate-spin" /> : <MoreHorizontal size={ICON_SIZE.sm} />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        {roles.length > 0 ? (
          <>
            <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.14em] text-[var(--app-text-subtle)]">
              Add to Role
            </DropdownMenuLabel>
            {roles.map((role) => {
              const installedForRole = plugin.usedByRoles.some((usage) => usage.roleId === role.id);
              const roleOperating = projectOperatingKey === `${plugin.id}:${role.workspacePath}`;
              return (
                <DropdownMenuItem
                  key={role.id}
                  disabled={roleOperating || installedForRole}
                  onSelect={() => {
                    void onInstallToRole(plugin.id, role.workspacePath);
                  }}
                >
                  <span className="flex-1">{role.name}</span>
                  {roleOperating ? (
                    <Loader2 size={ICON_SIZE.xs} className="animate-spin" />
                  ) : installedForRole ? (
                    <span className="text-[10px] text-[var(--app-text-subtle)]">installed</span>
                  ) : null}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem
          disabled={userOperating}
          onSelect={() => {
            void onToggleGlobal(plugin.id, !plugin.globalEnabled);
          }}
        >
          {plugin.globalEnabled ? "Disable" : "Enable"}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={userOperating}
          className="text-[var(--app-danger)] focus:text-[var(--app-danger)]"
          onSelect={() => {
            void onUninstallUser(plugin.id);
          }}
        >
          Uninstall
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function UserScopePluginRow({
  plugin,
  roles,
  expandedContent,
  onInstallToRole,
  onToggleGlobal,
  onUninstallUser,
  projectOperatingKey,
  userOperatingId,
}: UserScopePluginRowProps) {
  const [expanded, setExpanded] = useState(false);
  const tooltipLabel = plugin.usedByRoles.map((usage) => `${usage.roleName} (v${usage.version})`).join(", ") || "No Roles";

  return (
    <div className="rounded border border-[var(--app-border)] px-3 py-2">
      <div className="flex items-start gap-3">
        <button
          className="mt-0.5 text-[var(--app-text-subtle)] hover:text-[var(--app-text)]"
          onClick={() => setExpanded((value) => !value)}
          aria-label={expanded ? `Collapse ${plugin.name}` : `Expand ${plugin.name}`}
        >
          {expanded ? <ChevronDown size={ICON_SIZE.xs} /> : <ChevronRight size={ICON_SIZE.xs} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-[var(--app-text)]">{plugin.name}</span>
            <span className="text-xs text-[var(--app-text-muted)]">v{plugin.version}</span>
            {plugin.marketplace ? (
              <Badge variant="muted" className="text-[10px]">{plugin.marketplace}</Badge>
            ) : null}
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="text-xs text-[var(--app-text-muted)] hover:text-[var(--app-text)]" title={tooltipLabel}>
                    {plugin.usedByRoles.length} {plugin.usedByRoles.length === 1 ? "Role" : "Roles"}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{tooltipLabel}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <PluginTypeBadges plugin={plugin} />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge variant={plugin.globalEnabled ? "success" : "destructive"}>
            {plugin.globalEnabled ? "User On" : "User Off"}
          </Badge>
          <PluginActionsMenu
            plugin={plugin}
            roles={roles}
            onInstallToRole={onInstallToRole}
            onToggleGlobal={onToggleGlobal}
            onUninstallUser={onUninstallUser}
            projectOperatingKey={projectOperatingKey}
            userOperatingId={userOperatingId}
          />
        </div>
      </div>
      {expanded ? (
        <div className="mt-4 rounded-xl border border-[var(--app-border)] bg-black/10 p-3">
          {expandedContent}
        </div>
      ) : null}
    </div>
  );
}
