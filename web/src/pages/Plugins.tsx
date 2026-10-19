import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  Download,
  Globe,
  Loader2,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { RoleProjectPlugins } from "@/components/plugins/RoleProjectPlugins.tsx";
import { UsageStatsCard } from "@/components/plugins/UsageStatsCard.tsx";
import { UserScopePluginRow } from "@/components/plugins/UserScopePluginRow.tsx";
import { PageHeader } from "@/components/layout/PageHeader.tsx";
import { SectionHeader } from "@/components/layout/SectionHeader.tsx";
import { Badge } from "@/components/ui/Badge.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { Card } from "@/components/ui/Card.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/Table.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs.tsx";
import { api } from "@/lib/api.ts";
import { ICON_SIZE } from "@/lib/ui.ts";
import { usePluginMutations } from "@/hooks/usePluginMutations.ts";
import { usePluginsWithUsage, type UserScopePlugin } from "@/hooks/usePluginsWithUsage.ts";

interface MarketplaceSource {
  name: string;
  source: string;
  repo: string;
  installLocation: string;
}

interface MarketplacePlugin {
  pluginId: string;
  name: string;
  description: string;
  marketplaceName: string;
  source: { source: string; url: string };
  installCount?: number;
}

function PluginSummaryStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-[var(--app-border)] bg-black/10 px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--app-text-subtle)]">{label}</p>
      <p className="mt-1 text-sm font-medium text-[var(--app-text)]">{value}</p>
    </div>
  );
}

function PluginExpandedContent({ plugin }: { plugin: UserScopePlugin }) {
  if (!plugin.manifest) {
    return <p className="text-xs text-[var(--app-text-subtle)]">Loading manifest...</p>;
  }

  return (
    <div className="space-y-4 text-xs">
      {plugin.manifest.description ? (
        <p className="text-[var(--app-text-muted)]">{plugin.manifest.description}</p>
      ) : null}

      <div className="grid gap-2 md:grid-cols-4">
        <PluginSummaryStat label="Version" value={plugin.version ? `v${plugin.version}` : "—"} />
        <PluginSummaryStat label="Scope" value={plugin.scope} />
        <PluginSummaryStat
          label="Capability Count"
          value={
            plugin.manifest.skills.length +
            plugin.manifest.agents.length +
            plugin.manifest.mcpServers.length +
            plugin.manifest.hooks.length +
            plugin.manifest.lspServers.length
          }
        />
        <PluginSummaryStat label="Activation" value={plugin.globalEnabled ? "User On" : "User Off"} />
      </div>

      <div className="rounded-xl border border-[var(--app-border)] bg-black/10 px-3 py-2">
        <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--app-text-subtle)]">Install Path</p>
        <p
          className="mt-1 truncate font-mono text-[11px] text-[var(--app-text-muted)]"
          title={plugin.installPath}
        >
          {plugin.installPath}
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {plugin.manifest.skills.length > 0 ? (
          <div className="rounded-xl border border-[var(--app-border)] bg-black/10 p-3">
            <div className="mb-2 font-semibold text-[var(--app-text)]">Skills</div>
            {plugin.manifest.skills.map((skill) => (
              <div key={skill.name} className="inline-flex items-baseline gap-1 text-[var(--app-text-muted)]">
                <span className="text-[var(--app-text)]">{skill.name}</span>
                {skill.description ? (
                  <span className="text-[var(--app-text-subtle)]">; {skill.description}</span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {plugin.manifest.agents.length > 0 ? (
          <div className="rounded-xl border border-[var(--app-border)] bg-black/10 p-3">
            <div className="mb-2 font-semibold text-[var(--app-text)]">Agents</div>
            {plugin.manifest.agents.map((agent) => (
              <div key={agent.name} className="inline-flex items-baseline gap-1 text-[var(--app-text-muted)]">
                <span className="text-[var(--app-text)]">{agent.name}</span>
                {agent.description ? (
                  <span className="text-[var(--app-text-subtle)]">; {agent.description}</span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {plugin.manifest.mcpServers.length > 0 ? (
          <div className="rounded-xl border border-[var(--app-border)] bg-black/10 p-3">
            <div className="mb-2 font-semibold text-[var(--app-text)]">MCP Servers</div>
            {plugin.manifest.mcpServers.map((server) => (
              <div key={server} className="text-[var(--app-text-muted)]">{server}</div>
            ))}
          </div>
        ) : null}
        {plugin.manifest.hooks.length > 0 ? (
          <div className="rounded-xl border border-[var(--app-border)] bg-black/10 p-3">
            <div className="mb-2 font-semibold text-[var(--app-text)]">Hooks</div>
            {plugin.manifest.hooks.map((hook) => (
              <div key={hook} className="text-[var(--app-text-muted)]">{hook}</div>
            ))}
          </div>
        ) : null}
        {plugin.manifest.lspServers.length > 0 ? (
          <div className="rounded-xl border border-[var(--app-border)] bg-black/10 p-3">
            <div className="mb-2 font-semibold text-[var(--app-text)]">LSP Servers</div>
            {plugin.manifest.lspServers.map((server) => (
              <div key={server} className="text-[var(--app-text-muted)]">{server}</div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Plugins() {
  const { userScope, projectScope, loading, error, refresh, rawPlugins, roles } = usePluginsWithUsage();
  const [activeTab, setActiveTab] = useState<"installed" | "marketplace">("installed");
  const [marketplaceSources, setMarketplaceSources] = useState<MarketplaceSource[]>([]);
  const [marketplacePlugins, setMarketplacePlugins] = useState<MarketplacePlugin[]>([]);
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());
  const [marketplaceLoading, setMarketplaceLoading] = useState(false);
  const [marketplaceError, setMarketplaceError] = useState<string | null>(null);
  const [marketplaceSearch, setMarketplaceSearch] = useState("");
  const [showAddSource, setShowAddSource] = useState(false);
  const [newSourceUrl, setNewSourceUrl] = useState("");
  const [userOperatingId, setUserOperatingId] = useState<string | null>(null);
  const [marketplaceOperatingId, setMarketplaceOperatingId] = useState<string | null>(null);
  const { operatingKey, installToRole, uninstallFromRole, updateRoleVersion } = usePluginMutations(refresh);

  const fetchMarketplace = useCallback(async () => {
    setMarketplaceLoading(true);
    setMarketplaceError(null);
    try {
      const [availableRes, sourcesRes] = await Promise.all([
        api<{ available: MarketplacePlugin[]; installed: { id: string }[] }>("/plugins/marketplace")
          .catch(() => ({ available: [], installed: [] })),
        api<{ sources: MarketplaceSource[] }>("/plugins/marketplaces"),
      ]);
      setMarketplacePlugins(availableRes.available);
      setInstalledIds(new Set(availableRes.installed.map((plugin) => plugin.id)));
      setMarketplaceSources(sourcesRes.sources);
    } catch (err) {
      setMarketplaceError(err instanceof Error ? err.message : "Failed to load marketplace");
    } finally {
      setMarketplaceLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMarketplace();
  }, [fetchMarketplace]);

  const handleEnableDisable = useCallback(async (pluginId: string, enable: boolean) => {
    setUserOperatingId(pluginId);
    try {
      await api(`/plugins/${encodeURIComponent(pluginId)}/${enable ? "enable" : "disable"}`, { method: "POST" });
      toast.success(`${pluginId} ${enable ? "enabled" : "disabled"} globally`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to ${enable ? "enable" : "disable"} plugin`);
    } finally {
      await refresh();
      setUserOperatingId(null);
    }
  }, [refresh]);

  const handleUninstall = useCallback(async (pluginId: string) => {
    setUserOperatingId(pluginId);
    try {
      await api(`/plugins/uninstall/${encodeURIComponent(pluginId)}`, { method: "POST" });
      toast.success("Plugin uninstalled");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Uninstall failed");
    } finally {
      await Promise.all([refresh(), fetchMarketplace()]);
      setUserOperatingId(null);
    }
  }, [fetchMarketplace, refresh]);

  const handleAddSource = useCallback(async () => {
    const url = newSourceUrl.trim();
    if (!url) return;
    try {
      await api("/plugins/marketplaces", {
        method: "POST",
        body: JSON.stringify({ url }),
      });
      toast.success("Marketplace added");
      setNewSourceUrl("");
      setShowAddSource(false);
      await fetchMarketplace();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add marketplace");
    }
  }, [fetchMarketplace, newSourceUrl]);

  const handleInstallFromMarketplace = useCallback(async (
    pluginId: string,
    scope: "user" | "project" = "user",
    cwd?: string,
  ) => {
    setMarketplaceOperatingId(pluginId);
    try {
      await api(`/plugins/install/${encodeURIComponent(pluginId)}`, {
        method: "POST",
        body: JSON.stringify({ scope, cwd }),
      });
      const label = scope === "project" && cwd
        ? `${pluginId.split("@")[0]} for ${cwd.split("/").pop()}`
        : pluginId.split("@")[0];
      toast.success(`Installed ${label}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Install failed");
    } finally {
      await Promise.all([refresh(), fetchMarketplace()]);
      setMarketplaceOperatingId(null);
    }
  }, [fetchMarketplace, refresh]);

  const filteredMarketplace = marketplaceSearch
    ? marketplacePlugins.filter((plugin) =>
        plugin.name.toLowerCase().includes(marketplaceSearch.toLowerCase()) ||
        plugin.description.toLowerCase().includes(marketplaceSearch.toLowerCase()),
      )
    : marketplacePlugins;

  const projectScopeCount = rawPlugins.filter((plugin) => plugin.scope === "project").length;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Capabilities"
        title="Plugins"
        compact
        description="Installed capabilities, scope, and activation."
        metrics={[
          { label: "Total", value: rawPlugins.length },
          { label: "Project Scope", value: projectScopeCount },
          { label: "Catalog", value: marketplacePlugins.length },
        ]}
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void Promise.all([refresh(), fetchMarketplace()])}
          >
            <RefreshCw size={ICON_SIZE.sm} />
          </Button>
        }
      />

      <SectionHeader
        title="Plugin Library"
        compact
        description="Installed plugins and marketplace discovery live in separate tabs."
      />

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as "installed" | "marketplace")}>
        <TabsList>
          <TabsTrigger value="installed">Installed ({userScope.length})</TabsTrigger>
          <TabsTrigger value="marketplace">Marketplace ({marketplacePlugins.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="installed" className="space-y-5">
          {loading ? (
            <Card>
              <div className="py-8 text-center text-sm text-[var(--app-text-subtle)]">Loading...</div>
            </Card>
          ) : error ? (
            <Card>
              <div className="py-8 text-center text-sm text-[var(--app-danger)]">{error}</div>
            </Card>
          ) : (
            <>
              <section className="space-y-3">
                <SectionHeader
                  title="User scope"
                  compact
                  description="Global defaults. Available to all Roles unless overridden."
                />
                {userScope.length === 0 ? (
                  <Card>
                    <EmptyState
                      icon={<Puzzle size={ICON_SIZE.hero} />}
                      title="No user-scope plugins"
                      description="Install a plugin once here to make it available as the default for every Role."
                      className="py-8"
                    />
                  </Card>
                ) : (
                  <div className="space-y-3">
                    {userScope.map((plugin) => (
                      <UserScopePluginRow
                        key={plugin.id}
                        plugin={plugin}
                        roles={roles}
                        expandedContent={<PluginExpandedContent plugin={plugin} />}
                        onInstallToRole={installToRole}
                        onToggleGlobal={handleEnableDisable}
                        onUninstallUser={handleUninstall}
                        projectOperatingKey={operatingKey}
                        userOperatingId={userOperatingId}
                      />
                    ))}
                  </div>
                )}
              </section>

              <section className="space-y-3">
                <SectionHeader
                  title="Project scope"
                  compact
                  description="Role-specific overrides. Only plugins that differ from user scope are shown here."
                />
                <RoleProjectPlugins
                  groups={projectScope}
                  layout="full"
                  onUninstall={uninstallFromRole}
                  onUpdate={updateRoleVersion}
                  operatingKey={operatingKey}
                />
              </section>

              <UsageStatsCard />
            </>
          )}
        </TabsContent>

        <TabsContent value="marketplace" className="space-y-4">
          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <Globe size={ICON_SIZE.sm} className="flex-shrink-0 text-[var(--app-text-muted)]" />
              {marketplaceSources.map((source) => (
                <Badge key={source.name} variant="muted" className="text-xs">{source.name}</Badge>
              ))}
              <span className="ml-auto flex items-center gap-2">
                {marketplaceLoading ? (
                  <Loader2 size={ICON_SIZE.xs} className="animate-spin text-[var(--app-text-subtle)]" />
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => setShowAddSource((value) => !value)}
                >
                  {showAddSource ? <X size={ICON_SIZE.xs} /> : <Plus size={ICON_SIZE.xs} />}
                  Source
                </Button>
              </span>
            </div>
            {showAddSource ? (
              <div className="mt-2 flex gap-2">
                <input
                  className="flex-1 rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
                  value={newSourceUrl}
                  onChange={(event) => setNewSourceUrl(event.target.value)}
                  placeholder="https://github.com/org/marketplace-repo"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleAddSource();
                  }}
                />
                <Button size="sm" onClick={() => void handleAddSource()} disabled={!newSourceUrl.trim()}>
                  Add
                </Button>
              </div>
            ) : null}
          </Card>

          <Card>
            <div className="relative">
              <Search size={ICON_SIZE.sm} className="absolute left-2.5 top-2 text-[var(--app-text-subtle)]" />
              <input
                className="w-full rounded border border-[var(--app-border)] bg-[var(--app-panel)] py-1.5 pl-8 pr-3 text-sm text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)] focus:border-[var(--app-accent)] focus:outline-none"
                value={marketplaceSearch}
                onChange={(event) => setMarketplaceSearch(event.target.value)}
                placeholder="Search available plugins..."
              />
            </div>
          </Card>

          {marketplaceLoading ? (
            <Card>
              <p className="py-8 text-center text-xs text-[var(--app-text-subtle)]">Loading marketplace...</p>
            </Card>
          ) : marketplaceError ? (
            <Card>
              <p className="py-8 text-center text-xs text-[var(--app-danger)]">{marketplaceError}</p>
            </Card>
          ) : filteredMarketplace.length === 0 ? (
            <Card>
              <p className="py-8 text-center text-xs text-[var(--app-text-subtle)]">
                {marketplaceSearch ? "No plugins match your search" : "No marketplace plugins available"}
              </p>
            </Card>
          ) : (
            <Card padding={false}>
              <Table>
                <Thead>
                  <Tr>
                    <Th>Name</Th>
                    <Th>Description</Th>
                    <Th>Source</Th>
                    <Th>Action</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {filteredMarketplace.map((plugin) => {
                    const isInstalled = installedIds.has(plugin.pluginId);
                    const operating = marketplaceOperatingId === plugin.pluginId;
                    return (
                      <Tr key={plugin.pluginId}>
                        <Td className="text-xs font-medium text-[var(--app-text)]">{plugin.name}</Td>
                        <Td
                          className="max-w-[300px] truncate text-xs text-[var(--app-text-muted)]"
                          title={plugin.description}
                        >
                          {plugin.description}
                        </Td>
                        <Td>
                          <Badge variant="muted" className="text-[10px]">{plugin.marketplaceName}</Badge>
                        </Td>
                        <Td>
                          {isInstalled ? (
                            <Badge variant="success" className="text-[10px]">Installed</Badge>
                          ) : (
                            <DropdownMenu modal={false}>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 px-2 text-xs"
                                  disabled={operating}
                                >
                                  {operating ? (
                                    <Loader2 size={ICON_SIZE.xs} className="animate-spin" />
                                  ) : (
                                    <>
                                      <Download size={ICON_SIZE.xs} />
                                      Install
                                      <ChevronDown size={ICON_SIZE.xs} />
                                    </>
                                  )}
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="min-w-[200px]">
                                <DropdownMenuItem
                                  disabled={operating}
                                  onSelect={() => {
                                    void handleInstallFromMarketplace(plugin.pluginId);
                                  }}
                                >
                                  Install globally (User scope)
                                </DropdownMenuItem>
                                {roles.length > 0 ? (
                                  <>
                                    <DropdownMenuSeparator />
                                    {roles.map((role) => (
                                      <DropdownMenuItem
                                        key={role.id}
                                        disabled={operating}
                                        onSelect={() => {
                                          void handleInstallFromMarketplace(plugin.pluginId, "project", role.workspacePath);
                                        }}
                                      >
                                        Install to {role.name}
                                      </DropdownMenuItem>
                                    ))}
                                  </>
                                ) : null}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </Td>
                      </Tr>
                    );
                  })}
                </Tbody>
              </Table>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
