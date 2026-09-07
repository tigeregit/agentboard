import { IconUser, IconRobot, IconTerminal, IconInfoCircle, IconTool } from "@tabler/icons-react";
import type { Message } from "@/engine/types";
import { fmtTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const ROLE = {
  user: { label: "You", icon: IconUser, cls: "bg-primary text-primary-foreground" },
  assistant: { label: "Assistant", icon: IconRobot, cls: "bg-muted text-foreground" },
  tool: { label: "Tool output", icon: IconTerminal, cls: "bg-muted text-muted-foreground" },
  system: { label: "System", icon: IconInfoCircle, cls: "bg-muted text-muted-foreground" },
} as const;

const TOOL_OUTPUT_LIMIT = 1600;

export function Transcript({ messages }: { messages: Message[] }) {
  if (!messages.length) {
    return <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">Transcript is empty or could not be reconstructed from the source.</div>;
  }
  return (
    <ol className="flex flex-col gap-4">
      {messages.map((m, i) => {
        const role = ROLE[m.role] ?? ROLE.system;
        const Icon = role.icon;
        const isTool = m.role === "tool";
        const long = isTool && m.text.length > TOOL_OUTPUT_LIMIT;
        return (
          <li key={i} className={cn("flex gap-3", m.role === "user" && "flex-row-reverse")}>
            <span className={cn("mt-1 grid size-7 shrink-0 place-items-center rounded-full", role.cls)} title={role.label}>
              <Icon className="size-4" />
            </span>
            <div className={cn("min-w-0 max-w-[85%] flex-1 sm:max-w-[80%]", m.role === "user" && "flex flex-col items-end")}>
              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium">{role.label}</span>
                {m.model && <span className="font-mono">{m.model}</span>}
                {m.timestamp && <time dateTime={m.timestamp}>{fmtTime(m.timestamp)}</time>}
              </div>
              {m.toolCalls?.length ? (
                <ul className="mb-2 flex flex-col gap-1">
                  {m.toolCalls.map((tc, j) => (
                    <li key={j} className="flex items-start gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs">
                      <IconTool className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-mono font-medium">{tc.name}</span>
                      {tc.summary && <span className="truncate font-mono text-muted-foreground">{tc.summary}</span>}
                    </li>
                  ))}
                </ul>
              ) : null}
              {m.text &&
                (isTool ? (
                  <details className="w-full rounded-lg border bg-muted/40 text-xs" open={!long && m.text.length < 400}>
                    <summary className="cursor-pointer px-3 py-2 text-muted-foreground select-none">
                      {long ? `output · ${m.text.length.toLocaleString()} chars` : "output"}
                    </summary>
                    <pre className="max-h-96 overflow-auto px-3 pb-3 font-mono whitespace-pre-wrap">{long ? `${m.text.slice(0, TOOL_OUTPUT_LIMIT)}\n… (${(m.text.length - TOOL_OUTPUT_LIMIT).toLocaleString()} more chars)` : m.text}</pre>
                  </details>
                ) : (
                  <div className={cn("rounded-lg px-3.5 py-2.5 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]", m.role === "user" ? "bg-primary text-primary-foreground" : "border bg-card")}>{m.text}</div>
                ))}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
