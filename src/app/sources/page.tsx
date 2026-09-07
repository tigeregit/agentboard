import type { Metadata } from "next";
import Link from "next/link";
import { IconCircleCheck, IconCircleDashed, IconCircleX, IconAlertTriangle } from "@tabler/icons-react";
import { getEngine, type SourceStatus } from "@/engine/engine";
import { ScanButton } from "@/components/dashboard/scan-button";
import { ToolBadge } from "@/components/dashboard/tool-badge";
import { Badge } from "@/components/ui/badge";
import { relTime } from "@/lib/format";
import { href } from "@/lib/query";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Sources" };
export const dynamic = "force-dynamic";

const STRATEGY_LABEL: Record<string, string> = {
  api: "Query API",
  "native-index": "Tool's own index",
  sqlite: "SQLite store",
  file: "Log files",
  import: "Official export",
  browser: "Browser session",
};

export default async function SourcesPage() {
  const sources = await getEngine().sources();
  const local = sources.filter((s) => s.surface !== "web");
  const web = sources.filter((s) => s.surface === "web");
  const detected = sources.filter((s) => s.detection.installed).length;
  const viaApi = sources.filter((s) => s.strategies.find((x) => x.status === "implemented")?.kind === "api").length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sources</h1>
          <p className="text-sm text-muted-foreground">
            {detected} of {sources.length} sources detected on this machine · {viaApi} read through a query API, the rest through their local stores.
          </p>
        </div>
        <ScanButton full label="Full rescan" />
      </div>

      <Legend />

      <Section title="Local coding agents" items={local} />
      <Section title="Web chat" items={web} description="Providers with an API or official export are supported today; browser-session access is a reserved extension point (see src/engine/webchat/browser.ts)." />
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1"><IconCircleCheck className="size-3.5 text-emerald-600" /> implemented</span>
      <span className="inline-flex items-center gap-1"><IconCircleDashed className="size-3.5" /> reserved (interface ready, waiting on the vendor)</span>
      <span className="inline-flex items-center gap-1"><IconCircleX className="size-3.5 text-muted-foreground" /> unavailable</span>
    </div>
  );
}

function Section({ title, items, description }: { title: string; items: SourceStatus[]; description?: string }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <ul className="grid gap-3 lg:grid-cols-2">
        {items.map((s) => (
          <SourceCard key={s.id} s={s} />
        ))}
      </ul>
    </section>
  );
}

function SourceCard({ s }: { s: SourceStatus }) {
  const active = s.strategies.find((x) => x.status === "implemented");
  const warnings = s.lastScan?.warnings ?? [];
  return (
    <li className={cn("flex flex-col gap-3 rounded-xl border bg-card p-4", !s.detection.installed && "opacity-75")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ToolBadge tool={s.id} full />
            <span className="text-xs text-muted-foreground">{s.vendor}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase">{s.surface}</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {s.detection.installed ? (
              <span className="text-emerald-700 dark:text-emerald-400">detected</span>
            ) : (
              <span>not found</span>
            )}
            {" · "}
            {s.sessionCount ? (
              <Link href={href("/", { tools: [s.id], range: "all" })} className="hover:underline">
                {s.sessionCount} sessions
              </Link>
            ) : (
              "0 sessions"
            )}
            {s.lastActivity && <> · last activity {relTime(s.lastActivity)}</>}
          </p>
        </div>
        <div className="shrink-0 text-right text-xs text-muted-foreground">
          {active && <Badge variant="secondary">{STRATEGY_LABEL[active.kind] ?? active.kind}</Badge>}
          <div className="mt-1">scanned {relTime(s.lastScan?.finishedAt)}</div>
        </div>
      </div>

      <ol className="flex flex-col gap-1 text-xs">
        {s.strategies.map((st, i) => {
          const Icon = st.status === "implemented" ? IconCircleCheck : st.status === "reserved" ? IconCircleDashed : IconCircleX;
          return (
            <li key={i} className="flex items-start gap-2">
              <Icon className={cn("mt-0.5 size-3.5 shrink-0", st.status === "implemented" ? "text-emerald-600" : "text-muted-foreground")} />
              <span>
                <span className="font-medium">{STRATEGY_LABEL[st.kind] ?? st.kind}</span> <span className="text-muted-foreground">— {st.description}</span>
              </span>
            </li>
          );
        })}
      </ol>

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground select-none">Probed locations & config</summary>
        <ul className="mt-2 flex flex-col gap-1 font-mono">
          {s.detection.locations.map((l, i) => (
            <li key={i} className={cn("truncate", l.exists ? "" : "text-muted-foreground")} title={l.path}>
              {l.exists ? "✓" : "·"} {l.path}
              {l.note && <span className="ml-1 font-sans text-muted-foreground">({l.note})</span>}
            </li>
          ))}
        </ul>
        {s.configHints.length > 0 && (
          <ul className="mt-2 flex flex-col gap-0.5 text-muted-foreground">
            {s.configHints.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        )}
      </details>

      {(s.detection.notes?.length || warnings.length) > 0 && (
        <div className="flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {s.detection.notes?.map((n, i) => (
            <p key={`n${i}`} className="flex gap-1.5">
              <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {n}
            </p>
          ))}
          {warnings.slice(0, 3).map((w, i) => (
            <p key={`w${i}`} className="truncate font-mono" title={w}>
              {w}
            </p>
          ))}
          {warnings.length > 3 && <p>+{warnings.length - 3} more warnings</p>}
        </div>
      )}
    </li>
  );
}
