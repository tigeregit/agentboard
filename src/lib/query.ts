import type { SessionQuery, Surface, ToolId } from "@/engine/types";
import { isToolId } from "@/engine/tool-meta";
import { parseLooseDate } from "@/engine/util/time";

export type SearchParamsLike = URLSearchParams | Record<string, string | string[] | undefined>;

function get(sp: SearchParamsLike, key: string): string | undefined {
  if (sp instanceof URLSearchParams) return sp.get(key) ?? undefined;
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}

export function parseTools(v: string | undefined): ToolId[] | undefined {
  if (!v) return undefined;
  const ids = v.split(",").map((s) => s.trim()).filter(isToolId);
  return ids.length ? ids : undefined;
}

/** Ranges the dashboard filter bar offers; `since` is resolved relative to now. */
export const RANGE_PRESETS = [
  { id: "today", label: "Today", since: "today" },
  { id: "7d", label: "7 days", since: "7d" },
  { id: "30d", label: "30 days", since: "30d" },
  { id: "90d", label: "90 days", since: "90d" },
  { id: "all", label: "All time", since: undefined },
] as const;

export type RangeId = (typeof RANGE_PRESETS)[number]["id"];

export interface DashboardFilters {
  tools?: ToolId[];
  project?: string;
  search?: string;
  range: RangeId;
  since?: string;
  until?: string;
  /** Exactly one local day (YYYY-MM-DD); set by clicking a heatmap cell. Overrides range/since/until. */
  day?: string;
  surface?: Surface;
  page: number;
  pageSize: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** [start, next-day-start) as ISO timestamps for one local day. */
export function dayBounds(day: string): { since: string; until: string } {
  const [y, m, d] = day.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + 1);
  return { since: start.toISOString(), until: end.toISOString() };
}

/**
 * Same query grammar for API routes and server-rendered pages:
 *   ?tool=a,b&project=foo&q=text&range=7d|since=2026-01-01&until=...&page=2
 */
export function parseFilters(sp: SearchParamsLike, defaults: Partial<DashboardFilters> = {}): DashboardFilters {
  const rangeRaw = get(sp, "range");
  const range = (RANGE_PRESETS.some((p) => p.id === rangeRaw) ? rangeRaw : defaults.range ?? "30d") as RangeId;
  const explicitSince = get(sp, "since");
  const preset = RANGE_PRESETS.find((p) => p.id === range);
  const dayRaw = get(sp, "day");
  const day = dayRaw && DAY_RE.test(dayRaw) ? dayRaw : undefined;
  const bounds = day ? dayBounds(day) : undefined;
  const since = bounds?.since ?? parseLooseDate(explicitSince ?? preset?.since);
  const until = bounds?.until ?? parseLooseDate(get(sp, "until"));
  const surface = get(sp, "surface");
  const page = Math.max(1, Number(get(sp, "page") ?? 1) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(get(sp, "limit") ?? defaults.pageSize ?? 50) || 50));
  return {
    tools: parseTools(get(sp, "tool")),
    project: get(sp, "project")?.trim() || undefined,
    search: get(sp, "q")?.trim() || undefined,
    range: explicitSince || day ? "all" : range,
    since,
    until,
    day,
    surface: surface && ["cli", "ide", "desktop", "web"].includes(surface) ? (surface as Surface) : undefined,
    page,
    pageSize,
  };
}

export function toSessionQuery(f: DashboardFilters): SessionQuery {
  return {
    tools: f.tools,
    project: f.project,
    search: f.search,
    since: f.since,
    until: f.until,
    surface: f.surface,
    limit: f.pageSize,
    offset: (f.page - 1) * f.pageSize,
  };
}

/** Serialises filters back into a query string, dropping defaults. */
export function filtersToParams(f: Partial<DashboardFilters> & { page?: number }): URLSearchParams {
  const p = new URLSearchParams();
  if (f.tools?.length) p.set("tool", f.tools.join(","));
  if (f.project) p.set("project", f.project);
  if (f.search) p.set("q", f.search);
  if (f.day) p.set("day", f.day);
  else if (f.range && f.range !== "30d") p.set("range", f.range);
  if (f.surface) p.set("surface", f.surface);
  if (f.page && f.page > 1) p.set("page", String(f.page));
  return p;
}

export function href(pathname: string, f: Partial<DashboardFilters>): string {
  const qs = filtersToParams(f).toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
