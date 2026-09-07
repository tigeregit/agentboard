/** Normalize the many timestamp shapes found in agent logs to ISO-8601. */
export function toIso(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (value instanceof Date) return isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === "number") {
    if (!isFinite(value) || value <= 0) return undefined;
    // seconds vs milliseconds vs microseconds
    let ms = value;
    if (value < 1e11) ms = value * 1000;
    else if (value > 1e14) ms = value / 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (/^\d+(\.\d+)?$/.test(s)) return toIso(Number(s));
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString();
    // 20250612_220546 style
    const m = s.match(/^(\d{4})(\d{2})(\d{2})[_T-]?(\d{2})(\d{2})(\d{2})$/);
    if (m) {
      const d2 = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      return isNaN(d2.getTime()) ? undefined : d2.toISOString();
    }
  }
  return undefined;
}

export function minIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

export function maxIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** YYYY-MM-DD in local time. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Monday-based week start. */
export function startOfLocalWeek(d: Date): Date {
  const s = startOfLocalDay(d);
  const dow = (s.getDay() + 6) % 7;
  return addDays(s, -dow);
}

/**
 * Parse loose CLI date input: ISO strings, YYYY-MM-DD, or relative forms like
 * `7d`, `2w`, `today`, `yesterday`.
 */
export function parseLooseDate(input: string | undefined, now = new Date()): string | undefined {
  if (!input) return undefined;
  const s = input.trim().toLowerCase();
  if (s === "today") return startOfLocalDay(now).toISOString();
  if (s === "yesterday") return addDays(startOfLocalDay(now), -1).toISOString();
  const rel = s.match(/^(\d+)\s*([hdwm])$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms = unit === "h" ? 3600e3 : unit === "d" ? 86400e3 : unit === "w" ? 7 * 86400e3 : 30 * 86400e3;
    return new Date(now.getTime() - n * ms).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d).toISOString();
  }
  return toIso(s);
}

export function formatDuration(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!isFinite(ms) || ms < 0) return "";
  const m = Math.round(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}`;
}
