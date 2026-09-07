import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function SessionNotFound() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
      <p className="text-lg font-medium">Session not in the index</p>
      <p className="max-w-md text-sm text-muted-foreground">It may have been removed by the tool, or the index is stale. Keys look like <code className="rounded bg-muted px-1">claude-code:&lt;uuid&gt;</code>.</p>
      <Button asChild variant="outline">
        <Link href="/">Back to sessions</Link>
      </Button>
    </div>
  );
}
