import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { ArtifactList } from "@/components/artifacts/ArtifactList.tsx";
import { ArtifactDetail } from "@/components/artifacts/ArtifactDetail.tsx";
import { useArtifactsStore } from "@/store/artifactsSlice.ts";
import { api } from "@/lib/api.ts";
import type { Role } from "@/lib/types.ts";

const MIME_CHIPS = [
  { label: "All", value: "" },
  { label: "Audio", value: "audio/" },
  { label: "Image", value: "image/" },
  { label: "Video", value: "video/" },
  { label: "Document", value: "application/pdf" },
  { label: "Other", value: "__other__" },
] as const;

const SOURCE_KIND_OPTIONS = [
  { label: "All", value: "" },
  { label: "Template step", value: "template_step" },
  { label: "Task published", value: "task_published" },
  { label: "Chat sent", value: "chat_sent" },
] as const;

const DELIVERY_STATUS_OPTIONS = [
  { label: "All", value: "" },
  { label: "Delivered", value: "delivered" },
  { label: "Pending", value: "pending" },
  { label: "Failed", value: "failed" },
  { label: "Expired", value: "expired" },
] as const;

export function Artifacts() {
  const { list, loading, error, selectedId, selectedDetail, filter, load, select, applyFilter } =
    useArtifactsStore();

  const [roles, setRoles] = useState<Role[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    load();
    api<{ roles: Role[] }>("/roles?limit=100")
      .then((r) => setRoles(r.roles))
      .catch(() => {});
  }, []);

  const activeChip = filter.mime_prefix ?? "";

  function handleChip(value: string) {
    if (value === "__other__") {
      // "Other" — we can't easily express NOT in URLSearchParams; clear mime_prefix for now
      // The server filter doesn't support negation; UI shows all and user can further filter
      applyFilter({ mime_prefix: undefined });
    } else {
      applyFilter({ mime_prefix: value || undefined });
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Chip filter bar */}
      <div className="border-b border-[var(--app-border)] px-4 py-2 flex flex-wrap gap-2 items-center">
        {MIME_CHIPS.map((chip) => (
          <button
            key={chip.value}
            type="button"
            onClick={() => handleChip(chip.value)}
            className={`px-3 py-1 rounded-full text-sm font-medium border transition-colors ${
              (chip.value === "" && !activeChip) ||
              (chip.value !== "" && chip.value !== "__other__" && activeChip === chip.value)
                ? "bg-[var(--app-accent)] text-white border-[var(--app-accent)]"
                : "border-[var(--app-border)] hover:bg-[var(--app-hover)]"
            }`}
            data-testid={`chip-${chip.label.toLowerCase()}`}
          >
            {chip.label}
          </button>
        ))}

        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="ml-auto flex items-center gap-1 text-sm text-[var(--app-muted)] hover:text-[var(--app-fg)] transition-colors"
          data-testid="advanced-filters-toggle"
          aria-expanded={advancedOpen}
        >
          Advanced filters
          {advancedOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>

      {/* Advanced filters */}
      {advancedOpen && (
        <div
          className="border-b border-[var(--app-border)] px-4 py-3 flex flex-wrap gap-4 items-end bg-[var(--app-surface)]"
          data-testid="advanced-filters-panel"
        >
          {/* Source kind */}
          <label className="flex flex-col gap-1 text-xs text-[var(--app-muted)]">
            Source kind
            <select
              className="text-sm border border-[var(--app-border)] rounded px-2 py-1 bg-[var(--app-bg)]"
              value={filter.source_kind ?? ""}
              onChange={(e) =>
                applyFilter({
                  source_kind: (e.target.value || undefined) as typeof filter.source_kind,
                })
              }
              data-testid="filter-source-kind"
            >
              {SOURCE_KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          {/* Role */}
          <label className="flex flex-col gap-1 text-xs text-[var(--app-muted)]">
            Role
            <select
              className="text-sm border border-[var(--app-border)] rounded px-2 py-1 bg-[var(--app-bg)]"
              value={filter.role_id ?? ""}
              onChange={(e) => applyFilter({ role_id: e.target.value || undefined })}
              data-testid="filter-role-id"
            >
              <option value="">All</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>

          {/* Date range from */}
          <label className="flex flex-col gap-1 text-xs text-[var(--app-muted)]">
            From
            <input
              type="date"
              className="text-sm border border-[var(--app-border)] rounded px-2 py-1 bg-[var(--app-bg)]"
              value={filter.from ? new Date(filter.from).toISOString().slice(0, 10) : ""}
              onChange={(e) =>
                applyFilter({
                  from: e.target.value
                    ? new Date(e.target.value).getTime()
                    : undefined,
                })
              }
              data-testid="filter-from"
            />
          </label>

          {/* Date range to */}
          <label className="flex flex-col gap-1 text-xs text-[var(--app-muted)]">
            To
            <input
              type="date"
              className="text-sm border border-[var(--app-border)] rounded px-2 py-1 bg-[var(--app-bg)]"
              value={filter.to ? new Date(filter.to).toISOString().slice(0, 10) : ""}
              onChange={(e) =>
                applyFilter({
                  to: e.target.value
                    ? new Date(e.target.value).getTime()
                    : undefined,
                })
              }
              data-testid="filter-to"
            />
          </label>

          {/* Delivery status */}
          <label className="flex flex-col gap-1 text-xs text-[var(--app-muted)]">
            Delivery status
            <select
              className="text-sm border border-[var(--app-border)] rounded px-2 py-1 bg-[var(--app-bg)]"
              value={filter.delivery_status ?? ""}
              onChange={(e) =>
                applyFilter({
                  delivery_status: (e.target.value || undefined) as typeof filter.delivery_status,
                })
              }
              data-testid="filter-delivery-status"
            >
              {DELIVERY_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {/* List + Detail split pane */}
      <div className="flex flex-1 overflow-hidden">
        <div className="w-full md:w-1/2 lg:w-2/5 border-r border-[var(--app-border)] overflow-auto">
          <ArtifactList
            artifacts={list}
            selectedId={selectedId}
            onSelect={select}
            loading={loading}
            error={error}
          />
        </div>
        {selectedId && selectedDetail && (
          <div className="hidden md:flex flex-col flex-1 overflow-auto">
            <ArtifactDetail
              artifact={selectedDetail.artifact}
              onDeleted={() => {
                select(null);
                load();
              }}
              onRedelivered={() => {}}
            />
          </div>
        )}
      </div>
    </div>
  );
}
