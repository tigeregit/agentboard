import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { IconArrowLeft, IconAlertTriangle, IconExternalLink } from "@tabler/icons-react";
import { getEngine } from "@/engine/engine";
import { TOOL_META } from "@/engine/tool-meta";
import type { SessionDetail, SessionSummary } from "@/engine/types";
import { ToolBadge } from "@/components/dashboard/tool-badge";
import { Transcript } from "@/components/dashboard/transcript";
import { CopyButton } from "@/components/dashboard/copy-button";
import { Button } from "@/components/ui/button";
import { duration, fmtDateTime } from "@/lib/format";
import { href } from "@/lib/query";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ key: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { key } = await params;
  const s = getEngine().getSummary(decodeURIComponent(key));
  return { title: s?.title || "Session" };
}

export default async function SessionPage({ params }: Props) {
  const { key } = await params;
  const decoded = decodeURIComponent(key);
  const engine = getEngine();
  await engine.ensureFresh();
  const summary = engine.getSummary(decoded);
  if (!summary) notFound();

  let detail: SessionDetail | null = null;
  let loadError: string | null = null;
  try {
    detail = await engine.getDetail(decoded);
  } catch (err) {
    loadError = (err as Error).message;
  }
  const s: SessionSummary = detail ?? summary;
  const children = engine.children(decoded);
  const parent = summary.parentKey ? engine.getSummary(summary.parentKey) : null;
  const meta = TOOL_META[s.tool];
  const cliCmd = `agentboard show ${s.key}`;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <IconArrowLeft className="size-4" /> All sessions
        </Link>
      </div>

      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ToolBadge tool={s.tool} full />
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase">{s.surface}</span>
          {s.parentKey && parent && (
            <span className="text-xs text-muted-foreground">
              subagent of{" "}
              <Link href={`/sessions/${encodeURIComponent(parent.key)}`} className="underline">
                {parent.title}
              </Link>
            </span>
          )}
        </div>
        <h1 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-2xl">{s.title || s.firstPrompt || "(untitled session)"}</h1>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
          <Field label="Project">
            <Link href={href("/", { project: s.project.path, range: "all" })} className="font-mono hover:underline" title={s.project.path}>
              {s.project.name}
            </Link>
          </Field>
          <Field label="Started">{fmtDateTime(s.startedAt)}</Field>
          <Field label="Duration">{duration(s.startedAt, s.endedAt) || "—"}</Field>
          <Field label="Messages">
            {s.messageCount} <span className="text-muted-foreground">({s.userMessageCount} prompts, {s.toolCallCount} tool calls)</span>
          </Field>
          <Field label="Model">{s.model ? <span className="font-mono">{s.model}</span> : "—"}</Field>
          <Field label="Branch">{s.gitBranch ? <span className="font-mono">{s.gitBranch}</span> : "—"}</Field>
        </dl>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate font-mono" title={s.source.path}>
            {s.source.kind} · {s.source.path}
            {s.source.locator ? ` · ${s.source.locator}` : ""}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton text={s.key} label="Copy key" />
          <CopyButton text={cliCmd} label="Copy CLI command" />
          <Button asChild variant="outline" size="sm">
            <a href={`/api/sessions/${encodeURIComponent(s.key)}`} target="_blank" rel="noreferrer">
              JSON <IconExternalLink className="size-3.5" />
            </a>
          </Button>
        </div>
      </header>

      {children.length > 0 && (
        <section className="rounded-lg border bg-card p-3 text-sm">
          <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Subagent sessions</h2>
          <ul className="flex flex-col gap-1">
            {children.map((c) => (
              <li key={c.key}>
                <Link href={`/sessions/${encodeURIComponent(c.key)}`} className="hover:underline">
                  {c.title}
                </Link>{" "}
                <span className="text-muted-foreground">· {c.messageCount} messages</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(loadError || !detail) && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">Transcript unavailable</p>
            <p>{loadError ?? `The source ${meta?.name ?? s.tool} wrote for this session could not be re-read (moved, compacted, or the tool's store is locked). The indexed summary above is still valid; rescan to refresh it.`}</p>
          </div>
        </div>
      )}

      <section>
        <h2 className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Transcript</h2>
        <Transcript messages={detail?.messages ?? []} />
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate">{children}</dd>
    </div>
  );
}
