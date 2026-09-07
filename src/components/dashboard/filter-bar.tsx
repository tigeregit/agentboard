"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { IconSearch, IconX } from "@tabler/icons-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TOOL_META } from "@/engine/tool-meta";
import type { ToolId } from "@/engine/types";
import { filtersToParams, RANGE_PRESETS, type DashboardFilters, type RangeId } from "@/lib/query";
import { cn } from "@/lib/utils";
import { ToolDot } from "./tool-badge";

export interface FilterOption {
  id: string;
  label: string;
  count: number;
}

interface Props {
  filters: DashboardFilters;
  tools: { tool: ToolId; count: number }[];
  projects: FilterOption[];
  showSearch?: boolean;
}

const ALL = "__all__";

export function FilterBar({ filters, tools, projects, showSearch = true }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState(filters.search ?? "");
  const [syncedSearch, setSyncedSearch] = useState(filters.search);
  // Re-sync the input when the URL changes from outside (chips, reset, back button).
  if (syncedSearch !== filters.search) {
    setSyncedSearch(filters.search);
    setSearch(filters.search ?? "");
  }

  function apply(patch: Partial<DashboardFilters>) {
    const next = { ...filters, ...patch, page: 1 };
    const qs = filtersToParams(next).toString();
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname));
  }

  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === (filters.search ?? "")) return;
    const t = setTimeout(() => apply({ search: trimmed || undefined }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const activeTool = filters.tools?.length === 1 ? filters.tools[0] : filters.tools?.length ? "multi" : ALL;
  const hasFilters = !!(filters.tools?.length || filters.project || filters.search || filters.range !== "30d");

  return (
    <div className={cn("flex flex-col gap-3 transition-opacity", pending && "opacity-70")}>
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        {showSearch && (
          <div className="relative md:w-80">
            <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search titles, prompts, projects…" className="pl-8" aria-label="Search sessions" />
          </div>
        )}
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <Select value={activeTool} onValueChange={(v) => apply({ tools: v === ALL || v === "multi" ? undefined : [v as ToolId] })}>
            <SelectTrigger className="w-full sm:w-52" aria-label="Filter by tool">
              <SelectValue placeholder="All tools" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All tools</SelectItem>
              {activeTool === "multi" && <SelectItem value="multi">{filters.tools!.length} tools selected</SelectItem>}
              {tools.map((t) => (
                <SelectItem key={t.tool} value={t.tool}>
                  <span className="flex items-center gap-2">
                    <ToolDot tool={t.tool} />
                    {TOOL_META[t.tool]?.name ?? t.tool}
                    <span className="text-muted-foreground">{t.count}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filters.project ?? ALL} onValueChange={(v) => apply({ project: v === ALL ? undefined : v })}>
            <SelectTrigger className="w-full sm:w-60" aria-label="Filter by project">
              <SelectValue placeholder="All projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All projects</SelectItem>
              {filters.project && !projects.some((p) => p.id === filters.project) && <SelectItem value={filters.project}>{filters.project}</SelectItem>}
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <span className="flex items-center gap-2">
                    <span className="truncate">{p.label}</span>
                    <span className="text-muted-foreground">{p.count}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="inline-flex rounded-md border p-0.5" role="radiogroup" aria-label="Time range">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={filters.range === p.id}
              onClick={() => apply({ range: p.id as RangeId, since: undefined, until: undefined })}
              className={cn(
                "rounded-[5px] px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
                filters.range === p.id && "bg-primary text-primary-foreground hover:text-primary-foreground",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        {filters.tools?.map((t) => (
          <Chip key={t} onClear={() => apply({ tools: filters.tools!.filter((x) => x !== t) })}>
            <ToolDot tool={t} /> {TOOL_META[t]?.name ?? t}
          </Chip>
        ))}
        {filters.project && <Chip onClear={() => apply({ project: undefined })}>project: {filters.project}</Chip>}
        {filters.search && <Chip onClear={() => apply({ search: undefined })}>“{filters.search}”</Chip>}
        {hasFilters && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => apply({ tools: undefined, project: undefined, search: undefined, range: "30d" })}>
            Reset
          </Button>
        )}
      </div>
    </div>
  );
}

function Chip({ children, onClear }: { children: React.ReactNode; onClear: () => void }) {
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-md border bg-muted/50 pr-1 pl-2 text-xs">
      {children}
      <button type="button" onClick={onClear} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Remove filter">
        <IconX className="size-3" />
      </button>
    </span>
  );
}
