"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconRefresh } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ScanReport {
  tool: string;
  upserted: number;
  removed: number;
  error?: string;
}

export function ScanButton({ tools, full, label = "Rescan", variant = "outline", size = "sm" }: { tools?: string[]; full?: boolean; label?: string; variant?: "outline" | "default" | "ghost"; size?: "sm" | "default" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [, startTransition] = useTransition();

  async function run() {
    setBusy(true);
    setStatus(null);
    setError(false);
    try {
      const res = await fetch("/api/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tools, full }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { reports: ScanReport[] };
      const added = data.reports.reduce((n, r) => n + r.upserted, 0);
      const failed = data.reports.filter((r) => r.error).length;
      setStatus(failed ? `${added} updated · ${failed} source${failed > 1 ? "s" : ""} failed` : `${added} updated`);
      setError(failed > 0);
      startTransition(() => router.refresh());
    } catch (err) {
      setStatus((err as Error).message);
      setError(true);
    } finally {
      setBusy(false);
      setTimeout(() => setStatus(null), 6000);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {status && <span className={cn("hidden text-xs sm:inline", error ? "text-destructive" : "text-muted-foreground")}>{status}</span>}
      <Button variant={variant} size={size} onClick={run} disabled={busy} aria-busy={busy}>
        <IconRefresh className={cn("size-4", busy && "animate-spin")} />
        {busy ? "Scanning…" : label}
      </Button>
    </div>
  );
}
