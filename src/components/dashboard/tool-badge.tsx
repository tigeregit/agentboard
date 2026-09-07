import type { ToolId } from "@/engine/types";
import { TOOL_META } from "@/engine/tool-meta";
import { cn } from "@/lib/utils";

export function ToolDot({ tool, className }: { tool: ToolId; className?: string }) {
  const meta = TOOL_META[tool];
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", className)} style={{ backgroundColor: meta?.color ?? "#999" }} />;
}

export function ToolBadge({ tool, full = false, className }: { tool: ToolId; full?: boolean; className?: string }) {
  const meta = TOOL_META[tool];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-md border bg-background px-1.5 py-0.5 text-xs font-medium whitespace-nowrap", className)} title={`${meta?.name ?? tool} · ${meta?.vendor ?? ""}`}>
      <ToolDot tool={tool} />
      {full ? meta?.name ?? tool : meta?.short ?? tool}
    </span>
  );
}
